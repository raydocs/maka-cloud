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
  /** String labels set at create or by `patchMachine`. Absent from older servers. */
  metadata?: Record<string, string>;
  /** The snapshot the sandbox was created from, when it was. */
  snapshot?: { id: string } | null;
  /** Increases with each accepted change. */
  revision?: number;
}

/** Exactly one of `templateId` and `snapshotId`. */
export interface InstaboxCreateMachineRequest {
  /** Unique among the org's live sandboxes, so a create that is repeated finds the first one (409). */
  name?: string;
  templateId?: string;
  snapshotId?: string;
  /** At most 32 labels, keys of 1-64 `[A-Za-z0-9_.-]`, values up to 512 characters. */
  metadata?: Record<string, string>;
  desiredState?: 'running' | 'stopped';
  vcpus?: number;
  memMiB?: number;
}

export interface InstaboxListMachinesOptions {
  /** Only sandboxes whose metadata has every one of these keys with exactly that value. */
  metadata?: Record<string, string>;
  signal?: AbortSignal;
}

export interface InstaboxOperation {
  id: string;
  machineId: string;
  type: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed';
  phase?: string;
  error?: { code: string; message: string } | null;
}

export interface InstaboxSnapshot {
  id: string;
  name: string;
  /** `pending` while a snapshot of a running sandbox uploads. */
  status: 'pending' | 'ready' | 'failed';
  error?: string;
  sourceMachineId?: string;
  createdAt?: string;
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
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  /** Pairs, so a key may repeat (`metadata=a:b&metadata=c:d`). */
  query?: readonly (readonly [string, string])[];
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
      query: [['path', path]],
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

  /** Pauses a running sandbox, keeping its programs. Pair it with `waitForOperation`. */
  async suspendMachine(machine: string, options: { signal?: AbortSignal } = {}) {
    return await this.mutate<InstaboxOperation>(machine, 'suspend', options);
  }

  /**
   * Creates a sandbox. The answer is a `create` operation whose `machineId` is the new sandbox.
   * Pass an `idempotencyKey` you saved before the call (for example one derived from the name and
   * a counter) so a retry after a crash is the same request; without one a fresh key is made for
   * this call and shared by its transport retries. A refused limit is `InstaboxApiError` with
   * code `quota_exceeded` (see `isQuotaExceeded`).
   */
  async createMachine(
    request: InstaboxCreateMachineRequest,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<InstaboxOperation> {
    if ((request.templateId === undefined) === (request.snapshotId === undefined)) {
      throw new Error('createMachine needs exactly one of templateId and snapshotId.');
    }
    return await this.send<InstaboxOperation>({
      method: 'POST',
      path: '/v1/machines',
      body: request,
      idempotencyKey: options.idempotencyKey ?? `maka-create-${randomUUID()}`,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: API_TIMEOUT_MS,
      retryTransport: true,
    });
  }

  /** Deletes a sandbox, its system files and its storage. Pair it with `waitForOperation`. */
  async deleteMachine(
    machine: string,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<InstaboxOperation> {
    return await this.send<InstaboxOperation>({
      method: 'DELETE',
      path: `/v1/machines/${encodeURIComponent(machine)}`,
      idempotencyKey: options.idempotencyKey ?? `maka-delete-${randomUUID()}`,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: API_TIMEOUT_MS,
      retryTransport: true,
    });
  }

  /**
   * Replaces the sandbox's labels (`{}` clears them). Synchronous, and allowed while an operation
   * runs. It replaces, so a caller changing one label sends the whole set it read.
   */
  async patchMachineMetadata(
    machine: string,
    metadata: Record<string, string>,
    options: { signal?: AbortSignal } = {},
  ): Promise<InstaboxMachine> {
    return await this.send<InstaboxMachine>({
      method: 'PATCH',
      path: `/v1/machines/${encodeURIComponent(machine)}`,
      body: { metadata },
      idempotencyKey: `maka-patch-${randomUUID()}`,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: API_TIMEOUT_MS,
      retryTransport: true,
    });
  }

  /** Every sandbox of the account's orgs that carries all the given labels, across pages. */
  async listMachines(options: InstaboxListMachinesOptions = {}): Promise<InstaboxMachine[]> {
    const terms = Object.entries(options.metadata ?? {}).map(([key, value]) => `${key}:${value}`);
    const machines: InstaboxMachine[] = [];
    let cursor: string | undefined;
    do {
      const page: { machines: InstaboxMachine[]; nextCursor: string | null } = await this.send({
        method: 'GET',
        path: '/v1/machines',
        query: [
          ...terms.map((term) => ['metadata', term] as const),
          ...(cursor ? ([['cursor', cursor]] as const) : []),
        ],
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: API_TIMEOUT_MS,
        retryTransport: true,
      });
      machines.push(...page.machines);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return machines;
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
      ...(options.wait ? { query: [['wait', options.wait]] as const } : {}),
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

  /**
   * Snapshots the sandbox's system files and storage. A running sandbox answers `pending`
   * (its files are frozen for well under a second); poll with `waitForSnapshot`.
   */
  async createSnapshot(
    machine: string,
    request: { name: string; description?: string; rootOnly?: boolean },
    options: { signal?: AbortSignal } = {},
  ): Promise<InstaboxSnapshot> {
    return await this.send<InstaboxSnapshot>({
      method: 'POST',
      path: `/v1/machines/${encodeURIComponent(machine)}/snapshots`,
      body: request,
      idempotencyKey: `maka-snapshot-${randomUUID()}`,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: API_TIMEOUT_MS,
      retryTransport: true,
    });
  }

  /** The snapshots of the account's orgs, oldest first. */
  async listSnapshots(options: { signal?: AbortSignal } = {}): Promise<InstaboxSnapshot[]> {
    const body = await this.send<{ snapshots: InstaboxSnapshot[] }>({
      method: 'GET',
      path: '/v1/snapshots',
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: API_TIMEOUT_MS,
      retryTransport: true,
    });
    return body.snapshots;
  }

  async getSnapshot(id: string, options: { signal?: AbortSignal } = {}): Promise<InstaboxSnapshot> {
    return await this.send<InstaboxSnapshot>({
      method: 'GET',
      path: `/v1/snapshots/${encodeURIComponent(id)}`,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: API_TIMEOUT_MS,
      retryTransport: true,
    });
  }

  async deleteSnapshot(id: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.send<unknown>({
      method: 'DELETE',
      path: `/v1/snapshots/${encodeURIComponent(id)}`,
      idempotencyKey: `maka-snapshot-delete-${randomUUID()}`,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: API_TIMEOUT_MS,
      retryTransport: true,
    });
  }

  /** Polls until the snapshot is `ready`; throws when it fails or the deadline passes. */
  async waitForSnapshot(
    id: string,
    options: { signal?: AbortSignal; deadlineMs?: number; pollMs?: number } = {},
  ): Promise<InstaboxSnapshot> {
    const deadline = this.now() + (options.deadlineMs ?? OPERATION_DEADLINE_MS);
    for (;;) {
      const snapshot = await this.getSnapshot(id, options.signal ? { signal: options.signal } : {});
      if (snapshot.status === 'ready') return snapshot;
      if (snapshot.status === 'failed') {
        throw new Error(`instabox snapshot ${id} failed: ${snapshot.error ?? 'no error detail'}`);
      }
      if (this.now() >= deadline) {
        throw new Error(
          `instabox snapshot ${id} still ${snapshot.status} after the wait deadline.`,
        );
      }
      await this.sleep(options.pollMs ?? 2_000, options.signal);
    }
  }

  /** Keeps a sandbox from idle-pausing while a task works. Renew before it expires. */
  async putActivityLease(
    machine: string,
    leaseId: string,
    ttlSeconds: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.send<unknown>({
      method: 'PUT',
      path: `/v1/machines/${encodeURIComponent(machine)}/activity-leases/${encodeURIComponent(leaseId)}`,
      body: { ttlSeconds },
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: API_TIMEOUT_MS,
      retryTransport: true,
    });
  }

  async deleteActivityLease(
    machine: string,
    leaseId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.send<unknown>({
      method: 'DELETE',
      path: `/v1/machines/${encodeURIComponent(machine)}/activity-leases/${encodeURIComponent(leaseId)}`,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: API_TIMEOUT_MS,
      retryTransport: true,
    });
  }

  private async settle(operation: InstaboxOperation, signal?: AbortSignal): Promise<void> {
    await this.waitForOperation(operation.id, signal ? { signal } : {});
  }

  private async mutate<T>(
    machine: string,
    action: 'resume' | 'start' | 'suspend',
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
    for (const [key, value] of spec.query ?? []) url.searchParams.append(key, value);
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
