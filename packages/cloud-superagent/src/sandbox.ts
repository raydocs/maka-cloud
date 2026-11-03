/**
 * SandboxPort matches the SandboxApi seam of open PR #452
 * (`Pick<InstaboxClient, ensureRunning | exec | getMachine | snapshots | leases>`).
 * When that PR merges, InstaboxClient satisfies this structurally. boat.dev is parked.
 * HttpSandbox speaks the Instabox HTTP API so Super-agent stays zod-only.
 */

import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const DEFAULT_INSTABOX_BASE_URL = 'https://api.instabox.sh';

export interface SandboxExecRequest {
  cmd: string;
  cwd?: string;
  /** Extra env for this exec. Secrets stay host-side; do not put keys here. */
  env?: Record<string, string>;
  /** Raw bytes for `base64 -d` uploads. Never put secrets here. */
  stdin?: string;
  timeoutSeconds?: number;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxMachine {
  id: string;
  state: string;
  operationId?: string | null;
  /** Stored when created. Not used as the idle path. */
  deleteAfterSeconds?: number;
}

export interface SandboxCreateMachineRequest {
  name?: string;
  templateId?: string;
  snapshotId?: string;
  metadata?: Record<string, string>;
  vcpus?: number;
  memMiB?: number;
  deleteAfterSeconds?: number;
}

export interface SandboxPort {
  ensureRunning(machineId: string): Promise<void>;
  exec(machineId: string, request: SandboxExecRequest): Promise<SandboxExecResult>;
  getMachine(machineId: string): Promise<SandboxMachine>;
  createSnapshot?(machineId: string, name: string): Promise<{ id: string }>;
  deleteSnapshot?(snapshotId: string): Promise<void>;
  waitForSnapshot?(snapshotId: string): Promise<void>;
  putActivityLease?(machineId: string, holder: string): Promise<void>;
  deleteActivityLease?(machineId: string, holder: string): Promise<void>;
  /** Sleep writes durable state first, then may ask the box to suspend. */
  suspend?(machineId: string): Promise<void>;
  createMachine?(request: SandboxCreateMachineRequest): Promise<{ id: string }>;
  deleteMachine?(machineId: string): Promise<unknown>;
}

export class InstaboxCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstaboxCredentialsError';
  }
}

/** HTTP error with the Instabox envelope fields when the body has them. */
export class InstaboxHttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryable: boolean | undefined;
  readonly operationId: string | null | undefined;

  constructor(
    message: string,
    extras: {
      status: number;
      code?: string;
      retryable?: boolean;
      operationId?: string | null;
    },
  ) {
    super(message);
    this.name = 'InstaboxHttpError';
    this.status = extras.status;
    this.code = extras.code;
    this.retryable = extras.retryable;
    this.operationId = extras.operationId;
  }
}

export function isOperationConflict(error: unknown): error is InstaboxHttpError {
  return (
    error instanceof InstaboxHttpError &&
    error.status === 409 &&
    error.code === 'operation_conflict'
  );
}

export interface InstaboxCredentials {
  apiKey: string;
  machineId: string;
  baseUrl: string;
}

export interface InstaboxApiConfig {
  apiKey: string;
  baseUrl: string;
}

export interface InstaboxOperation {
  id: string;
  machineId?: string;
  type?: string;
  state: string;
}

/**
 * Smallest Instabox Pro size. Other sizes (including 1/512) return HTTP 400
 * `spec_not_allowed`. Allowed: 2/4096, 4/8192, 8/16384.
 */
export const SMALLEST_SANDBOX = { vcpus: 2, memMiB: 4096 } as const;

/** Usable default. `base` / `dev` are retired; `GET /v1/templates` lists this. */
export const DEFAULT_LIVE_SMOKE_TEMPLATE = 'universal';

/** Same long-poll as `@maka-cloud/instabox` `InstaboxClient.waitForOperation`. */
export const OPERATION_WAIT = '25s';

/** Create on Pro is ~4–5s; 24 back-to-back polls finished in ~2.5s. Five minutes is enough. */
export const OPERATION_DEADLINE_MS = 5 * 60_000;

/** Replace a secret in any string we print. Never log the raw key. */
export function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join('<redacted>');
}

export class FakeSandbox implements SandboxPort {
  readonly commands: Array<{ machineId: string; cmd: string; cwd?: string }> = [];
  readonly machines = new Map<string, SandboxMachine>();
  readonly snapshots = new Map<string, { id: string; machineId: string; name: string }>();
  readonly snapshotRoots = new Map<string, string>();
  readonly leases = new Map<string, string>();
  readonly roots = new Map<string, string>();
  private readonly rootJobs = new Map<string, Promise<string>>();
  private snapshotSeq = 0;
  private createSeq = 0;

  async ensureRunning(machineId: string): Promise<void> {
    const current = this.machines.get(machineId) ?? { id: machineId, state: 'stopped' };
    current.state = 'running';
    this.machines.set(machineId, current);
    await this.ensureRoot(machineId);
  }

  /** Per-machine host directory that stands in for the box filesystem. */
  async ensureRoot(machineId: string): Promise<string> {
    const existing = this.roots.get(machineId);
    if (existing) return existing;
    let job = this.rootJobs.get(machineId);
    if (!job) {
      job = mkdtemp(join(tmpdir(), `maka-box-${machineId}-`)).then((dir) => {
        this.roots.set(machineId, dir);
        return dir;
      });
      this.rootJobs.set(machineId, job);
    }
    return job;
  }

  async exec(machineId: string, request: SandboxExecRequest): Promise<SandboxExecResult> {
    await this.ensureRunning(machineId);
    this.commands.push({ machineId, cmd: request.cmd, cwd: request.cwd });
    const root = await this.ensureRoot(machineId);
    const cwd = request.cwd
      ? isAbsolute(request.cwd)
        ? request.cwd
        : join(root, request.cwd)
      : root;
    await mkdir(cwd, { recursive: true });
    return await runLocal(request.cmd, cwd, request.stdin, request.timeoutSeconds, request.env);
  }

  async getMachine(machineId: string): Promise<SandboxMachine> {
    return this.machines.get(machineId) ?? { id: machineId, state: 'unknown' };
  }

  async createSnapshot(machineId: string, name: string): Promise<{ id: string }> {
    this.snapshotSeq += 1;
    const id = `snap_${this.snapshotSeq}`;
    const root = await this.ensureRoot(machineId);
    const snapDir = await mkdtemp(join(tmpdir(), `maka-snap-${id}-`));
    await cp(root, snapDir, { recursive: true });
    this.snapshots.set(id, { id, machineId, name });
    this.snapshotRoots.set(id, snapDir);
    return { id };
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    this.snapshots.delete(snapshotId);
  }

  async waitForSnapshot(snapshotId: string): Promise<void> {
    if (!this.snapshots.has(snapshotId)) throw new Error(`unknown snapshot ${snapshotId}`);
  }

  async putActivityLease(machineId: string, holder: string): Promise<void> {
    this.leases.set(`${machineId}:${holder}`, holder);
  }

  async deleteActivityLease(machineId: string, holder: string): Promise<void> {
    this.leases.delete(`${machineId}:${holder}`);
  }

  async suspend(machineId: string): Promise<void> {
    const current = this.machines.get(machineId) ?? { id: machineId, state: 'running' };
    current.state = 'suspended';
    this.machines.set(machineId, current);
  }

  async createMachine(request: SandboxCreateMachineRequest): Promise<{ id: string }> {
    this.createSeq += 1;
    const id = request.name?.trim() || `box_${this.createSeq}`;
    const root = await mkdtemp(join(tmpdir(), `maka-box-${id}-`));
    if (request.snapshotId) {
      const src = this.snapshotRoots.get(request.snapshotId);
      if (!src) throw new Error(`unknown snapshot ${request.snapshotId}`);
      await cp(src, root, { recursive: true });
    }
    this.roots.set(id, root);
    this.rootJobs.set(id, Promise.resolve(root));
    this.machines.set(id, {
      id,
      state: 'running',
      deleteAfterSeconds: request.deleteAfterSeconds,
    });
    return { id };
  }

  async deleteMachine(machineId: string): Promise<void> {
    this.gone(machineId);
  }

  /** Test helper: the box is gone. Next acquire must rebuild. */
  gone(machineId: string): void {
    this.machines.delete(machineId);
    this.roots.delete(machineId);
    this.rootJobs.delete(machineId);
    for (const key of [...this.leases.keys()]) {
      if (key.startsWith(`${machineId}:`)) this.leases.delete(key);
    }
  }
}

export interface HttpSandboxOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Instabox HTTP adapter. Credentials stay on the host; the API key is never
 * logged or returned. Same wire paths as `@maka-cloud/instabox` InstaboxClient.
 */
export class HttpSandbox implements SandboxPort {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly nowFn: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(options: HttpSandboxOptions) {
    if (!options.apiKey?.trim()) {
      throw new InstaboxCredentialsError(
        'INSTABOX_API_KEY is not set. HttpSandbox refuses to start without a key.',
      );
    }
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? DEFAULT_INSTABOX_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.nowFn = options.now ?? Date.now;
    this.sleepFn = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async ensureRunning(machineId: string): Promise<void> {
    const current = await this.getMachine(machineId);
    if (current.state === 'running') return;
    if (current.state === 'suspended') {
      await this.mutate(machineId, 'resume');
      return;
    }
    if (current.state === 'stopped') {
      await this.mutate(machineId, 'start');
      return;
    }
    throw new Error(`instabox sandbox ${machineId} is ${current.state} and cannot be started.`);
  }

  async exec(machineId: string, request: SandboxExecRequest): Promise<SandboxExecResult> {
    const body = await this.request<SandboxExecResult>(
      'POST',
      `/v1/machines/${encodeURIComponent(machineId)}/exec`,
      {
        cmd: request.cmd,
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.env ? { env: request.env } : {}),
        ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
        ...(request.timeoutSeconds !== undefined ? { timeoutSeconds: request.timeoutSeconds } : {}),
      },
    );
    return {
      stdout: body.stdout ?? '',
      stderr: body.stderr ?? '',
      exitCode: body.exitCode ?? 1,
    };
  }

  async getMachine(machineId: string): Promise<SandboxMachine> {
    const body = await this.request<{ id: string; state: string; operationId?: string | null }>(
      'GET',
      `/v1/machines/${encodeURIComponent(machineId)}`,
    );
    return {
      id: body.id ?? machineId,
      state: body.state ?? 'unknown',
      operationId: body.operationId,
    };
  }

  async createSnapshot(machineId: string, name: string): Promise<{ id: string }> {
    const body = await this.request<{ id: string }>(
      'POST',
      `/v1/machines/${encodeURIComponent(machineId)}/snapshots`,
      { name },
    );
    if (!body.id) throw new Error('instabox createSnapshot returned no id.');
    return { id: body.id };
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    await this.request('DELETE', `/v1/snapshots/${encodeURIComponent(snapshotId)}`);
  }

  async waitForSnapshot(snapshotId: string): Promise<void> {
    const body = await this.request<{ status?: string; error?: string }>(
      'GET',
      `/v1/snapshots/${encodeURIComponent(snapshotId)}`,
    );
    if (body.status === 'failed') {
      throw new Error(`instabox snapshot ${snapshotId} failed: ${body.error ?? 'no error detail'}`);
    }
  }

  async putActivityLease(machineId: string, holder: string): Promise<void> {
    await this.request(
      'PUT',
      `/v1/machines/${encodeURIComponent(machineId)}/activity-leases/${encodeURIComponent(holder)}`,
      { ttlSeconds: 60 },
    );
  }

  async deleteActivityLease(machineId: string, holder: string): Promise<void> {
    await this.request(
      'DELETE',
      `/v1/machines/${encodeURIComponent(machineId)}/activity-leases/${encodeURIComponent(holder)}`,
    );
  }

  async suspend(machineId: string): Promise<void> {
    await this.mutate(machineId, 'suspend');
  }

  async createMachine(request: {
    name?: string;
    templateId?: string;
    snapshotId?: string;
    metadata?: Record<string, string>;
    desiredState?: 'running' | 'stopped';
    vcpus?: number;
    memMiB?: number;
  }): Promise<InstaboxOperation> {
    if ((request.templateId === undefined) === (request.snapshotId === undefined)) {
      throw new Error('createMachine needs exactly one of templateId and snapshotId.');
    }
    return await this.request<InstaboxOperation>('POST', '/v1/machines', request, {
      idempotencyKey: `maka-create-${Date.now()}`,
    });
  }

  async deleteMachine(machineId: string): Promise<InstaboxOperation> {
    return await this.request<InstaboxOperation>(
      'DELETE',
      `/v1/machines/${encodeURIComponent(machineId)}`,
      undefined,
      { idempotencyKey: `maka-delete-${this.nowFn()}` },
    );
  }

  /**
   * Long-polls `GET /v1/operations/{id}?wait=25s` until succeeded, failed, or the
   * deadline (default 5 minutes). Same query as InstaboxClient; no client-side
   * tight loop.
   */
  async waitForOperation(
    operationId: string,
    options: { deadlineMs?: number } = {},
  ): Promise<InstaboxOperation> {
    const deadline = this.nowFn() + (options.deadlineMs ?? OPERATION_DEADLINE_MS);
    for (;;) {
      const operation = await this.request<InstaboxOperation>(
        'GET',
        `/v1/operations/${encodeURIComponent(operationId)}`,
        undefined,
        { query: { wait: OPERATION_WAIT } },
      );
      if (operation.state === 'succeeded') return operation;
      if (operation.state === 'failed') {
        throw new Error(`instabox operation ${operationId} failed`);
      }
      if (this.nowFn() >= deadline) {
        throw new Error(
          `instabox operation ${operationId} still ${operation.state} after the wait deadline.`,
        );
      }
      // Server should hold `wait=25s`. Tests and servers that ignore it still yield.
      await this.sleepFn(0);
    }
  }

  /**
   * Wait for an in-flight create (or other op), then DELETE. Retries HTTP 409
   * `operation_conflict` until the same deadline. InstaboxClient.deleteMachine
   * does not send `X-Confirm-Delete`, so this client does not either.
   */
  async destroyMachine(
    machineId: string,
    options: { waitFor?: string; deadlineMs?: number } = {},
  ): Promise<InstaboxOperation> {
    const deadlineAt = this.nowFn() + (options.deadlineMs ?? OPERATION_DEADLINE_MS);
    const remaining = () => Math.max(0, deadlineAt - this.nowFn());
    const waitQuietly = async (operationId: string) => {
      if (remaining() <= 0) return;
      try {
        await this.waitForOperation(operationId, { deadlineMs: remaining() });
      } catch {
        // Still try DELETE; a running create answers 409 and we retry.
      }
    };

    if (options.waitFor) {
      await waitQuietly(options.waitFor);
    } else {
      try {
        const current = await this.getMachine(machineId);
        if (current.operationId) await waitQuietly(current.operationId);
      } catch {
        // Machine may not be readable while create is pending.
      }
    }

    let attempt = 0;
    let lastError: unknown;
    while (remaining() > 0) {
      try {
        const deleted = await this.deleteMachine(machineId);
        if (deleted.state !== 'succeeded' && deleted.id) {
          await this.waitForOperation(deleted.id, { deadlineMs: remaining() });
        }
        return deleted;
      } catch (error) {
        lastError = error;
        if (error instanceof InstaboxHttpError && error.status === 404) {
          return { id: '', machineId, state: 'succeeded' };
        }
        if (!isOperationConflict(error)) throw error;
        if (error.operationId) {
          await waitQuietly(error.operationId);
        } else {
          try {
            const current = await this.getMachine(machineId);
            if (current.operationId) await waitQuietly(current.operationId);
            else await this.sleepFn(Math.min(5_000, 250 * 2 ** attempt++));
          } catch {
            await this.sleepFn(Math.min(5_000, 250 * 2 ** attempt++));
          }
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`instabox delete ${machineId} did not finish`);
  }

  private async mutate(machineId: string, action: 'resume' | 'start' | 'suspend'): Promise<void> {
    await this.request('POST', `/v1/machines/${encodeURIComponent(machineId)}/${action}`);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extras?: { idempotencyKey?: string; query?: Record<string, string> },
  ): Promise<T> {
    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (extras?.idempotencyKey) headers['Idempotency-Key'] = extras.idempotencyKey;
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(extras?.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const response = await this.fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw instaboxHttpError(method, path, response.status, text, this.apiKey);
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`instabox ${method} ${path} returned non-JSON`);
    }
  }
}

/** Key + optional base URL. The live smoke does not need a pre-existing machine. */
export function instaboxApiFromEnv(env: NodeJS.ProcessEnv = process.env): InstaboxApiConfig {
  const apiKey = env.INSTABOX_API_KEY?.trim() ?? '';
  if (!apiKey) {
    throw new InstaboxCredentialsError(
      'INSTABOX_API_KEY is not set. Export it in the environment; do not put it on argv.',
    );
  }
  const raw = env.INSTABOX_API_URL?.trim() || DEFAULT_INSTABOX_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('INSTABOX_API_URL is not a valid URL.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('INSTABOX_API_URL must not carry credentials.');
  }
  return { apiKey, baseUrl: raw.replace(/\/+$/, '') };
}

export function instaboxCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): InstaboxCredentials {
  const api = instaboxApiFromEnv(env);
  const machineId = env.INSTABOX_MACHINE_ID?.trim() ?? '';
  if (!machineId) {
    throw new InstaboxCredentialsError(
      'INSTABOX_MACHINE_ID is not set. The local loop can reuse one machine; live-smoke creates an ephemeral box and does not need this.',
    );
  }
  return { apiKey: api.apiKey, machineId, baseUrl: api.baseUrl };
}

/** Exactly one of template or snapshot, same rule as InstaboxClient.createMachine. */
export function instaboxCreateSourceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { templateId: string } | { snapshotId: string } {
  const templateId = env.INSTABOX_TEMPLATE_ID?.trim() || env.MAKA_CLOUD_BOX_TEMPLATE?.trim() || '';
  const snapshotId = env.INSTABOX_SNAPSHOT_ID?.trim() || '';
  if (templateId && snapshotId) {
    throw new Error(
      'Set only one of INSTABOX_TEMPLATE_ID / MAKA_CLOUD_BOX_TEMPLATE and INSTABOX_SNAPSHOT_ID.',
    );
  }
  if (templateId) return { templateId };
  if (snapshotId) return { snapshotId };
  return { templateId: DEFAULT_LIVE_SMOKE_TEMPLATE };
}

/**
 * FakeSandbox when no key is set. Incomplete credentials (key without a
 * machine id) throw. Both set → HttpSandbox against Instabox.
 */
export function createSandboxFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): SandboxPort {
  const apiKey = env.INSTABOX_API_KEY?.trim() ?? '';
  if (!apiKey) return new FakeSandbox();
  const creds = instaboxCredentialsFromEnv(env);
  return new HttpSandbox({ apiKey: creds.apiKey, baseUrl: creds.baseUrl, fetch: fetchImpl });
}

/** Always the live Instabox client. Throws when credentials are missing. */
export function createInstaboxSandboxFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): HttpSandbox {
  const creds = instaboxCredentialsFromEnv(env);
  return new HttpSandbox({ apiKey: creds.apiKey, baseUrl: creds.baseUrl, fetch: fetchImpl });
}

function runLocal(
  cmd: string,
  cwd: string,
  stdin?: string,
  timeoutSeconds?: number,
  extraEnv?: Record<string, string>,
): Promise<SandboxExecResult> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', cmd], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer =
      timeoutSeconds !== undefined
        ? setTimeout(() => child.kill('SIGKILL'), timeoutSeconds * 1000)
        : undefined;
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}${error.message}`, exitCode: 1 });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.stdin.on('error', () => {});
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

function instaboxHttpError(
  method: string,
  path: string,
  status: number,
  body: string,
  apiKey: string,
): InstaboxHttpError {
  const clipped = body.length > 800 ? `${body.slice(0, 800)}…` : body;
  const detail = clipped.replace(/\s+/g, ' ').trim();
  const message = redactSecret(
    `instabox ${method} ${path} failed: HTTP ${status}${detail ? ` ${detail}` : ''}`,
    apiKey,
  );
  const envelope = parseErrorEnvelope(body);
  return new InstaboxHttpError(message, { status, ...envelope });
}

function parseErrorEnvelope(body: string): {
  code?: string;
  retryable?: boolean;
  operationId?: string | null;
} {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const error = (parsed as { error?: unknown }).error;
    if (typeof error !== 'object' || error === null) return {};
    const row = error as {
      code?: unknown;
      retryable?: unknown;
      operationId?: unknown;
    };
    return {
      ...(typeof row.code === 'string' ? { code: row.code } : {}),
      ...(typeof row.retryable === 'boolean' ? { retryable: row.retryable } : {}),
      ...(typeof row.operationId === 'string' || row.operationId === null
        ? { operationId: row.operationId }
        : {}),
    };
  } catch {
    return {};
  }
}
