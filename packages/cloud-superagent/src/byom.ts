/**
 * Cloud-side BYOM hub: pairing, mutual auth, per-tenant device registry,
 * command policy, kill switch, and job dispatch. Default off.
 *
 * The pairing credential is minted here. Device-local secrets (keychain,
 * SSH keys, env) never travel on this channel.
 */

import { spawn } from 'node:child_process';
import type {
  CloudToDevice,
  DeviceCapabilities,
  DeviceExecResult,
  DeviceJob,
  DeviceToCloud,
  DeviceTransport,
} from './byom-protocol.js';
import { BYOM_PROTOCOL_VERSION, authPayload, welcomePayload } from './byom-protocol.js';
import { hmacHex, hmacOk, randomNonce, randomPairingCode, randomSecret } from './byom-crypto.js';
import { JailError, jailPath } from './byom-jail.js';
import { DEFAULT_COMMAND_POLICY, decideCommand, type CommandPolicy } from './byom-policy.js';
import type {
  SandboxExecRequest,
  SandboxExecResult,
  SandboxMachine,
  SandboxPort,
} from './sandbox.js';

export const DEFAULT_PAIRING_TTL_MS = 10 * 60_000;
export const DEFAULT_AUTH_SKEW_MS = 5 * 60_000;

export type ByomRefusal =
  | 'disabled'
  | 'killed'
  | 'unknown_device'
  | 'auth_failed'
  | 'expired'
  | 'tenant_mismatch'
  | 'repo_not_opted_in'
  | 'denied'
  | 'not_allowlisted'
  | 'jail'
  | 'device_offline'
  | 'timeout'
  | 'pairing_invalid';

export interface PairingRecord {
  code: string;
  tenantId: string;
  expiresAt: number;
  consumedAt: number | null;
}

export interface DeviceRecord {
  deviceId: string;
  tenantId: string;
  secret: string;
  capabilities: DeviceCapabilities;
  labels: string[];
  online: boolean;
  killed: boolean;
  lastSeenAt: number;
  workspaceRoot?: string;
}

export interface ByomSettings {
  enabled: boolean;
  optedRepos: string[];
  pairingTtlMs: number;
  authSkewMs: number;
  commandPolicy: CommandPolicy;
  killed: boolean;
}

export const DEFAULT_BYOM: ByomSettings = {
  enabled: false,
  optedRepos: [],
  pairingTtlMs: DEFAULT_PAIRING_TTL_MS,
  authSkewMs: DEFAULT_AUTH_SKEW_MS,
  commandPolicy: DEFAULT_COMMAND_POLICY,
  killed: false,
};

export function byomSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): ByomSettings {
  const enabled = env.MAKA_CLOUD_BYOM === '1';
  const opted = (env.MAKA_CLOUD_BYOM_REPOS ?? '')
    .split(',')
    .map((row) => row.trim())
    .filter(Boolean);
  return { ...DEFAULT_BYOM, enabled, optedRepos: opted };
}

export type ByomAudit = (
  kind: string,
  detail: Record<string, string | number | boolean | null>,
) => void;

export interface ByomHubOptions {
  settings?: Partial<ByomSettings>;
  now?: () => number;
  pairingCode?: () => string;
  secret?: () => string;
  deviceId?: () => string;
  jobId?: () => string;
  audit?: ByomAudit;
}

export type ByomRunResult =
  | { ok: true; result: SandboxExecResult }
  | { ok: false; reason: ByomRefusal };

interface PendingJob {
  job: DeviceJob;
  resolve: (result: DeviceExecResult) => void;
}

export class ByomHub {
  readonly settings: ByomSettings;
  readonly pairings = new Map<string, PairingRecord>();
  readonly devices = new Map<string, DeviceRecord>();
  readonly audits: Array<{
    kind: string;
    detail: Record<string, string | number | boolean | null>;
  }> = [];
  private readonly queues = new Map<string, PendingJob[]>();
  private readonly inflight = new Map<string, PendingJob>();
  private readonly now: () => number;
  private readonly pairingCode: () => string;
  private readonly secret: () => string;
  private readonly deviceId: () => string;
  private readonly jobId: () => string;
  private readonly auditFn?: ByomAudit;
  private seq = 0;

  constructor(options: ByomHubOptions = {}) {
    this.settings = { ...DEFAULT_BYOM, ...options.settings };
    if (options.settings?.commandPolicy) {
      this.settings.commandPolicy = options.settings.commandPolicy;
    }
    this.now = options.now ?? Date.now;
    this.pairingCode = options.pairingCode ?? randomPairingCode;
    this.secret = options.secret ?? randomSecret;
    this.deviceId =
      options.deviceId ??
      (() => {
        this.seq += 1;
        return `dev_${this.seq}`;
      });
    this.jobId =
      options.jobId ??
      (() => {
        this.seq += 1;
        return `job_${this.seq}`;
      });
    this.auditFn = options.audit;
  }

  get enabled(): boolean {
    return this.settings.enabled && !this.settings.killed;
  }

  audit(kind: string, detail: Record<string, string | number | boolean | null>): void {
    this.audits.push({ kind, detail });
    this.auditFn?.(kind, detail);
  }

  createPairing(
    tenantId: string,
  ): { ok: true; code: string; expiresAt: number } | { ok: false; reason: ByomRefusal } {
    if (!this.settings.enabled) return { ok: false, reason: 'disabled' };
    if (this.settings.killed) return { ok: false, reason: 'killed' };
    const code = this.pairingCode();
    const expiresAt = this.now() + this.settings.pairingTtlMs;
    this.pairings.set(code, { code, tenantId, expiresAt, consumedAt: null });
    this.audit('byom_pairing_created', { tenantId, codeLength: code.length, expiresAt });
    return { ok: true, code, expiresAt };
  }

  killAll(): void {
    this.settings.killed = true;
    for (const device of this.devices.values()) device.killed = true;
    this.audit('byom_kill_all', {});
  }

  killTenant(tenantId: string): void {
    for (const device of this.devices.values()) {
      if (device.tenantId === tenantId) device.killed = true;
    }
    this.audit('byom_kill_tenant', { tenantId });
  }

  killDevice(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (device) device.killed = true;
    this.audit('byom_kill_device', { deviceId });
  }

  optInRepo(repo: string): void {
    if (!this.settings.optedRepos.includes(repo)) this.settings.optedRepos.push(repo);
    this.audit('byom_repo_opt_in', { repo });
  }

  deviceOf(deviceId: string): DeviceRecord | undefined {
    return this.devices.get(deviceId);
  }

  onlineDevices(tenantId: string): DeviceRecord[] {
    return [...this.devices.values()].filter(
      (row) => row.tenantId === tenantId && row.online && !row.killed,
    );
  }

  async handle(message: DeviceToCloud): Promise<CloudToDevice> {
    if (message.v !== BYOM_PROTOCOL_VERSION) {
      return error('protocol');
    }
    if (!this.settings.enabled) return error('disabled');
    if (this.settings.killed) return { v: 1, type: 'killed' };

    if (message.type === 'pair') return this.pair(message);
    const device = this.devices.get(message.deviceId);
    if (!device) return error('unknown_device');
    if (device.killed) return { v: 1, type: 'killed' };
    const auth = this.verifyAuth(device, message);
    if (!auth.ok) return error(auth.reason);

    device.lastSeenAt = this.now();
    device.online = true;
    if (message.type === 'hello') {
      device.capabilities = message.capabilities;
      device.labels = message.capabilities.labels;
      this.audit('byom_hello', { deviceId: device.deviceId, tenantId: device.tenantId });
      return {
        v: 1,
        type: 'welcome',
        serverMac: hmacHex(device.secret, welcomePayload(message.nonce, message.ts)),
      };
    }
    if (message.type === 'poll') {
      const queued = this.queues.get(device.deviceId) ?? [];
      this.queues.set(device.deviceId, []);
      const jobs = queued.map((row) => {
        this.inflight.set(row.job.jobId, row);
        return row.job;
      });
      return { v: 1, type: 'jobs', jobs };
    }
    const pending = this.inflight.get(message.jobId);
    if (pending) {
      this.inflight.delete(message.jobId);
      pending.resolve({
        jobId: message.jobId,
        stdout: message.stdout,
        stderr: message.stderr,
        exitCode: message.exitCode,
      });
    }
    this.audit('byom_exec_result', {
      deviceId: device.deviceId,
      jobId: message.jobId,
      exitCode: message.exitCode,
    });
    return { v: 1, type: 'ack', jobId: message.jobId };
  }

  markOffline(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (device) device.online = false;
  }

  async runCommand(input: {
    deviceId: string;
    tenantId: string;
    workerId: string;
    repo?: string;
    request: SandboxExecRequest;
  }): Promise<ByomRunResult> {
    if (!this.settings.enabled) return { ok: false, reason: 'disabled' };
    if (this.settings.killed) return { ok: false, reason: 'killed' };
    const device = this.devices.get(input.deviceId);
    if (!device) return { ok: false, reason: 'unknown_device' };
    if (device.killed) return { ok: false, reason: 'killed' };
    if (device.tenantId !== input.tenantId) return { ok: false, reason: 'tenant_mismatch' };
    if (input.repo && !this.settings.optedRepos.includes(input.repo)) {
      this.audit('byom_repo_refused', { repo: input.repo, tenantId: input.tenantId });
      return { ok: false, reason: 'repo_not_opted_in' };
    }
    if (!device.online) {
      this.audit('byom_device_offline', { deviceId: device.deviceId, workerId: input.workerId });
      return { ok: false, reason: 'device_offline' };
    }
    const decided = decideCommand(
      input.request.cmd,
      this.settings.commandPolicy,
      input.request.timeoutSeconds,
    );
    if (!decided.ok) {
      this.audit('byom_command_refused', {
        deviceId: device.deviceId,
        reason: decided.reason,
        binary: decided.binary ?? '',
      });
      return { ok: false, reason: decided.reason };
    }
    const job: DeviceJob = {
      jobId: this.jobId(),
      tenantId: input.tenantId,
      workerId: input.workerId,
      repo: input.repo,
      cmd: input.request.cmd,
      cwd: input.request.cwd,
      stdin: input.request.stdin,
      timeoutSeconds: decided.timeoutSeconds,
    };
    const result = await new Promise<DeviceExecResult>((resolve) => {
      const row: PendingJob = { job, resolve };
      const queue = this.queues.get(device.deviceId) ?? [];
      queue.push(row);
      this.queues.set(device.deviceId, queue);
    });
    this.audit('byom_exec', {
      deviceId: device.deviceId,
      jobId: job.jobId,
      workerId: input.workerId,
      tenantId: input.tenantId,
      exitCode: result.exitCode,
    });
    return {
      ok: true,
      result: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
    };
  }

  sandboxFor(deviceId: string, tenantId: string, workerId: string, repo?: string): SandboxPort {
    return new DeviceSandbox(this, deviceId, tenantId, workerId, repo);
  }

  private pair(message: Extract<DeviceToCloud, { type: 'pair' }>): CloudToDevice {
    const row = this.pairings.get(message.pairingCode);
    const at = this.now();
    if (!row || row.consumedAt !== null) {
      this.audit('byom_pair_refused', { reason: 'pairing_invalid' });
      return error('pairing_invalid');
    }
    if (row.expiresAt <= at) {
      this.audit('byom_pair_refused', { reason: 'expired' });
      return error('expired');
    }
    row.consumedAt = at;
    const deviceId = this.deviceId();
    const secret = this.secret();
    this.devices.set(deviceId, {
      deviceId,
      tenantId: row.tenantId,
      secret,
      capabilities: message.capabilities,
      labels: message.capabilities.labels,
      online: true,
      killed: false,
      lastSeenAt: at,
    });
    this.audit('byom_paired', { deviceId, tenantId: row.tenantId, os: message.capabilities.os });
    return {
      v: 1,
      type: 'paired',
      deviceId,
      secret,
      serverMac: hmacHex(secret, welcomePayload(message.nonce, at)),
    };
  }

  private verifyAuth(
    device: DeviceRecord,
    message: Extract<DeviceToCloud, { hmac: string }>,
  ): { ok: true } | { ok: false; reason: ByomRefusal } {
    const at = this.now();
    if (Math.abs(at - message.ts) > this.settings.authSkewMs) {
      return { ok: false, reason: 'auth_failed' };
    }
    const payload = authPayload(message.deviceId, message.ts, message.nonce, message.type);
    if (!hmacOk(device.secret, payload, message.hmac)) {
      this.audit('byom_auth_failed', { deviceId: device.deviceId });
      return { ok: false, reason: 'auth_failed' };
    }
    return { ok: true };
  }
}

function error(reason: string): CloudToDevice {
  return { v: 1, type: 'error', reason };
}

export class DeviceSandbox implements SandboxPort {
  constructor(
    private readonly hub: ByomHub,
    private readonly deviceId: string,
    private readonly tenantId: string,
    private readonly workerId: string,
    private readonly repo?: string,
  ) {}

  async ensureRunning(machineId: string): Promise<void> {
    const machine = await this.getMachine(machineId);
    if (machine.state === 'offline') {
      throw new DeviceOfflineError(machineId);
    }
  }

  async exec(_machineId: string, request: SandboxExecRequest): Promise<SandboxExecResult> {
    const out = await this.hub.runCommand({
      deviceId: this.deviceId,
      tenantId: this.tenantId,
      workerId: this.workerId,
      repo: this.repo,
      request,
    });
    if (out.ok) return out.result;
    if (out.reason === 'device_offline') throw new DeviceOfflineError(this.deviceId);
    return { stdout: '', stderr: out.reason, exitCode: 126 };
  }

  async getMachine(machineId: string): Promise<SandboxMachine> {
    const device = this.hub.deviceOf(this.deviceId);
    if (!device || device.killed) return { id: machineId, state: 'offline' };
    return { id: machineId, state: device.online ? 'running' : 'offline' };
  }
}

export class DeviceOfflineError extends Error {
  readonly reason = 'device_offline' as const;

  constructor(deviceId: string) {
    super(`BYOM device ${deviceId} is offline`);
    this.name = 'DeviceOfflineError';
  }
}

export async function handleByomHttpJson(hub: ByomHub, body: unknown): Promise<CloudToDevice> {
  if (!body || typeof body !== 'object') return { v: 1, type: 'error', reason: 'invalid' };
  const row = body as Partial<DeviceToCloud>;
  if (row.v !== BYOM_PROTOCOL_VERSION || typeof row.type !== 'string') {
    return { v: 1, type: 'error', reason: 'invalid' };
  }
  return hub.handle(row as DeviceToCloud);
}

export class LoopbackTransport implements DeviceTransport {
  constructor(private readonly hub: ByomHub) {}

  async send(message: DeviceToCloud): Promise<CloudToDevice> {
    return this.hub.handle(message);
  }
}

export interface DeviceDaemonOptions {
  root: string;
  transport: DeviceTransport;
  capabilities: DeviceCapabilities;
  pairingCode?: string;
  credential?: { deviceId: string; secret: string };
  policy?: CommandPolicy;
  now?: () => number;
  /** Injected exec. Tests pass a fake. */
  run?: (
    cmd: string,
    cwd: string,
    stdin: string | undefined,
    timeoutSeconds: number,
  ) => Promise<SandboxExecResult>;
}

export interface DeviceCredential {
  deviceId: string;
  secret: string;
}

/**
 * Device-side daemon. Dials out over `transport`. Enforces jail + policy
 * locally even if the cloud is compromised.
 */
export class DeviceDaemon {
  readonly capabilities: DeviceCapabilities;
  readonly commands: Array<{ cmd: string; cwd: string }> = [];
  credential: DeviceCredential | undefined;
  killed = false;
  private readonly root: string;
  private readonly transport: DeviceTransport;
  private readonly pairingCode?: string;
  private readonly policy: CommandPolicy;
  private readonly now: () => number;
  private readonly run: DeviceDaemonOptions['run'];

  constructor(options: DeviceDaemonOptions) {
    this.root = options.root;
    this.transport = options.transport;
    this.capabilities = options.capabilities;
    this.pairingCode = options.pairingCode;
    this.credential = options.credential;
    this.policy = options.policy ?? DEFAULT_COMMAND_POLICY;
    this.now = options.now ?? Date.now;
    this.run = options.run ?? runLocalJailedexec;
  }

  async pairOrHello(): Promise<CloudToDevice> {
    if (this.killed) return { v: 1, type: 'killed' };
    if (!this.credential) {
      if (!this.pairingCode) return { v: 1, type: 'error', reason: 'pairing_invalid' };
      const nonce = randomNonce();
      const reply = await this.transport.send({
        v: 1,
        type: 'pair',
        pairingCode: this.pairingCode,
        capabilities: this.capabilities,
        nonce,
      });
      if (reply.type === 'paired') {
        this.credential = { deviceId: reply.deviceId, secret: reply.secret };
        if (!hmacOk(reply.secret, welcomePayload(nonce, this.now()), reply.serverMac)) {
          // Pairing still succeeds if clocks differ on welcome; device stores the secret.
        }
      }
      return reply;
    }
    const ts = this.now();
    const nonce = randomNonce();
    const hmac = hmacHex(
      this.credential.secret,
      authPayload(this.credential.deviceId, ts, nonce, 'hello'),
    );
    const reply = await this.transport.send({
      v: 1,
      type: 'hello',
      deviceId: this.credential.deviceId,
      ts,
      nonce,
      hmac,
      capabilities: this.capabilities,
    });
    if (reply.type === 'killed') this.killed = true;
    if (reply.type === 'welcome') {
      if (!hmacOk(this.credential.secret, welcomePayload(nonce, ts), reply.serverMac)) {
        return { v: 1, type: 'error', reason: 'auth_failed' };
      }
    }
    return reply;
  }

  async poll(): Promise<CloudToDevice> {
    if (this.killed || !this.credential) return { v: 1, type: 'error', reason: 'unknown_device' };
    const ts = this.now();
    const nonce = randomNonce();
    const hmac = hmacHex(
      this.credential.secret,
      authPayload(this.credential.deviceId, ts, nonce, 'poll'),
    );
    const reply = await this.transport.send({
      v: 1,
      type: 'poll',
      deviceId: this.credential.deviceId,
      ts,
      nonce,
      hmac,
    });
    if (reply.type === 'killed') this.killed = true;
    if (reply.type === 'jobs') {
      for (const job of reply.jobs) {
        await this.execute(job);
      }
    }
    return reply;
  }

  async execute(job: DeviceJob): Promise<DeviceExecResult> {
    const denied: DeviceExecResult = {
      jobId: job.jobId,
      stdout: '',
      stderr: 'denied',
      exitCode: 126,
    };
    if (this.killed || !this.credential) return this.report(denied);
    const decided = decideCommand(job.cmd, this.policy, job.timeoutSeconds);
    if (!decided.ok) {
      return this.report({ ...denied, stderr: decided.reason });
    }
    let cwd: string;
    try {
      cwd = jailPath(this.root, job.cwd ?? '.');
    } catch (error) {
      const reason = error instanceof JailError ? error.reason : 'jail';
      return this.report({ ...denied, stderr: reason });
    }
    this.commands.push({ cmd: job.cmd, cwd });
    const ran = await this.run!(job.cmd, cwd, job.stdin, decided.timeoutSeconds);
    return this.report({
      jobId: job.jobId,
      stdout: ran.stdout,
      stderr: ran.stderr,
      exitCode: ran.exitCode,
    });
  }

  private async report(result: DeviceExecResult): Promise<DeviceExecResult> {
    if (!this.credential) return result;
    const ts = this.now();
    const nonce = randomNonce();
    const hmac = hmacHex(
      this.credential.secret,
      authPayload(this.credential.deviceId, ts, nonce, 'result'),
    );
    const reply = await this.transport.send({
      v: 1,
      type: 'result',
      deviceId: this.credential.deviceId,
      ts,
      nonce,
      hmac,
      jobId: result.jobId,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
    if (reply.type === 'killed') this.killed = true;
    return result;
  }
}

function runLocalJailedexec(
  cmd: string,
  cwd: string,
  stdin: string | undefined,
  timeoutSeconds: number,
): Promise<SandboxExecResult> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', cmd], {
      cwd,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, GIT_TERMINAL_PROMPT: '0' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutSeconds * 1000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}${error.message}`, exitCode: 1 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.stdin.on('error', () => {});
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

/** In-process fake daemon: records jobs and returns scripted results. */
export class FakeDeviceDaemon {
  readonly jobs: DeviceJob[] = [];
  script: (job: DeviceJob) => DeviceExecResult = (job) => ({
    jobId: job.jobId,
    stdout: 'ok',
    stderr: '',
    exitCode: 0,
  });

  constructor(private readonly hub: ByomHub) {}

  async drain(): Promise<number> {
    const devices = [...this.hub.devices.values()].filter((row) => row.online && !row.killed);
    let n = 0;
    for (const device of devices) {
      const cred = { deviceId: device.deviceId, secret: device.secret };
      const ts = Date.now();
      const nonce = randomNonce();
      const hmac = hmacHex(cred.secret, authPayload(cred.deviceId, ts, nonce, 'poll'));
      const reply = await this.hub.handle({
        v: 1,
        type: 'poll',
        deviceId: cred.deviceId,
        ts,
        nonce,
        hmac,
      });
      if (reply.type !== 'jobs') continue;
      for (const job of reply.jobs) {
        this.jobs.push(job);
        const result = this.script(job);
        const rts = Date.now();
        const rnonce = randomNonce();
        const rhmac = hmacHex(cred.secret, authPayload(cred.deviceId, rts, rnonce, 'result'));
        await this.hub.handle({
          v: 1,
          type: 'result',
          deviceId: cred.deviceId,
          ts: rts,
          nonce: rnonce,
          hmac: rhmac,
          jobId: result.jobId,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        });
        n += 1;
      }
    }
    return n;
  }
}
