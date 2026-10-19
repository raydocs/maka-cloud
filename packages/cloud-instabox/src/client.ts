import { randomUUID } from 'node:crypto';
import {
  InstaboxApiError,
  InstaboxOperationError,
  InstaboxTransportError,
  isInstaboxEnvelope,
} from './errors.js';

export const DEFAULT_INSTABOX_BASE_URL = 'https://api.instabox.sh';

export interface InstaboxExecRequest {
  cmd: string;
  cwd?: string;
  envs?: Record<string, string>;
  stdin?: string;
  timeoutSeconds?: number;
}

export interface InstaboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  signal?: string;
}

export interface InstaboxFiles {
  path: string;
  type: 'dir' | 'file' | 'other';
  size: number;
  mode: string;
  modTime: string;
  content?: string;
  binary?: boolean;
  truncated?: boolean;
}

export type InstaboxMachineState =
  | 'creating'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'suspending'
  | 'suspended'
  | 'resuming'
  | 'deleting'
  | 'deleted'
  | 'error';

export interface InstaboxMachine {
  id: string;
  name?: string;
  state: InstaboxMachineState;
  operationId?: string | null;
  autoSuspendedAt?: string;
}

export interface InstaboxOperation {
  id: string;
  machineId: string;
  type: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed';
  phase?: string;
  error?: { code: string; message: string } | null;
}

export interface InstaboxClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Test seam. Defaults to a real timer that wakes early when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Test seam for backoff jitter, in [0, 1). */
  random?: () => number;
  /** Attempts after the first one. Defaults to 3. */
  maxRetries?: number;
  /** Test seam for operation deadlines. */
  now?: () => number;
}

interface RequestSpec {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  /**
   * Whether a request that got no response may be sent again. True for reads and for
   * mutations carrying an Idempotency-Key; false for exec, which has neither a key nor
   * any guarantee the command did not run.
   */
  retryTransport: boolean;
}

const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 5_000;
const OPERATION_WAIT = '25s';
const OPERATION_DEADLINE_MS = 10 * 60_000;
const EXEC_RESPONSE_SLACK_MS = 20_000;
const API_TIMEOUT_MS = 60_000;

export class InstaboxClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly maxRetries: number;
  private readonly now: () => number;
  private readonly apiKey: string;

  constructor(options: InstaboxClientOptions) {
    if (!options.apiKey) throw new Error('InstaboxClient requires an API key.');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_INSTABOX_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.maxRetries = options.maxRetries ?? 3;
    this.now = options.now ?? Date.now;
  }

  /** Runs a command. Never replayed after the request may have reached the sandbox. */
  async exec(
    machine: string,
    request: InstaboxExecRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<InstaboxExecResult> {
    const timeoutSeconds = request.timeoutSeconds ?? 60;
    return await this.send<InstaboxExecResult>({
      method: 'POST',
      path: `/v1/machines/${encodeURIComponent(machine)}/exec`,
      body: request,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: timeoutSeconds * 1000 + EXEC_RESPONSE_SLACK_MS,
      retryTransport: false,
    });
  }

  async getFile(
    machine: string,
    path: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<InstaboxFiles> {
    return await this.send<InstaboxFiles>({
      method: 'GET',
      path: `/v1/machines/${encodeURIComponent(machine)}/files`,
      query: { path },
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: API_TIMEOUT_MS,
      retryTransport: true,
    });
  }

  async getMachine(machine: string, options: { signal?: AbortSignal } = {}) {
    return await this.send<InstaboxMachine>({
      method: 'GET',
      path: `/v1/machines/${encodeURIComponent(machine)}`,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: API_TIMEOUT_MS,
      retryTransport: true,
    });
  }

  /** Mutations are accepted as operations; the key is fixed for the whole logical call. */
  async resumeMachine(machine: string, options: { signal?: AbortSignal } = {}) {
    return await this.mutate<InstaboxOperation>(machine, 'resume', options);
  }

  async startMachine(machine: string, options: { signal?: AbortSignal } = {}) {
    return await this.mutate<InstaboxOperation>(machine, 'start', options);
  }

  /** Waits (server side, up to 45 s) for an idle suspend and its resume to finish. */
  async wakeMachine(machine: string, options: { signal?: AbortSignal } = {}) {
    return await this.send<InstaboxMachine>({
      method: 'POST',
      path: `/v1/machines/${encodeURIComponent(machine)}/wake`,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: 60_000,
      retryTransport: true,
    });
  }

  async getOperation(id: string, options: { wait?: string; signal?: AbortSignal } = {}) {
    return await this.send<InstaboxOperation>({
      method: 'GET',
      path: `/v1/operations/${encodeURIComponent(id)}`,
      ...(options.wait ? { query: { wait: options.wait } } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: API_TIMEOUT_MS + 30_000,
      retryTransport: true,
    });
  }

  /** Long-polls `GET /v1/operations/{id}?wait=25s` until the operation is terminal. */
  async waitForOperation(
    id: string,
    options: { signal?: AbortSignal; deadlineMs?: number } = {},
  ): Promise<InstaboxOperation> {
    const deadline = this.now() + (options.deadlineMs ?? OPERATION_DEADLINE_MS);
    for (;;) {
      const operation = await this.getOperation(id, {
        wait: OPERATION_WAIT,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (operation.state === 'succeeded') return operation;
      if (operation.state === 'failed') {
        throw new InstaboxOperationError(
          id,
          `instabox operation ${id} (${operation.type}) failed: ${
            operation.error?.message ?? 'no error detail'
          }`,
        );
      }
      if (this.now() >= deadline) {
        throw new InstaboxOperationError(
          id,
          `instabox operation ${id} (${operation.type}) still ${operation.state} after the wait deadline.`,
        );
      }
    }
  }

  /**
   * Brings the sandbox to `running`. exec does not resume a paused sandbox on its own
   * (it answers 409 machine_not_running), so the executor calls this and retries once.
   */
  async ensureRunning(machine: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    for (let step = 0; step < 6; step++) {
      const current = await this.getMachine(machine, options);
      switch (current.state) {
        case 'running':
          return;
        case 'suspended':
          if (current.autoSuspendedAt) {
            const awake = await this.wakeMachine(machine, options);
            if (awake.state === 'running') return;
          } else {
            await this.settle(await this.resumeMachine(machine, options), options.signal);
          }
          continue;
        case 'stopped':
          await this.settle(await this.startMachine(machine, options), options.signal);
          continue;
        case 'suspending':
        case 'creating':
        case 'starting':
        case 'resuming':
        case 'stopping':
          break;
        default:
          throw new Error(`instabox sandbox ${machine} is ${current.state} and cannot be started.`);
      }
      if (current.operationId) {
        await this.waitForOperation(current.operationId, options);
      } else {
        await this.sleep(1_000, options.signal);
      }
    }
    throw new Error(`instabox sandbox ${machine} did not reach running.`);
  }

  private async settle(operation: InstaboxOperation, signal?: AbortSignal): Promise<void> {
    await this.waitForOperation(operation.id, signal ? { signal } : {});
  }

  private async mutate<T>(
    machine: string,
    action: 'resume' | 'start',
    options: { signal?: AbortSignal },
  ): Promise<T> {
    return await this.send<T>({
      method: 'POST',
      path: `/v1/machines/${encodeURIComponent(machine)}/${action}`,
      idempotencyKey: `maka-${action}-${randomUUID()}`,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: API_TIMEOUT_MS,
      retryTransport: true,
    });
  }

  private async send<T>(spec: RequestSpec): Promise<T> {
    const url = new URL(this.baseUrl + spec.path);
    for (const [key, value] of Object.entries(spec.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
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
          `instabox request ${spec.method} ${spec.path} failed: ${describe(error)}`,
          { cause: error },
        );
        if (!spec.retryTransport || attempt >= this.maxRetries) throw failure;
        await this.sleep(this.backoff(attempt), spec.signal);
        continue;
      }

      const parsed = parseJson(text);
      if (response.ok) return parsed as T;

      const failure = isInstaboxEnvelope(parsed)
        ? new InstaboxApiError(response.status, parsed.error)
        : new InstaboxApiError(response.status, {
            code: 'internal',
            message: text.slice(0, 500) || response.statusText,
            // A bare 5xx has no server verdict on whether the work started.
            retryable: spec.retryTransport && response.status >= 500,
          });
      if (!failure.retryable || attempt >= this.maxRetries) throw failure;
      await this.sleep(this.backoff(attempt), spec.signal);
    }
  }

  private backoff(attempt: number): number {
    const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
    return Math.floor(ceiling / 2 + (this.random() * ceiling) / 2);
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
