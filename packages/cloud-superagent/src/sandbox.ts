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

  private async mutate(machineId: string, action: 'resume' | 'start' | 'suspend'): Promise<void> {
    await this.request('POST', `/v1/machines/${encodeURIComponent(machineId)}/${action}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`instabox ${method} ${path} failed: HTTP ${response.status}`);
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`instabox ${method} ${path} returned non-JSON`);
    }
  }
}

export function instaboxCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): InstaboxCredentials {
  const apiKey = env.INSTABOX_API_KEY?.trim() ?? '';
  const machineId = env.INSTABOX_MACHINE_ID?.trim() ?? '';
  const baseUrl = (env.INSTABOX_API_URL?.trim() || DEFAULT_INSTABOX_BASE_URL).replace(/\/+$/, '');
  if (!apiKey) {
    throw new InstaboxCredentialsError(
      'INSTABOX_API_KEY is not set. The local loop uses FakeSandbox when the key is absent; a live Instabox run needs the key.',
    );
  }
  if (!machineId) {
    throw new InstaboxCredentialsError(
      'INSTABOX_MACHINE_ID is not set. A local or P0 Super-agent run needs one machine id. The host product uses one machine per invite (MAKA_CLOUD_SANDBOXES or MAKA_CLOUD_BOXES) instead.',
    );
  }
  return { apiKey, machineId, baseUrl };
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
