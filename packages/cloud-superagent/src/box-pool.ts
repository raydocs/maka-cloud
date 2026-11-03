import { BoxDaemon } from './box-daemon.js';
import type { ProgressPatch } from './progress.js';
import type { SandboxExecRequest, SandboxExecResult, SandboxPort } from './sandbox.js';
import { DEFAULT_LIVE_SMOKE_TEMPLATE } from './sandbox.js';
import type { SuperagentStore } from './store.js';
import { cloneTenantBox } from './store.js';
import type {
  Mandate,
  TenantBoxRecord,
  TenantBoxState,
  UsageEntry,
  WatchdogFinding,
} from './types.js';
import {
  DEFAULT_BOX_DELETE_AFTER_SECONDS,
  DEFAULT_BOX_LEASE_RENEW_MS,
  DEFAULT_BOX_LEASE_TTL_MS,
  DEFAULT_BOX_STUCK_AFTER_MS,
  DEFAULT_IDLE_SUSPEND_MS,
  DEFAULT_SHARED_BOX,
  DEFAULT_WORKERS_PER_BOX,
  tenantBoxWorkerId,
} from './types.js';

export const BOX_WORK_ROOT = 'work';
export const BOX_BASE_DIR = 'work/.base';
export const BOX_NPM_CACHE = 'work/.npm';

export const BOX_TIMING_WORKERS = {
  create: '__box__:create',
  wake: '__box__:wake',
  restore: '__box__:restore',
} as const;

export type BoxTimingKind = keyof typeof BOX_TIMING_WORKERS;

export interface BoxPoolOptions {
  sandbox: SandboxPort;
  store: SuperagentStore;
  now?: () => number;
  idleMs?: number;
  maxWorkers?: number;
  leaseTtlMs?: number;
  leaseRenewMs?: number;
  deleteAfterSeconds?: number;
  stuckAfterMs?: number;
  templateId?: string;
  recordUsage?: (entry: UsageEntry) => void;
  reportProgress?: (tenantId: string, workerId: string, patch: ProgressPatch) => Promise<void>;
}

export interface BoxAcquire {
  boxId: string;
  workDir: string;
  npmCache: string;
  created: boolean;
  woke: boolean;
  restored: boolean;
  wakeMs?: number;
  createMs?: number;
  restoreMs?: number;
}

export class BoxCapError extends Error {
  readonly reason = 'worker_cap' as const;
  constructor(readonly maxWorkers: number) {
    super(`This tenant box already has ${maxWorkers} workers.`);
    this.name = 'BoxCapError';
  }
}

/**
 * One long-lived Instabox box per tenant. Workers get `/work/<workerId>`
 * worktrees from a cached base clone and a shared npm cache. LayerFS stays off.
 */
export class BoxPool {
  readonly sandbox: SandboxPort;
  readonly store: SuperagentStore;
  readonly idleMs: number;
  readonly maxWorkers: number;
  readonly leaseTtlMs: number;
  readonly leaseRenewMs: number;
  readonly deleteAfterSeconds: number;
  readonly stuckAfterMs: number;
  readonly templateId: string;
  private readonly now: () => number;
  private readonly recordUsage?: (entry: UsageEntry) => void;
  private reportProgress?: BoxPoolOptions['reportProgress'];
  private readonly daemons = new Map<string, BoxDaemon>();

  constructor(options: BoxPoolOptions) {
    this.sandbox = options.sandbox;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_SUSPEND_MS;
    this.maxWorkers = options.maxWorkers ?? DEFAULT_WORKERS_PER_BOX;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_BOX_LEASE_TTL_MS;
    this.leaseRenewMs = options.leaseRenewMs ?? DEFAULT_BOX_LEASE_RENEW_MS;
    this.deleteAfterSeconds = options.deleteAfterSeconds ?? DEFAULT_BOX_DELETE_AFTER_SECONDS;
    this.stuckAfterMs = options.stuckAfterMs ?? DEFAULT_BOX_STUCK_AFTER_MS;
    this.templateId = options.templateId ?? DEFAULT_LIVE_SMOKE_TEMPLATE;
    this.recordUsage = options.recordUsage;
    this.reportProgress = options.reportProgress;
  }

  setProgressReporter(report: NonNullable<BoxPoolOptions['reportProgress']>): void {
    this.reportProgress = report;
  }

  daemon(tenantId: string): BoxDaemon {
    let row = this.daemons.get(tenantId);
    if (!row) {
      row = new BoxDaemon({ tenantId, box: this });
      this.daemons.set(tenantId, row);
    }
    return row;
  }

  async acquire(input: {
    tenantId: string;
    workerId: string;
    mandate?: Mandate;
    repoUrl?: string;
  }): Promise<BoxAcquire> {
    let box = this.store.tenantBox(input.tenantId);
    const active = box?.activeWorkers.filter((id) => id !== input.workerId) ?? [];
    if (active.length >= this.maxWorkers) throw new BoxCapError(this.maxWorkers);

    const size = boxSize(input.mandate);
    const result: BoxAcquire = {
      boxId: box?.boxId ?? '',
      workDir: workerWorkDir(input.workerId),
      npmCache: BOX_NPM_CACHE,
      created: false,
      woke: false,
      restored: false,
    };

    if (!box) {
      const created = await this.coldCreate(input.tenantId, size, input.repoUrl);
      box = created.box;
      result.created = true;
      result.createMs = created.ms;
    } else {
      const revived = await this.ensureBox(box, input.workerId, size, input.repoUrl);
      box = revived.box;
      result.woke = revived.woke;
      result.restored = revived.restored;
      result.wakeMs = revived.wakeMs;
      result.restoreMs = revived.restoreMs;
      result.createMs = revived.createMs;
      result.created = revived.created;
    }

    if (!box.activeWorkers.includes(input.workerId)) box.activeWorkers.push(input.workerId);
    box.idleSince = null;
    box.state = 'running';
    await this.holdLease(box);
    await this.prepareWorkspace(box.boxId, input.workerId, input.repoUrl);
    this.save(box);
    result.boxId = box.boxId;
    this.daemon(input.tenantId).attach(input.workerId, { workDir: result.workDir });
    return result;
  }

  async release(tenantId: string, workerId: string): Promise<void> {
    this.daemon(tenantId).detach(workerId);
    const box = this.store.tenantBox(tenantId);
    if (!box) return;
    box.activeWorkers = box.activeWorkers.filter((id) => id !== workerId);
    if (box.activeWorkers.length === 0) {
      box.idleSince = this.now();
      await this.dropLease(box);
    } else {
      await this.holdLease(box);
    }
    this.save(box);
  }

  async wake(tenantId: string, workerId: string, mandate?: Mandate): Promise<BoxAcquire> {
    return this.acquire({ tenantId, workerId, mandate });
  }

  async exec(
    tenantId: string,
    workerId: string,
    request: SandboxExecRequest,
  ): Promise<SandboxExecResult> {
    const box = this.store.tenantBox(tenantId);
    if (!box) throw new Error(`No tenant box for ${tenantId}`);
    const refused = refuseCrossWorker(workerId, request);
    if (refused) return refused;
    const workDir = workerWorkDir(workerId);
    const cwd = request.cwd ? resolveWorkerCwd(workerId, request.cwd) : workDir;
    return this.sandbox.exec(box.boxId, {
      ...request,
      cwd,
      env: {
        HOME: workDir,
        npm_config_cache: BOX_NPM_CACHE,
        GIT_TERMINAL_PROMPT: '0',
        ...request.env,
      },
    });
  }

  async tick(at = this.now()): Promise<WatchdogFinding[]> {
    const findings: WatchdogFinding[] = [];
    for (const box of this.store.allTenantBoxes()) {
      if (box.activeWorkers.length > 0) {
        if (box.leaseRenewedAt === null || at - box.leaseRenewedAt >= this.leaseRenewMs) {
          await this.holdLease(box);
          this.save(box);
        }
      } else if (
        box.idleSince !== null &&
        at - box.idleSince >= this.idleMs &&
        (box.state === 'running' || box.state === 'waking')
      ) {
        await this.idleSuspend(box, at);
      }
      const stuck = evaluateTenantBox(box, at, this.stuckAfterMs, this.leaseTtlMs);
      if (stuck) findings.push(stuck);
    }
    return findings;
  }

  private async coldCreate(
    tenantId: string,
    size: { vcpus: number; memMiB: number },
    repoUrl?: string,
  ): Promise<{ box: TenantBoxRecord; ms: number }> {
    const at = this.now();
    const started = at;
    const draft = emptyBox(tenantId, `pending-${tenantId}`, size, this.deleteAfterSeconds, at);
    draft.state = 'creating';
    this.save(draft);
    const boxId = await this.createMachine({
      name: `maka-${tenantId}`.slice(0, 48),
      templateId: this.templateId,
      vcpus: size.vcpus,
      memMiB: size.memMiB,
      deleteAfterSeconds: this.deleteAfterSeconds,
      metadata: { tenantId, role: 'superagent-shared' },
    });
    await this.sandbox.ensureRunning(boxId);
    await this.installBase(boxId, repoUrl);
    const snapshot = await this.snapshotBase(boxId);
    const ms = this.now() - started;
    draft.boxId = boxId;
    draft.state = 'running';
    draft.snapshotId = snapshot;
    draft.lastCreateAt = this.now();
    this.recordTiming(tenantId, 'create', ms);
    this.save(draft);
    return { box: draft, ms };
  }

  private async ensureBox(
    box: TenantBoxRecord,
    workerId: string,
    size: { vcpus: number; memMiB: number },
    repoUrl?: string,
  ): Promise<{
    box: TenantBoxRecord;
    woke: boolean;
    restored: boolean;
    created: boolean;
    wakeMs?: number;
    restoreMs?: number;
    createMs?: number;
  }> {
    const current = await this.sandbox.getMachine(box.boxId).catch(() => ({
      id: box.boxId,
      state: 'unknown',
    }));
    if (isGone(current.state)) {
      return this.rebuild(box, workerId, size, repoUrl);
    }
    if (current.state === 'suspended' || current.state === 'stopped' || box.state === 'suspended') {
      const started = this.now();
      box.state = 'resuming';
      this.save(box);
      await this.speakWaking(box.tenantId, workerId, 'waking the shared box');
      box.state = 'waking';
      this.save(box);
      try {
        await this.sandbox.ensureRunning(box.boxId);
      } catch {
        return this.rebuild(box, workerId, size, repoUrl);
      }
      const wakeMs = this.now() - started;
      box.state = 'running';
      box.lastWakeAt = this.now();
      this.recordTiming(box.tenantId, 'wake', wakeMs);
      await this.speakWaking(box.tenantId, workerId, `woke in ${wakeMs}ms`);
      this.save(box);
      return { box, woke: true, restored: false, created: false, wakeMs };
    }
    if (current.state !== 'running') {
      try {
        await this.sandbox.ensureRunning(box.boxId);
      } catch {
        return this.rebuild(box, workerId, size, repoUrl);
      }
    }
    return { box, woke: false, restored: false, created: false };
  }

  private async rebuild(
    box: TenantBoxRecord,
    workerId: string,
    size: { vcpus: number; memMiB: number },
    repoUrl?: string,
  ): Promise<{
    box: TenantBoxRecord;
    woke: boolean;
    restored: boolean;
    created: boolean;
    wakeMs?: number;
    restoreMs?: number;
    createMs?: number;
  }> {
    box.state = 'rebuilding';
    this.save(box);
    await this.speakWaking(box.tenantId, workerId, 'rebuilding the shared box');
    if (box.snapshotId && this.sandbox.createMachine) {
      const started = this.now();
      try {
        const boxId = await this.createMachine({
          name: `maka-${box.tenantId}-r`.slice(0, 48),
          snapshotId: box.snapshotId,
          vcpus: size.vcpus,
          memMiB: size.memMiB,
          deleteAfterSeconds: this.deleteAfterSeconds,
          metadata: { tenantId: box.tenantId, role: 'superagent-shared' },
        });
        await this.sandbox.ensureRunning(boxId);
        const restoreMs = this.now() - started;
        box.boxId = boxId;
        box.state = 'running';
        box.lastRestoreAt = this.now();
        box.lastWakeAt = this.now();
        this.recordTiming(box.tenantId, 'restore', restoreMs);
        this.save(box);
        return { box, woke: false, restored: true, created: false, restoreMs };
      } catch {
        // Fall through to a fresh create.
      }
    }
    const created = await this.coldCreate(box.tenantId, size, repoUrl);
    created.box.activeWorkers = box.activeWorkers;
    this.save(created.box);
    return {
      box: created.box,
      woke: false,
      restored: false,
      created: true,
      createMs: created.ms,
    };
  }

  private async idleSuspend(box: TenantBoxRecord, at: number): Promise<void> {
    if (this.sandbox.suspend === undefined) return;
    box.state = 'suspending';
    box.updatedAt = at;
    this.save(box);
    await this.dropLease(box);
    try {
      await this.sandbox.suspend(box.boxId);
    } catch {
      this.save(box);
      return;
    }
    box.state = 'suspended';
    box.lastSuspendAt = this.now();
    this.save(box);
  }

  private async installBase(boxId: string, repoUrl?: string): Promise<void> {
    const setup = await this.sandbox.exec(boxId, {
      cmd: `mkdir -p ${BOX_BASE_DIR} ${BOX_NPM_CACHE} ${BOX_WORK_ROOT}`,
    });
    if (setup.exitCode !== 0) throw new Error(`shared box mkdir failed: ${setup.stderr}`);
    const clone = cloneTarget(repoUrl);
    if (clone) {
      const hash = repoHash(clone);
      const dest = `${BOX_BASE_DIR}/${hash}`;
      const cloned = await this.sandbox.exec(boxId, {
        cmd: `if [ ! -d ${shellQuote(dest)}/.git ]; then git clone -- ${shellQuote(clone)} ${shellQuote(dest)}; fi && echo ok > ${BOX_BASE_DIR}/.installed`,
        timeoutSeconds: 120,
      });
      if (cloned.exitCode !== 0) throw new Error(`shared box base clone failed: ${cloned.stderr}`);
    } else {
      await this.sandbox.exec(boxId, { cmd: `echo ok > ${BOX_BASE_DIR}/.installed` });
    }
  }

  private async snapshotBase(boxId: string): Promise<string | null> {
    if (!this.sandbox.createSnapshot) return null;
    const snap = await this.sandbox.createSnapshot(boxId, 'superagent-base');
    if (this.sandbox.waitForSnapshot) await this.sandbox.waitForSnapshot(snap.id);
    return snap.id;
  }

  private async prepareWorkspace(boxId: string, workerId: string, repoUrl?: string): Promise<void> {
    const workDir = workerWorkDir(workerId);
    const clone = cloneTarget(repoUrl);
    if (clone) {
      const dest = `${BOX_BASE_DIR}/${repoHash(clone)}`;
      const added = await this.sandbox.exec(boxId, {
        cmd: `if [ ! -d ${shellQuote(workDir)}/.git ]; then git -C ${shellQuote(dest)} worktree add "$(pwd)/${workDir}"; fi`,
      });
      if (added.exitCode !== 0) {
        await this.sandbox.exec(boxId, { cmd: `mkdir -p ${shellQuote(workDir)}` });
      }
      return;
    }
    await this.sandbox.exec(boxId, { cmd: `mkdir -p ${shellQuote(workDir)}` });
  }

  private async createMachine(request: {
    name?: string;
    templateId?: string;
    snapshotId?: string;
    metadata?: Record<string, string>;
    vcpus?: number;
    memMiB?: number;
    deleteAfterSeconds?: number;
  }): Promise<string> {
    if (!this.sandbox.createMachine) {
      const id = request.name ?? `box-${this.now()}`;
      await this.sandbox.ensureRunning(id);
      return id;
    }
    const created = await this.sandbox.createMachine(request);
    const withMachine = created as { id: string; machineId?: string };
    return withMachine.machineId ?? created.id;
  }

  private async holdLease(box: TenantBoxRecord): Promise<void> {
    if (!this.sandbox.putActivityLease) return;
    const holder = leaseHolder(box.tenantId);
    await this.sandbox.putActivityLease(box.boxId, holder);
    box.leaseHolder = holder;
    box.leaseRenewedAt = this.now();
  }

  private async dropLease(box: TenantBoxRecord): Promise<void> {
    if (!this.sandbox.deleteActivityLease || !box.leaseHolder) {
      box.leaseHolder = null;
      box.leaseRenewedAt = null;
      return;
    }
    await this.sandbox.deleteActivityLease(box.boxId, box.leaseHolder);
    box.leaseHolder = null;
    box.leaseRenewedAt = null;
  }

  private save(box: TenantBoxRecord): void {
    box.updatedAt = this.now();
    this.store.putTenantBox(cloneTenantBox(box));
  }

  private recordTiming(tenantId: string, kind: BoxTimingKind, wallMs: number): void {
    const entry: UsageEntry = {
      tenantId,
      workerId: BOX_TIMING_WORKERS[kind],
      tokens: 0,
      usdMicros: 0,
      wallMs,
      at: this.now(),
    };
    this.store.appendUsageEvent(entry);
    this.recordUsage?.(entry);
  }

  private async speakWaking(tenantId: string, workerId: string, activity: string): Promise<void> {
    if (!this.reportProgress) return;
    await this.reportProgress(tenantId, workerId, { phase: 'waking', activity });
  }
}

export function boxSize(mandate?: Mandate): { vcpus: number; memMiB: number } {
  return {
    vcpus: mandate?.box?.vcpus ?? DEFAULT_SHARED_BOX.vcpus,
    memMiB: mandate?.box?.memMiB ?? DEFAULT_SHARED_BOX.memMiB,
  };
}

export function workerWorkDir(workerId: string): string {
  return `${BOX_WORK_ROOT}/${workerId}`;
}

export function leaseHolder(tenantId: string): string {
  return `tenant:${tenantId}`;
}

export function evaluateTenantBox(
  box: TenantBoxRecord,
  at: number,
  stuckAfterMs = DEFAULT_BOX_STUCK_AFTER_MS,
  leaseTtlMs = DEFAULT_BOX_LEASE_TTL_MS,
): WatchdogFinding | undefined {
  const transitional: TenantBoxState[] = ['suspending', 'resuming'];
  if (transitional.includes(box.state) && at - box.updatedAt > stuckAfterMs) {
    return {
      rule: 'box_stuck',
      tenantId: box.tenantId,
      workerId: tenantBoxWorkerId(box.tenantId),
      action: 'escalate',
      generation: 1,
      detail: `Shared box stuck in ${box.state}.`,
    };
  }
  if (
    box.leaseHolder &&
    box.activeWorkers.length === 0 &&
    box.leaseRenewedAt !== null &&
    at - box.leaseRenewedAt > leaseTtlMs
  ) {
    return {
      rule: 'box_stuck',
      tenantId: box.tenantId,
      workerId: tenantBoxWorkerId(box.tenantId),
      action: 'escalate',
      generation: 1,
      detail: 'Activity lease was not released after the last worker went idle.',
    };
  }
  return undefined;
}

function emptyBox(
  tenantId: string,
  boxId: string,
  size: { vcpus: number; memMiB: number },
  deleteAfterSeconds: number,
  at: number,
): TenantBoxRecord {
  return {
    tenantId,
    boxId,
    state: 'creating',
    snapshotId: null,
    vcpus: size.vcpus,
    memMiB: size.memMiB,
    activeWorkers: [],
    idleSince: null,
    lastWakeAt: null,
    lastSuspendAt: null,
    lastCreateAt: null,
    lastRestoreAt: null,
    leaseHolder: null,
    leaseRenewedAt: null,
    deleteAfterSeconds,
    createdAt: at,
    updatedAt: at,
  };
}

function isGone(state: string): boolean {
  return state === 'unknown' || state === 'deleted' || state === 'gone' || state === 'error';
}

function cloneTarget(repoUrl?: string): string | undefined {
  if (!repoUrl) return undefined;
  if (repoUrl.startsWith('/') || repoUrl.startsWith('file://') || /^https?:\/\//.test(repoUrl)) {
    return repoUrl;
  }
  return undefined;
}

function repoHash(url: string): string {
  return url.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 48) || 'repo';
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function resolveWorkerCwd(workerId: string, cwd: string): string {
  const home = workerWorkDir(workerId);
  if (cwd.includes('..') || cwd.includes('\0')) {
    throw new Error('worker cwd must stay inside its workspace');
  }
  const rel = cwd.replace(/^\//, '');
  if (rel === home || rel.startsWith(`${home}/`)) return rel;
  if (!rel.includes('/')) return `${home}/${rel}`;
  throw new Error('worker cwd must stay inside its workspace');
}

function refuseCrossWorker(
  workerId: string,
  request: SandboxExecRequest,
): SandboxExecResult | undefined {
  const home = workerWorkDir(workerId);
  if (request.cwd && (request.cwd.includes('..') || request.cwd.includes('\0'))) {
    return { stdout: '', stderr: 'cross-worker path refused', exitCode: 1 };
  }
  if (request.cwd) {
    const rel = request.cwd.replace(/^\//, '');
    if (rel !== home && !rel.startsWith(`${home}/`) && rel.includes('/')) {
      return { stdout: '', stderr: 'cross-worker path refused', exitCode: 1 };
    }
  }
  if (/(^|[\s'"=])\.\.\//.test(request.cmd) || /(?:^|[\s'"=])\/work\/(?!$)/.test(request.cmd)) {
    const other = request.cmd.match(/work\/([A-Za-z0-9._-]+)/);
    if (other && other[1] !== workerId) {
      return { stdout: '', stderr: 'cross-worker path refused', exitCode: 1 };
    }
    if (/(^|[\s'"=])\.\.\//.test(request.cmd)) {
      return { stdout: '', stderr: 'cross-worker path refused', exitCode: 1 };
    }
  }
  return undefined;
}
