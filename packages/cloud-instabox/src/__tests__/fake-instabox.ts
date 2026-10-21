import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises as fs,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { constants as osConstants, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A fake instabox API. `exec` really runs the command with bash on this machine, so the
 * helper scripts the executor sends are exercised end to end; the "sandbox" is the local
 * file system, and tests keep their files under a temp directory.
 */

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: any;
}

export type ExecAction =
  | { drop: true }
  /** Run the command, then drop the connection without answering. */
  | { dropResponse: true }
  | { status: number; error: { code: string; message: string; retryable: boolean } }
  | { stdin: string }
  /** Wait for this before running the command, so a test can act while a call is in flight. */
  | { hold: Promise<void> };

export interface FakeInstaboxOptions {
  /** Where it listens. Default: 127.0.0.1 on a free port; the deploy rehearsal sets both. */
  host?: string;
  port?: number;
  apiKey?: string;
  machineId?: string;
  /** Replaces PATH for exec'd commands (the firewall stand-ins, when on, stay in front of it). */
  execPath?: string;
  /** HOME for exec'd commands. Defaults to /tmp. */
  home?: string;
  /** Extra environment for exec'd commands, before the request's own `envs`. */
  env?: Record<string, string>;
  /**
   * `iptables`, `ip6tables` and `sudo` stand-ins that keep their rules in files instead of
   * touching this machine's firewall. Default `shim`: a test must never change the real one.
   * `none` leaves the real tools (or none) in reach, for a test of a box without a firewall tool.
   */
  firewall?: 'shim' | 'none';
}

/**
 * A stand-in for iptables and ip6tables that keeps the rules in files under SHIM_STATE and
 * understands the few forms the egress guard uses. `SHIM_FAIL` is a pattern: a call whose
 * arguments match it fails. `SHIM_LIE` makes `-S` print nothing, as if the rules had not stuck.
 */
const FIREWALL_SHIM = `#!/bin/bash
tool=$(basename "$0")
echo "$tool $*" >> "$SHIM_STATE/log"
if [ -n "\${SHIM_FAIL:-}" ] && [[ "$*" =~ $SHIM_FAIL ]]; then exit 3; fi
[ "$1" = -w ] && shift
op="$1"; shift
rules() { echo "$SHIM_STATE/$tool.$1"; }
case "$op" in
  -N) [ -e "$(rules "$1")" ] && exit 1; : > "$(rules "$1")" ;;
  -F) : > "$(rules "$1")" ;;
  -A) chain="$1"; shift; echo "-A $chain $*" >> "$(rules "$chain")" ;;
  -I) chain="$1"; shift 2; { echo "-A $chain $*"; cat "$(rules "$chain")" 2>/dev/null; true; } > "$SHIM_STATE/tmp" \\
        && mv "$SHIM_STATE/tmp" "$(rules "$chain")" ;;
  -C) chain="$1"; shift; grep -Fxq -- "-A $chain $*" "$(rules "$chain")" 2>/dev/null ;;
  -S) [ -n "\${SHIM_LIE:-}" ] && exit 0; echo "-P $1 ACCEPT"; cat "$(rules "$1")" 2>/dev/null ;;
  *) exit 2 ;;
esac
`;

/**
 * `sudo -n tool ...` runs the tool as this user. `sudo -u account ...` (the agent's account, which
 * the runners switch to) is a real change of user, so it goes to the real `sudo`, found behind the
 * stand-ins' own directory, which is first on PATH.
 */
const SUDO_SHIM = `#!/bin/bash
for arg in "$@"; do [ "$arg" = -u ] && PATH="\${PATH#*:}" exec sudo "$@"; done
[ "$1" = -n ] && shift
exec "$@"
`;

/** What the firewall stand-ins did, for a test to read. */
export interface FakeFirewall {
  /** The rules of a chain, one `-A chain ...` line each. */
  rules(tool: 'iptables' | 'ip6tables', chain: string): string[];
  /** Every call, as `tool args`. */
  calls(): string[];
  /** Forgets every rule, as a box restored from a snapshot or resumed after a restart may have. */
  reset(): void;
}

export interface FakeSnapshot {
  id: string;
  name: string;
  status: 'pending' | 'ready' | 'failed';
  error?: string;
  /** Polls it stays `pending` before reaching `finalStatus`. */
  polls: number;
  finalStatus: 'ready' | 'failed';
}

interface Operation {
  id: string;
  machineId: string;
  type: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed';
  phase: string;
  error: {
    code: string;
    message: string;
    requestId: string;
    retryable: boolean;
    operationId: null;
  } | null;
  polls: number;
  finalState: 'succeeded' | 'failed';
}

// Absolute, because Node resolves the program through the child's PATH, which tests replace.
const BASH = existsSync('/usr/bin/bash') ? '/usr/bin/bash' : '/bin/bash';
const MAX_OUTPUT = 1024 * 1024;
const FILES_API_MAX = 256 * 1024;

export class FakeInstabox {
  readonly apiKey: string;
  readonly machineId: string;
  readonly requests: RecordedRequest[] = [];
  readonly operations = new Map<string, Operation>();
  readonly spawnedPids: number[] = [];
  machineState = 'running';
  autoSuspendedAt: string | undefined;
  /** Polls an operation stays `running` before reaching its final state. */
  operationPolls = 1;
  failNextOperation = false;
  /** Decide per exec (0-based index) whether to inject a fault. */
  onExec: ((request: RecordedRequest, index: number) => ExecAction | undefined) | undefined;
  /** Process a mutation fully, then drop the connection, once. */
  dropMutationResponseOnce = false;
  /** Answer the next mutation with this error before doing any work. */
  failNextMutation: { status: number; code: string; retryable: boolean } | undefined;
  readonly snapshots = new Map<string, FakeSnapshot>();
  readonly leases = new Map<string, number>();
  /** Polls a new snapshot stays `pending`. */
  snapshotPolls = 1;
  /** Answer the next snapshot create with this error. */
  failNextSnapshotCreate: { status: number; code: string; retryable: boolean } | undefined;
  /** The next snapshot ends `failed`. */
  failNextSnapshot = false;

  private readonly server: Server;
  private readonly idempotency = new Map<string, { fingerprint: string; operationId: string }>();
  private execCount = 0;
  private operationCount = 0;
  private readonly execPath: string | undefined;
  private readonly home: string;
  private readonly baseEnv: Record<string, string>;
  private readonly listenOn: { host: string; port: number };
  private readonly firewallDir: string | undefined;
  readonly firewall: FakeFirewall;
  private snapshotCount = 0;
  private readonly snapshotKeys = new Map<string, string>();
  url = '';

  constructor(options: FakeInstaboxOptions = {}) {
    this.apiKey = options.apiKey ?? 'ibk_test_key';
    this.machineId = options.machineId ?? 'm_aaaaaaaaaaaaaaaaaaaaaaaaaa';
    this.execPath = options.execPath;
    this.home = options.home ?? '/tmp';
    this.baseEnv = options.env ?? {};
    this.listenOn = { host: options.host ?? '127.0.0.1', port: options.port ?? 0 };
    if ((options.firewall ?? 'shim') === 'shim') {
      this.firewallDir = mkdtempSync(join(tmpdir(), 'fake-instabox-fw-'));
      const bin = join(this.firewallDir, 'bin');
      mkdirSync(bin);
      mkdirSync(join(this.firewallDir, 'state'));
      for (const tool of ['iptables', 'ip6tables']) {
        writeFileSync(join(bin, tool), FIREWALL_SHIM, { mode: 0o755 });
      }
      writeFileSync(join(bin, 'sudo'), SUDO_SHIM, { mode: 0o755 });
    }
    const state = this.firewallDir ? join(this.firewallDir, 'state') : undefined;
    const read = (name: string): string =>
      state && existsSync(join(state, name)) ? readFileSync(join(state, name), 'utf8') : '';
    this.firewall = {
      rules: (tool, chain) => read(`${tool}.${chain}`).split('\n').filter(Boolean),
      calls: () => read('log').split('\n').filter(Boolean),
      reset: () => {
        if (!state) return;
        for (const name of readdirSync(state)) if (name !== 'log') rmSync(join(state, name));
      },
    };
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        if (!res.headersSent) this.json(res, 500, this.envelope('internal', String(error), false));
        else res.destroy();
      });
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) =>
      this.server.listen(this.listenOn.port, this.listenOn.host, resolve),
    );
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (this.firewallDir) rmSync(this.firewallDir, { recursive: true, force: true });
  }

  requestsTo(method: string, pathPattern: RegExp): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && pathPattern.test(r.path));
  }

  get execRequests(): RecordedRequest[] {
    return this.requestsTo('POST', /\/exec$/);
  }

  private envelope(code: string, message: string, retryable: boolean) {
    return {
      error: { code, message, requestId: 'req_fake', retryable, operationId: null },
    };
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const recorded: RecordedRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body: raw ? JSON.parse(raw) : undefined,
    };
    this.requests.push(recorded);

    if (req.headers['x-api-key'] !== this.apiKey) {
      return this.json(res, 401, this.envelope('unauthenticated', 'invalid API key', false));
    }
    const machine = new RegExp(`^/v1/machines/${this.machineId}`);
    const path = url.pathname;
    if (req.method === 'GET' && path === `/v1/machines/${this.machineId}`) {
      return this.json(res, 200, this.machineBody());
    }
    if (req.method === 'POST' && machine.test(path) && path.endsWith('/exec')) {
      return await this.exec(recorded, res);
    }
    if (req.method === 'GET' && path.endsWith('/files') && machine.test(path)) {
      return await this.files(url.searchParams.get('path') ?? '/', res);
    }
    if (req.method === 'POST' && machine.test(path) && /\/(resume|start)$/.test(path)) {
      return this.mutation(recorded, req, res, path.endsWith('/resume') ? 'resume' : 'start');
    }
    if (req.method === 'POST' && machine.test(path) && path.endsWith('/wake')) {
      this.machineState = 'running';
      this.autoSuspendedAt = undefined;
      return this.json(res, 200, this.machineBody());
    }
    if (req.method === 'POST' && machine.test(path) && path.endsWith('/snapshots')) {
      return this.createSnapshot(recorded, req, res);
    }
    const snapshot = /^\/v1\/snapshots\/(sn_\d+)$/.exec(path);
    if (snapshot) return this.snapshotRoute(req, snapshot[1] ?? '', res);
    const lease = /\/activity-leases\/([^/]+)$/.exec(path);
    if (lease && machine.test(path)) {
      const id = decodeURIComponent(lease[1] ?? '');
      if (req.method === 'PUT') {
        this.leases.set(id, recorded.body?.ttlSeconds ?? 300);
        return this.json(res, 200, {
          id,
          machineId: this.machineId,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        });
      }
      if (req.method === 'DELETE') {
        this.leases.delete(id);
        res.writeHead(204);
        return void res.end();
      }
    }
    const op = /^\/v1\/operations\/(op_\d+)$/.exec(path);
    if (req.method === 'GET' && op) {
      const operation = this.operations.get(op[1] ?? '');
      if (!operation)
        return this.json(res, 404, this.envelope('not_found', 'no such operation', false));
      return this.pollOperation(operation, res);
    }
    this.json(res, 404, this.envelope('not_found', `no route ${req.method} ${path}`, false));
  }

  private createSnapshot(recorded: RecordedRequest, req: IncomingMessage, res: ServerResponse) {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0) {
      return this.json(res, 400, this.envelope('bad_request', 'Idempotency-Key required', false));
    }
    if (this.failNextSnapshotCreate) {
      const { status, code, retryable } = this.failNextSnapshotCreate;
      this.failNextSnapshotCreate = undefined;
      return this.json(res, status, this.envelope(code, 'injected failure', retryable));
    }
    const seen = this.snapshotKeys.get(key);
    let snapshot = seen ? this.snapshots.get(seen) : undefined;
    if (!snapshot) {
      const name = String(recorded.body?.name ?? '');
      if ([...this.snapshots.values()].some((existing) => existing.name === name)) {
        return this.json(res, 409, this.envelope('conflict', 'snapshot name in use', false));
      }
      snapshot = {
        id: `sn_${++this.snapshotCount}`,
        name,
        status: 'pending',
        polls: 0,
        finalStatus: this.failNextSnapshot ? 'failed' : 'ready',
      };
      this.failNextSnapshot = false;
      this.snapshots.set(snapshot.id, snapshot);
      this.snapshotKeys.set(key, snapshot.id);
    }
    this.json(res, 202, this.snapshotBody(snapshot));
  }

  private snapshotRoute(req: IncomingMessage, id: string, res: ServerResponse) {
    const snapshot = this.snapshots.get(id);
    if (!snapshot)
      return this.json(res, 404, this.envelope('not_found', 'no such snapshot', false));
    if (req.method === 'DELETE') {
      this.snapshots.delete(id);
      res.writeHead(204);
      return void res.end();
    }
    if (snapshot.status === 'pending') {
      snapshot.polls++;
      if (snapshot.polls >= this.snapshotPolls) {
        snapshot.status = snapshot.finalStatus;
        if (snapshot.status === 'failed') snapshot.error = 'upload failed';
      }
    }
    this.json(res, 200, this.snapshotBody(snapshot));
  }

  private snapshotBody(snapshot: FakeSnapshot) {
    const { polls: _polls, finalStatus: _final, ...body } = snapshot;
    return body;
  }

  private machineBody() {
    return {
      id: this.machineId,
      name: 'fake',
      state: this.machineState,
      operationId: null,
      ...(this.autoSuspendedAt ? { autoSuspendedAt: this.autoSuspendedAt } : {}),
    };
  }

  private mutation(
    recorded: RecordedRequest,
    req: IncomingMessage,
    res: ServerResponse,
    type: 'resume' | 'start',
  ): void {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0) {
      return this.json(res, 400, this.envelope('bad_request', 'Idempotency-Key required', false));
    }
    if (this.failNextMutation) {
      const { status, code, retryable } = this.failNextMutation;
      this.failNextMutation = undefined;
      return this.json(res, status, this.envelope(code, 'injected failure', retryable));
    }
    const fingerprint = `${recorded.method} ${recorded.path} ${JSON.stringify(recorded.body ?? null)}`;
    const seen = this.idempotency.get(key);
    let operation: Operation;
    if (seen) {
      if (seen.fingerprint !== fingerprint) {
        return this.json(
          res,
          409,
          this.envelope('idempotency_conflict', 'key reused for a different request', false),
        );
      }
      operation = this.operations.get(seen.operationId) as Operation;
    } else {
      operation = {
        id: `op_${++this.operationCount}`,
        machineId: this.machineId,
        type,
        state: 'queued',
        phase: 'scheduling',
        error: null,
        polls: 0,
        finalState: this.failNextOperation ? 'failed' : 'succeeded',
      };
      this.failNextOperation = false;
      this.operations.set(operation.id, operation);
      this.idempotency.set(key, { fingerprint, operationId: operation.id });
    }
    if (this.dropMutationResponseOnce) {
      this.dropMutationResponseOnce = false;
      req.socket.destroy();
      return;
    }
    this.json(res, 202, this.operationBody(operation));
  }

  private operationBody(operation: Operation) {
    const { polls: _polls, finalState: _final, ...body } = operation;
    return body;
  }

  private pollOperation(operation: Operation, res: ServerResponse): void {
    if (operation.state !== 'succeeded' && operation.state !== 'failed') {
      operation.polls++;
      if (operation.polls >= this.operationPolls) {
        operation.state = operation.finalState;
        operation.phase = 'done';
        if (operation.finalState === 'failed') {
          operation.error = {
            code: 'internal',
            message: 'host rejected the resume',
            requestId: 'req_fake',
            retryable: false,
            operationId: null,
          };
        } else {
          this.machineState = 'running';
        }
      } else {
        operation.state = 'running';
        operation.phase = 'booting';
      }
    }
    this.json(res, 200, this.operationBody(operation));
  }

  private async files(path: string, res: ServerResponse): Promise<void> {
    if (this.machineState !== 'running') {
      return this.json(res, 409, this.envelope('machine_not_running', 'not running', true));
    }
    let stat;
    try {
      stat = await fs.stat(path);
    } catch {
      return this.json(res, 404, this.envelope('not_found', 'no such path', false));
    }
    const base = { path, size: stat.size, mode: '-rw-r--r--', modTime: stat.mtime.toISOString() };
    if (stat.isDirectory())
      return this.json(res, 200, { ...base, type: 'dir', size: 0, entries: [] });
    const bytes = await fs.readFile(path);
    const window = bytes.subarray(0, FILES_API_MAX);
    let content = '';
    let binary = false;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(window);
    } catch {
      binary = true;
    }
    this.json(res, 200, {
      ...base,
      type: 'file',
      ...(binary ? { binary: true, content: '' } : { content }),
      ...(bytes.length > FILES_API_MAX ? { truncated: true } : {}),
    });
  }

  private async exec(recorded: RecordedRequest, res: ServerResponse): Promise<void> {
    const index = this.execCount++;
    if (this.machineState !== 'running') {
      return this.json(res, 409, this.envelope('machine_not_running', 'sandbox is paused', false));
    }
    const action = this.onExec?.(recorded, index);
    if (action && 'hold' in action) await action.hold;
    if (action && 'drop' in action) {
      res.socket?.destroy();
      return;
    }
    if (action && 'dropResponse' in action) {
      const body = recorded.body as {
        cmd: string;
        cwd?: string;
        envs?: Record<string, string>;
        stdin?: string;
      };
      await this.runCommand(body, body.stdin ?? '');
      res.socket?.destroy();
      return;
    }
    if (action && 'status' in action)
      return this.json(res, action.status, {
        error: { ...action.error, requestId: 'req_fake', operationId: null },
      });
    const body = recorded.body as {
      cmd: string;
      cwd?: string;
      envs?: Record<string, string>;
      stdin?: string;
      timeoutSeconds?: number;
    };
    const stdin = action && 'stdin' in action ? action.stdin : (body.stdin ?? '');
    this.json(res, 200, await this.runCommand(body, stdin));
  }

  private runCommand(
    body: { cmd: string; cwd?: string; envs?: Record<string, string>; timeoutSeconds?: number },
    stdin: string,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    truncated: boolean;
  }> {
    return new Promise((resolve) => {
      const child = spawn(BASH, ['-c', body.cmd], {
        cwd: body.cwd ?? '/',
        env: {
          PATH: [
            this.firewallDir && join(this.firewallDir, 'bin'),
            this.execPath ?? process.env.PATH,
          ]
            .filter(Boolean)
            .join(':'),
          ...(this.firewallDir ? { SHIM_STATE: join(this.firewallDir, 'state') } : {}),
          HOME: this.home,
          ...this.baseEnv,
          ...body.envs,
        },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (child.pid) this.spawnedPids.push(child.pid);
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let truncated = false;
      let timedOut = false;
      const collect = (current: Buffer, chunk: Buffer): Buffer => {
        const room = MAX_OUTPUT - current.length;
        if (chunk.length > room) truncated = true;
        return room > 0 ? Buffer.concat([current, chunk.subarray(0, room)]) : current;
      };
      child.stdout.on('data', (chunk: Buffer) => (stdout = collect(stdout, chunk)));
      child.stderr.on('data', (chunk: Buffer) => (stderr = collect(stderr, chunk)));
      const timer = setTimeout(
        () => {
          timedOut = true;
          try {
            if (child.pid) process.kill(-child.pid, 'SIGKILL');
          } catch {}
        },
        (body.timeoutSeconds ?? 60) * 1000,
      );
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
      child.once('error', (error) => {
        clearTimeout(timer);
        resolve({
          stdout: '',
          stderr: String(error),
          exitCode: 1,
          timedOut: false,
          truncated: false,
        });
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        const signalNumber = signal
          ? (osConstants.signals as Record<string, number>)[signal]
          : undefined;
        resolve({
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
          exitCode: timedOut ? 124 : (code ?? (signalNumber ? 128 + signalNumber : 255)),
          timedOut,
          truncated,
        });
      });
    });
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
