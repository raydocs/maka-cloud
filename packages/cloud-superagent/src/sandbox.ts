/**
 * SandboxPort matches the SandboxApi seam of open PR #452
 * (`Pick<InstaboxClient, ensureRunning | exec | getMachine | snapshots | leases>`).
 * When that PR merges, InstaboxClient satisfies this structurally. boat.dev is parked.
 * HttpSandbox speaks the Instabox HTTP API so Super-agent stays zod-only.
 */

export const DEFAULT_INSTABOX_BASE_URL = 'https://api.instabox.sh';

export interface SandboxExecRequest {
  cmd: string;
  cwd?: string;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxMachine {
  id: string;
  state: string;
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
}

export class InstaboxCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstaboxCredentialsError';
  }
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

/** Replace a secret in any string we print. Never log the raw key. */
export function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join('<redacted>');
}

export class FakeSandbox implements SandboxPort {
  readonly commands: Array<{ machineId: string; cmd: string }> = [];
  readonly machines = new Map<string, SandboxMachine>();
  readonly snapshots = new Map<string, { id: string; machineId: string; name: string }>();
  readonly leases = new Map<string, string>();
  private snapshotSeq = 0;

  async ensureRunning(machineId: string): Promise<void> {
    const current = this.machines.get(machineId) ?? { id: machineId, state: 'stopped' };
    current.state = 'running';
    this.machines.set(machineId, current);
  }

  async exec(machineId: string, request: SandboxExecRequest): Promise<SandboxExecResult> {
    await this.ensureRunning(machineId);
    this.commands.push({ machineId, cmd: request.cmd });
    return { stdout: `fake:${request.cmd}`, stderr: '', exitCode: 0 };
  }

  async getMachine(machineId: string): Promise<SandboxMachine> {
    return this.machines.get(machineId) ?? { id: machineId, state: 'unknown' };
  }

  async createSnapshot(machineId: string, name: string): Promise<{ id: string }> {
    this.snapshotSeq += 1;
    const id = `snap_${this.snapshotSeq}`;
    this.snapshots.set(id, { id, machineId, name });
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
}

export interface HttpSandboxOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Instabox HTTP adapter. Credentials stay on the host; the API key is never
 * logged or returned. Same wire paths as `@maka-cloud/instabox` InstaboxClient.
 */
export class HttpSandbox implements SandboxPort {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpSandboxOptions) {
    if (!options.apiKey?.trim()) {
      throw new InstaboxCredentialsError(
        'INSTABOX_API_KEY is not set. HttpSandbox refuses to start without a key.',
      );
    }
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? DEFAULT_INSTABOX_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
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
      { cmd: request.cmd, ...(request.cwd ? { cwd: request.cwd } : {}) },
    );
    return {
      stdout: body.stdout ?? '',
      stderr: body.stderr ?? '',
      exitCode: body.exitCode ?? 1,
    };
  }

  async getMachine(machineId: string): Promise<SandboxMachine> {
    const body = await this.request<{ id: string; state: string }>(
      'GET',
      `/v1/machines/${encodeURIComponent(machineId)}`,
    );
    return { id: body.id ?? machineId, state: body.state ?? 'unknown' };
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
      { idempotencyKey: `maka-delete-${Date.now()}` },
    );
  }

  async waitForOperation(operationId: string): Promise<InstaboxOperation> {
    for (let step = 0; step < 24; step++) {
      const operation = await this.request<InstaboxOperation>(
        'GET',
        `/v1/operations/${encodeURIComponent(operationId)}`,
      );
      if (operation.state === 'succeeded') return operation;
      if (operation.state === 'failed') {
        throw new Error(`instabox operation ${operationId} failed`);
      }
    }
    throw new Error(`instabox operation ${operationId} did not finish`);
  }

  private async mutate(machineId: string, action: 'resume' | 'start' | 'suspend'): Promise<void> {
    await this.request('POST', `/v1/machines/${encodeURIComponent(machineId)}/${action}`);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extras?: { idempotencyKey?: string },
  ): Promise<T> {
    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (extras?.idempotencyKey) headers['Idempotency-Key'] = extras.idempotencyKey;
    const response = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(formatHttpError(method, path, response.status, text, this.apiKey));
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

function formatHttpError(
  method: string,
  path: string,
  status: number,
  body: string,
  apiKey: string,
): string {
  const clipped = body.length > 800 ? `${body.slice(0, 800)}…` : body;
  const detail = clipped.replace(/\s+/g, ' ').trim();
  return redactSecret(
    `instabox ${method} ${path} failed: HTTP ${status}${detail ? ` ${detail}` : ''}`,
    apiKey,
  );
}
