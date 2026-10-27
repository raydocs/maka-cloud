import { randomUUID } from 'node:crypto';
import {
  InstaboxApiError,
  type InstaboxExecRequest,
  type InstaboxExecResult,
  type InstaboxFiles,
  type InstaboxMachine,
  type InstaboxMachineState,
  type InstaboxSnapshot,
  InstaboxTransportError,
  type SandboxApi,
} from '@maka-cloud/instabox';

export const DEFAULT_BOAT_BASE_URL = 'https://boat.dev/api/v1';

/** boat refuses a command timeout above this (`400 invalid_timeout`). */
export const BOAT_MAX_COMMAND_SECONDS = 600;

/**
 * Where a command's environment and stdin wait for it, relative to the sandbox user's home. The
 * directory is mode 700: the agent account shares a group with the sandbox user, and `/home/user`
 * is group-readable.
 */
export const BOAT_EXEC_DIR = '.maka-exec';

export interface BoatClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Test seam. Defaults to a real timer that wakes early when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Test seam for backoff jitter, in [0, 1). */
  random?: () => number;
  /** Attempts after the first one. Defaults to 3. */
  maxRetries?: number;
  /** Test seam for deadlines. */
  now?: () => number;
  /**
   * The auto-stop deadline once the last activity lease of a sandbox is let go, in seconds.
   * Default 600: a sandbox nobody holds stops ten minutes later.
   */
  idleTtlSeconds?: number;
}

/** The sandbox as `GET /sandboxes/{id}` describes it (the fields we read). */
export interface BoatSandbox {
  id: string;
  name?: string | null;
  state: string;
  error?: string | null;
  health?: string;
  ttlSeconds?: number | null;
  archiveAfter?: string | null;
}

/** A saved snapshot as `GET /saved-snapshots/{name}` describes it (the fields we read). */
export interface BoatSavedSnapshot {
  name: string;
  status: string;
  error?: string | null;
  sourceSandboxId?: string | null;
  createdAt?: string | null;
}

interface BoatCommandResult {
  exitCode: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  timedOut: boolean;
  oomKilled?: boolean;
}

interface RequestSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: readonly (readonly [string, string])[];
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  /**
   * Whether a request that got no response may be sent again. True for reads and for calls
   * that are safe to repeat; false for a command, which may have run.
   */
  retryTransport: boolean;
}

const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 5_000;
const API_TIMEOUT_MS = 60_000;
/** boat holds a command up to 60 s while the sandbox starts, before its own timeout begins. */
const COMMAND_RESPONSE_SLACK_MS = 80_000;
const RUNNING_DEADLINE_MS = 5 * 60_000;
const SNAPSHOT_DEADLINE_MS = 15 * 60_000;
/** getFile reads at most this much, as instabox's file endpoint did. */
const FILE_READ_LIMIT = 5 * 1024 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * A boat.dev client with the methods our runners use of a sandbox (`SandboxApi`), so it stands
 * in for `InstaboxClient` (`docs/fork/design/boat-backend.md`). Errors are `InstaboxApiError`
 * with boat's code; `machine_not_running` means what it meant on instabox.
 */
export class BoatClient implements SandboxApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly maxRetries: number;
  private readonly now: () => number;
  private readonly apiKey: string;
  private readonly idleTtlSeconds: number;
  /** Sandboxes whose exec directory this client has made. */
  private readonly execDirs = new Set<string>();
  /** The activity leases this client holds, per sandbox. */
  private readonly leases = new Map<string, Set<string>>();

  constructor(options: BoatClientOptions) {
    if (!options.apiKey) throw new Error('BoatClient requires an API key.');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BOAT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.maxRetries = options.maxRetries ?? 3;
    this.now = options.now ?? Date.now;
    this.idleTtlSeconds = options.idleTtlSeconds ?? 600;
  }

  /**
   * Runs a command. boat's command call has no environment and no stdin, and boat may keep a
   * command's text, so `envs` and `stdin` go to private files first and the command only reads
   * them: no value of either is ever in the command's text. Never replayed after the command
   * may have reached the sandbox.
   */
  async exec(
    machine: string,
    request: InstaboxExecRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<InstaboxExecResult> {
    const timeoutSeconds = request.timeoutSeconds ?? 60;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) {
      throw new Error(`exec timeout must be a whole number of seconds, not ${timeoutSeconds}.`);
    }
    if (timeoutSeconds > BOAT_MAX_COMMAND_SECONDS) {
      throw new Error(
        `boat runs a command for at most ${BOAT_MAX_COMMAND_SECONDS} s; start a longer one detached (asked for ${timeoutSeconds} s).`,
      );
    }
    const envs = Object.entries(request.envs ?? {});
    for (const [name] of envs) {
      if (!ENV_NAME.test(name)) throw new Error(`invalid environment variable name: ${name}`);
    }
    const id = randomUUID();
    const staged = { env: envs.length > 0, stdin: request.stdin !== undefined };
    if (staged.env || staged.stdin) {
      await this.stage(
        machine,
        id,
        staged.env ? envs.map(([k, v]) => `export ${k}=${shq(v)}\n`).join('') : undefined,
        request.stdin,
        options.signal,
      );
    }
    const command = wrapCommand(request.cmd, { id, ...staged, cwd: request.cwd });
    let result: BoatCommandResult;
    try {
      result = await this.send<BoatCommandResult>({
        method: 'POST',
        path: `/sandboxes/${encodeURIComponent(machine)}/commands`,
        body: { command, timeoutSeconds },
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: timeoutSeconds * 1000 + COMMAND_RESPONSE_SLACK_MS,
        retryTransport: false,
      });
    } catch (error) {
      // The command may not have run; its staged files must not stay on the disk (or in a
      // snapshot). Best effort: the sandbox may be unreachable.
      if (staged.env || staged.stdin) await this.unstage(machine, id).catch(() => undefined);
      throw error;
    }
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.exitCode ?? (result.timedOut ? 124 : -1),
      timedOut: result.timedOut === true,
      truncated: result.stdoutTruncated === true || result.stderrTruncated === true,
      ...(result.signal ? { signal: result.signal } : {}),
    };
  }

  /**
   * Reads a file or describes a directory. boat's file endpoint only reaches `/home/user` and
   * `/tmp`, so this runs a command instead and works for any path the sandbox user can read.
   */
  async getFile(
    machine: string,
    path: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<InstaboxFiles> {
    const result = await this.exec(
      machine,
      { cmd: GET_FILE_SCRIPT, envs: { MAKA_PATH: path, MAKA_LIMIT: String(FILE_READ_LIMIT) } },
      options,
    );
    if (result.exitCode === 2) {
      throw new InstaboxApiError(404, {
        code: 'file_not_found',
        message: `${path} does not exist`,
      });
    }
    if (result.exitCode !== 0) {
      throw new InstaboxApiError(400, {
        code: 'file_read_failed',
        message: `${path} could not be read: ${result.stderr.trim().slice(0, 300)}`,
      });
    }
    const newline = result.stdout.indexOf('\n');
    const [kind, size, mode, mtime] = result.stdout.slice(0, newline).split(' ');
    const type = kind === 'f' ? 'file' : kind === 'd' ? 'dir' : 'other';
    const file: InstaboxFiles = {
      path,
      type,
      size: Number(size),
      mode: mode ?? '',
      modTime: new Date(Number(mtime) * 1000).toISOString(),
    };
    if (type !== 'file') return file;
    const bytes = Buffer.from(result.stdout.slice(newline + 1).replace(/\s+/gu, ''), 'base64');
    const binary = bytes.includes(0) || !isUtf8(bytes);
    return {
      ...file,
      content: binary ? bytes.toString('base64') : bytes.toString('utf8'),
      binary,
      truncated: file.size > FILE_READ_LIMIT,
    };
  }

  async getMachine(
    machine: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<InstaboxMachine> {
    const sandbox = await this.getSandbox(machine, options);
    return {
      id: sandbox.id,
      ...(sandbox.name ? { name: sandbox.name } : {}),
      state: machineState(sandbox.state),
    };
  }

  async getSandbox(machine: string, options: { signal?: AbortSignal } = {}): Promise<BoatSandbox> {
    const body = await this.send<{ sandbox?: BoatSandbox } & BoatSandbox>({
      method: 'GET',
      path: `/sandboxes/${encodeURIComponent(machine)}`,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: API_TIMEOUT_MS,
      retryTransport: true,
    });
    return body.sandbox ?? body;
  }

  /**
   * Brings the sandbox to a state that runs commands. A stopped (`archived`) sandbox is resumed
   * from its newest snapshot: its processes are gone, its disk is as it was.
   */
  async ensureRunning(machine: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    const deadline = this.now() + RUNNING_DEADLINE_MS;
    let resumed = false;
    for (;;) {
      const sandbox = await this.getSandbox(machine, options);
      const state = machineState(sandbox.state);
      if (state === 'running') return;
      if ((state === 'suspended' || state === 'error') && !resumed) {
        await this.send<unknown>({
          method: 'POST',
          path: `/sandboxes/${encodeURIComponent(machine)}/resume`,
          body: {},
          idempotencyKey: `maka-resume-${randomUUID()}`,
          ...(options.signal ? { signal: options.signal } : {}),
          timeoutMs: API_TIMEOUT_MS,
          retryTransport: true,
        });
        resumed = true;
      } else if (state === 'deleted' || (state === 'error' && resumed)) {
        throw new Error(
          `boat sandbox ${machine} is ${sandbox.state}${sandbox.error ? ` (${sandbox.error})` : ''} and cannot be started.`,
        );
      }
      if (this.now() >= deadline) {
        throw new Error(`boat sandbox ${machine} did not become ready (it is ${sandbox.state}).`);
      }
      await this.sleep(1_000, options.signal);
    }
  }

  /**
   * Keeps the sandbox from stopping while a task works: boat's lease is the auto-stop deadline,
   * which this moves to `ttlSeconds` from now. Renew before it runs out.
   */
  async putActivityLease(
    machine: string,
    leaseId: string,
    ttlSeconds: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.setTtl(machine, ttlSeconds, options.signal);
    let held = this.leases.get(machine);
    if (!held) this.leases.set(machine, (held = new Set()));
    held.add(leaseId);
  }

  /**
   * Lets a lease go. The sandbox keeps its deadline while this client holds another lease on it;
   * after the last one it stops `idleTtlSeconds` later.
   */
  async deleteActivityLease(
    machine: string,
    leaseId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const held = this.leases.get(machine);
    held?.delete(leaseId);
    if (held && held.size > 0) return;
    this.leases.delete(machine);
    try {
      await this.setTtl(machine, this.idleTtlSeconds, options.signal);
    } catch (error) {
      // A sandbox that is gone has nothing left to keep alive.
      if (error instanceof InstaboxApiError && error.status === 404) return;
      throw error;
    }
  }

  /**
   * Saves the sandbox as a saved snapshot. boat names saved snapshots, so the name is the id.
   * A running sandbox takes a fresh capture first, which can take minutes: poll with
   * `waitForSnapshot`.
   */
  async createSnapshot(
    machine: string,
    request: { name: string; description?: string; rootOnly?: boolean },
    options: { signal?: AbortSignal } = {},
  ): Promise<InstaboxSnapshot> {
    const name = snapshotName(request.name);
    const body = await this.send<{ snapshot?: BoatSavedSnapshot }>({
      method: 'POST',
      path: '/saved-snapshots',
      body: { sandboxId: machine, name },
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: API_TIMEOUT_MS,
      // A repeated save under the same name answers `save_in_progress`, never a second copy.
      retryTransport: true,
    });
    return snapshot(body.snapshot ?? { name, status: 'saving', sourceSandboxId: machine });
  }

  async getSnapshot(id: string, options: { signal?: AbortSignal } = {}): Promise<InstaboxSnapshot> {
    const body = await this.send<{ snapshot?: BoatSavedSnapshot } & BoatSavedSnapshot>({
      method: 'GET',
      path: `/saved-snapshots/${encodeURIComponent(id)}`,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: API_TIMEOUT_MS,
      retryTransport: true,
    });
    return snapshot(body.snapshot ?? body);
  }

  async deleteSnapshot(id: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    try {
      await this.send<unknown>({
        method: 'DELETE',
        path: `/saved-snapshots/${encodeURIComponent(id)}`,
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: API_TIMEOUT_MS,
        retryTransport: true,
      });
    } catch (error) {
      // Deleting is the goal; a snapshot that is already gone is deleted.
      if (error instanceof InstaboxApiError && error.status === 404) return;
      throw error;
    }
  }

  /** Polls until the snapshot is `ready`; throws when it fails or the deadline passes. */
  async waitForSnapshot(
    id: string,
    options: { signal?: AbortSignal; deadlineMs?: number; pollMs?: number } = {},
  ): Promise<InstaboxSnapshot> {
    const deadline = this.now() + (options.deadlineMs ?? SNAPSHOT_DEADLINE_MS);
    for (;;) {
      const current = await this.getSnapshot(id, options.signal ? { signal: options.signal } : {});
      if (current.status === 'ready') return current;
      if (current.status === 'failed') {
        throw new Error(`boat snapshot ${id} failed: ${current.error ?? 'no error detail'}`);
      }
      if (this.now() >= deadline) {
        throw new Error(`boat snapshot ${id} still ${current.status} after the wait deadline.`);
      }
      await this.sleep(options.pollMs ?? 3_000, options.signal);
    }
  }

  private async setTtl(machine: string, ttlSeconds: number, signal?: AbortSignal): Promise<void> {
    await this.send<unknown>({
      method: 'PATCH',
      path: `/sandboxes/${encodeURIComponent(machine)}`,
      body: { ttlSeconds },
      ...(signal ? { signal } : {}),
      timeoutMs: API_TIMEOUT_MS,
      retryTransport: true,
    });
  }

  /** Writes the command's environment and stdin to its two private files. */
  private async stage(
    machine: string,
    id: string,
    env: string | undefined,
    stdin: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const write = async () => {
      await Promise.all([
        env === undefined
          ? undefined
          : this.writeFile(machine, `${BOAT_EXEC_DIR}/${id}.env`, env, signal),
        stdin === undefined
          ? undefined
          : this.writeFile(machine, `${BOAT_EXEC_DIR}/${id}.in`, stdin, signal),
      ]);
    };
    if (!this.execDirs.has(machine)) await this.makeExecDir(machine, signal);
    try {
      await write();
    } catch (error) {
      // The directory may be gone (a sandbox made again under the same id): make it and try once
      // more. Anything else is the caller's.
      if (!(error instanceof InstaboxApiError) || error.status >= 500 || error.status === 401) {
        throw error;
      }
      await this.makeExecDir(machine, signal);
      await write();
    }
  }

  private async makeExecDir(machine: string, signal?: AbortSignal): Promise<void> {
    const result = await this.send<BoatCommandResult>({
      method: 'POST',
      path: `/sandboxes/${encodeURIComponent(machine)}/commands`,
      body: { command: MAKE_EXEC_DIR, timeoutSeconds: 30 },
      ...(signal ? { signal } : {}),
      timeoutMs: 30_000 + COMMAND_RESPONSE_SLACK_MS,
      // Making a directory twice is harmless.
      retryTransport: true,
    });
    if (result.exitCode !== 0) {
      throw new Error(`could not make the private exec directory: ${result.stderr.trim()}`);
    }
    this.execDirs.add(machine);
  }

  private async unstage(machine: string, id: string): Promise<void> {
    await this.send<unknown>({
      method: 'POST',
      path: `/sandboxes/${encodeURIComponent(machine)}/commands`,
      body: {
        command: `rm -f -- "$HOME/${BOAT_EXEC_DIR}/${id}.env" "$HOME/${BOAT_EXEC_DIR}/${id}.in"`,
        timeoutSeconds: 30,
      },
      timeoutMs: 30_000 + COMMAND_RESPONSE_SLACK_MS,
      retryTransport: true,
    });
  }

  private async writeFile(
    machine: string,
    path: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.send<unknown>({
      method: 'PUT',
      path: `/sandboxes/${encodeURIComponent(machine)}/files`,
      body: { path, content: Buffer.from(content, 'utf8').toString('base64'), encoding: 'base64' },
      ...(signal ? { signal } : {}),
      timeoutMs: API_TIMEOUT_MS,
      // Writing the same bytes again gives the same file.
      retryTransport: true,
    });
  }

  private async send<T>(spec: RequestSpec): Promise<T> {
    const url = new URL(this.baseUrl + spec.path);
    for (const [key, value] of spec.query ?? []) url.searchParams.append(key, value);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    };
    if (spec.body !== undefined) headers['Content-Type'] = 'application/json';
    if (spec.idempotencyKey) headers['Idempotency-Key'] = spec.idempotencyKey;
    const body = spec.body === undefined ? undefined : JSON.stringify(spec.body);

    for (let attempt = 0; ; attempt++) {
      spec.signal?.throwIfAborted();
      const signal = spec.signal
        ? AbortSignal.any([spec.signal, AbortSignal.timeout(spec.timeoutMs)])
        : AbortSignal.timeout(spec.timeoutMs);
      let response: Response;
      let text: string;
      try {
        response = await this.fetchImpl(url, {
          method: spec.method,
          headers,
          ...(body === undefined ? {} : { body }),
          signal,
        });
        text = await response.text();
      } catch (error) {
        // A caller abort is the caller's decision, not a transport failure.
        spec.signal?.throwIfAborted();
        const failure = new InstaboxTransportError(
          `boat request ${spec.method} ${spec.path} failed: ${describe(error)}`,
          { cause: error },
        );
        if (!spec.retryTransport || attempt >= this.maxRetries) throw failure;
        await this.sleep(this.backoff(attempt), spec.signal);
        continue;
      }

      const parsed = parseJson(text);
      if (response.ok) return parsed as T;

      const failure = boatError(response.status, parsed, text || response.statusText);
      if (!failure.error.retryable || attempt >= this.maxRetries) throw failure.error;
      await this.sleep(failure.retryAfterMs ?? this.backoff(attempt), spec.signal);
    }
  }

  private backoff(attempt: number): number {
    const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
    return Math.floor(ceiling / 2 + (this.random() * ceiling) / 2);
  }
}

/** Makes the private exec directory, and sets it to mode 700 even when it already exists. */
const MAKE_EXEC_DIR = `mkdir -p "$HOME/${BOAT_EXEC_DIR}" && chmod 700 "$HOME/${BOAT_EXEC_DIR}"`;

/**
 * Prints `<kind> <size> <mode> <mtime>` and, for a file, its first MAKA_LIMIT bytes in base64.
 * Exits 2 when the path does not exist.
 */
const GET_FILE_SCRIPT = `p=$MAKA_PATH
if [ ! -e "$p" ] && [ ! -L "$p" ]; then echo "no such file" >&2; exit 2; fi
if [ -f "$p" ]; then k=f; elif [ -d "$p" ]; then k=d; else k=o; fi
printf '%s %s %s %s\\n' "$k" "$(stat -c %s -- "$p")" "$(stat -c %a -- "$p")" "$(stat -c %Y -- "$p")"
if [ "$k" = f ]; then head -c "$MAKA_LIMIT" -- "$p" | base64 -w 0; fi`;

/**
 * The command boat runs: read the staged environment and stdin, delete both files before
 * anything of the caller's runs, move to `cwd`, then run the caller's script with bash.
 */
export function wrapCommand(
  cmd: string,
  staged: { id: string; env: boolean; stdin: boolean; cwd?: string | undefined },
): string {
  const file = `"$HOME/${BOAT_EXEC_DIR}/${staged.id}`;
  const lines: string[] = [];
  if (staged.env) lines.push(`. ${file}.env" && rm -f -- ${file}.env" || exit 125`);
  lines.push(
    staged.stdin ? `exec 0<${file}.in" && rm -f -- ${file}.in" || exit 125` : 'exec 0</dev/null',
  );
  if (staged.cwd !== undefined) lines.push(`cd -- ${shq(staged.cwd)} || exit 125`);
  lines.push(`exec bash -c ${shq(cmd)}`);
  return lines.join('\n');
}

export function machineState(state: string): InstaboxMachineState {
  switch (state) {
    case 'ready':
    case 'idle':
    case 'running':
      return 'running';
    case 'provisioning':
    case 'provisioned':
    case 'cloning':
      return 'starting';
    case 'archiving':
      return 'suspending';
    case 'archived':
      return 'suspended';
    case 'deleted':
      return 'deleted';
    default:
      return 'error';
  }
}

/** boat's saved snapshot names: lower-case letters, digits and dashes, at most 63. */
function snapshotName(name: string): string {
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 63)
    .replace(/-+$/u, '');
  if (!clean) throw new Error(`snapshot name ${JSON.stringify(name)} has no usable character.`);
  return clean;
}

function snapshot(saved: BoatSavedSnapshot): InstaboxSnapshot {
  const status =
    saved.status === 'ready' ? 'ready' : saved.status === 'failed' ? 'failed' : 'pending';
  return {
    id: saved.name,
    name: saved.name,
    status,
    ...(saved.error ? { error: saved.error } : {}),
    ...(saved.sourceSandboxId ? { sourceMachineId: saved.sourceSandboxId } : {}),
    ...(saved.createdAt ? { createdAt: saved.createdAt } : {}),
  };
}

/** Codes boat documents as safe to send again: the work did not start. */
const RETRYABLE_CODES = new Set([
  'sandbox_starting',
  'rate_limited',
  'no_ready_machine',
  'out_of_capacity',
  'idempotency_in_progress',
]);

function boatError(
  status: number,
  parsed: unknown,
  fallback: string,
): { error: InstaboxApiError; retryAfterMs?: number } {
  const body = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as {
    code?: unknown;
    message?: unknown;
    requestId?: unknown;
    error?: { code?: unknown; message?: unknown; details?: { retryable?: unknown } } | string;
    retryAfterSeconds?: unknown;
  };
  const inner = typeof body.error === 'object' && body.error !== null ? body.error : undefined;
  const code = String(inner?.code ?? body.code ?? 'internal');
  const message = String(inner?.message ?? body.message ?? fallback.slice(0, 500));
  const retryable =
    RETRYABLE_CODES.has(code) ||
    (status === 503 && code !== 'internal') ||
    // A command boat says did not run (`sandbox_restoring`) or a call it marks retryable.
    (code === 'sandbox_direct_failed' &&
      (message === 'sandbox_restoring' || inner?.details?.retryable === true));
  const retryAfter =
    typeof body.retryAfterSeconds === 'number' ? body.retryAfterSeconds : undefined;
  return {
    error: new InstaboxApiError(status, {
      code,
      message,
      retryable,
      ...(typeof body.requestId === 'string' ? { requestId: body.requestId } : {}),
    }),
    ...(retryAfter === undefined ? {} : { retryAfterMs: Math.min(retryAfter, 30) * 1000 }),
  };
}

/** Single-quotes a value for bash. */
export function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
