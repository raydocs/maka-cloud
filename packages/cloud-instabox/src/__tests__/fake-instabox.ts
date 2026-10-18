import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { constants as osConstants } from 'node:os';

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
  | { status: number; error: { code: string; message: string; retryable: boolean } }
  | { stdin: string };

export interface FakeInstaboxOptions {
  apiKey?: string;
  machineId?: string;
  /** Replaces PATH for exec'd commands. */
  execPath?: string;
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

  private readonly server: Server;
  private readonly idempotency = new Map<string, { fingerprint: string; operationId: string }>();
  private execCount = 0;
  private operationCount = 0;
  private readonly execPath: string | undefined;
  url = '';

  constructor(options: FakeInstaboxOptions = {}) {
    this.apiKey = options.apiKey ?? 'ibk_test_key';
    this.machineId = options.machineId ?? 'm_aaaaaaaaaaaaaaaaaaaaaaaaaa';
    this.execPath = options.execPath;
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        if (!res.headersSent) this.json(res, 500, this.envelope('internal', String(error), false));
        else res.destroy();
      });
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
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
    const op = /^\/v1\/operations\/(op_\d+)$/.exec(path);
    if (req.method === 'GET' && op) {
      const operation = this.operations.get(op[1] ?? '');
      if (!operation)
        return this.json(res, 404, this.envelope('not_found', 'no such operation', false));
      return this.pollOperation(operation, res);
    }
    this.json(res, 404, this.envelope('not_found', `no route ${req.method} ${path}`, false));
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
    if (action && 'drop' in action) {
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
        env: { PATH: this.execPath ?? process.env.PATH ?? '', HOME: '/tmp', ...body.envs },
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
