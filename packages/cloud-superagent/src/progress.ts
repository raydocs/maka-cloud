import type { SuperagentStore } from './store.js';
import type { UsageEntry, WorkerRecord, WorkerState } from './types.js';

export const PROGRESS_PHASES = [
  'materialize',
  'edit',
  'install',
  'test',
  'push',
  'pr',
  'ci-wait',
  'review-wait',
  'merge-held',
] as const;

export type ProgressPhase = (typeof PROGRESS_PHASES)[number];

export const WAITING_PHASES = ['ci-wait', 'review-wait', 'merge-held'] as const;
export type WaitingPhase = (typeof WAITING_PHASES)[number];

export const WAITING_KINDS = ['ci', 'review', 'human'] as const;
export type WaitingKind = (typeof WAITING_KINDS)[number];

export const PROGRESS_LOOKS = ['running', 'waiting', 'stuck', 'paused', 'done'] as const;
export type ProgressLook = (typeof PROGRESS_LOOKS)[number];

export const DEFAULT_PHASE_MS: Record<ProgressPhase, number> = {
  materialize: 60_000,
  edit: 15 * 60_000,
  install: 5 * 60_000,
  test: 10 * 60_000,
  push: 30_000,
  pr: 20_000,
  'ci-wait': 15 * 60_000,
  'review-wait': 60 * 60_000,
  'merge-held': 24 * 60 * 60_000,
};

export const DEFAULT_STILL_EVERY_MS = 5 * 60_000;
export const DEFAULT_STUCK_MARGIN = 0.5;
const MAX_SAMPLES = 20;

export interface ProgressSettings {
  stillEveryMs: number;
  stuckMargin: number;
}

export const DEFAULT_PROGRESS: ProgressSettings = {
  stillEveryMs: DEFAULT_STILL_EVERY_MS,
  stuckMargin: DEFAULT_STUCK_MARGIN,
};

export interface WaitingOn {
  kind: WaitingKind;
  detail: string;
}

export interface WorkerProgress {
  phases: ProgressPhase[];
  index: number;
  phase: ProgressPhase;
  startedAt: number;
  phaseStartedAt: number;
  heartbeatAt: number;
  lastActivity: string;
  waiting?: WaitingOn;
  lastLeadAt?: number;
  lastLeadKind?: 'phase' | 'still' | 'stuck';
  stuckSpoken?: boolean;
  samples?: Partial<Record<ProgressPhase, number[]>>;
}

export interface ProgressPatch {
  phases?: readonly ProgressPhase[];
  phase?: ProgressPhase;
  activity?: string;
  waiting?: WaitingOn | null;
  heartbeat?: boolean;
}

export interface ProgressView {
  workerId: string;
  tenantId: string;
  state: WorkerState;
  phase: ProgressPhase;
  k: number;
  n: number;
  percent: number;
  elapsedMs: number;
  etaMs: number;
  lastActivity: string;
  heartbeatAt: number;
  look: ProgressLook;
  waiting?: WaitingOn;
}

export interface StatusSnapshot {
  at: number;
  workers: ProgressView[];
  /** Conversational watchdog answer when the progress API was asked. */
  watchdog?: {
    text: string;
    citations: string[];
    source: 'model' | 'fallback';
    action?: { kind: string; ok: boolean; workerId?: string; reason?: string };
  };
}

export function isProgressPhase(value: string): value is ProgressPhase {
  return (PROGRESS_PHASES as readonly string[]).includes(value);
}

export function isWaitingPhase(phase: ProgressPhase): phase is WaitingPhase {
  return (WAITING_PHASES as readonly string[]).includes(phase);
}

export function defaultPhases(
  opts: { publish?: boolean; install?: boolean } = {},
): ProgressPhase[] {
  const core: ProgressPhase[] = ['materialize', 'edit'];
  if (opts.install !== false) core.push('install');
  core.push('test');
  if (opts.publish === false) return core;
  return [...core, 'push', 'pr', 'ci-wait', 'review-wait', 'merge-held'];
}

export function startProgress(
  at: number,
  phases: readonly ProgressPhase[] = defaultPhases(),
): WorkerProgress {
  const list = phases.length > 0 ? [...phases] : [...PROGRESS_PHASES];
  const phase = list[0] ?? 'materialize';
  return {
    phases: list,
    index: 0,
    phase,
    startedAt: at,
    phaseStartedAt: at,
    heartbeatAt: at,
    lastActivity: phase,
  };
}

export function cloneProgress(progress: WorkerProgress): WorkerProgress {
  return {
    ...progress,
    phases: [...progress.phases],
    waiting: progress.waiting ? { ...progress.waiting } : undefined,
    samples: progress.samples
      ? Object.fromEntries(
          Object.entries(progress.samples).map(([phase, rows]) => [phase, [...(rows ?? [])]]),
        )
      : undefined,
  };
}

export function applyProgressPatch(
  current: WorkerProgress | undefined,
  patch: ProgressPatch,
  at: number,
): { progress: WorkerProgress; phaseChanged: boolean } {
  const base = current
    ? cloneProgress(current)
    : startProgress(at, patch.phases ?? defaultPhases());
  if (patch.phases && patch.phases.length > 0) {
    base.phases = [...patch.phases];
    if (!base.phases.includes(base.phase)) {
      base.phase = base.phases[0] ?? 'materialize';
      base.index = 0;
    } else {
      base.index = Math.max(0, base.phases.indexOf(base.phase));
    }
  }
  let phaseChanged = current === undefined;
  if (patch.phase && patch.phase !== base.phase) {
    if (current) recordSample(base, current.phase, at - current.phaseStartedAt);
    const index = base.phases.indexOf(patch.phase);
    if (index >= 0) base.index = index;
    else {
      base.phases = [...base.phases, patch.phase];
      base.index = base.phases.length - 1;
    }
    base.phase = patch.phase;
    base.phaseStartedAt = at;
    base.stuckSpoken = false;
    phaseChanged = true;
  } else if (patch.phase) {
    const index = base.phases.indexOf(patch.phase);
    if (index >= 0) base.index = index;
    base.phase = patch.phase;
  }
  if (patch.activity !== undefined) base.lastActivity = clipActivity(patch.activity);
  if (patch.waiting === null) delete base.waiting;
  else if (patch.waiting) base.waiting = { ...patch.waiting };
  else if (isWaitingPhase(base.phase) && !base.waiting) {
    base.waiting = waitingOf(base.phase);
  }
  if (phaseChanged && isWaitingPhase(base.phase) && !base.waiting) {
    base.waiting = waitingOf(base.phase);
  }
  if (phaseChanged && !isWaitingPhase(base.phase)) delete base.waiting;
  base.heartbeatAt = at;
  return { progress: base, phaseChanged };
}

export function waitingOf(phase: WaitingPhase): WaitingOn {
  if (phase === 'ci-wait') return { kind: 'ci', detail: 'CI' };
  if (phase === 'review-wait') return { kind: 'review', detail: 'review' };
  return { kind: 'human', detail: 'owner approval' };
}

export function progressWaiting(worker: Pick<WorkerRecord, 'progress'>): boolean {
  return worker.progress?.waiting !== undefined;
}

export function historicalPhaseMs(
  store: SuperagentStore,
  tenantId: string,
  phase: ProgressPhase,
): number | undefined {
  const samples: number[] = [];
  for (const worker of store.allWorkers()) {
    if (worker.tenantId !== tenantId) continue;
    const rows = worker.progress?.samples?.[phase];
    if (rows) samples.push(...rows.filter((ms) => ms > 0));
  }
  if (samples.length === 0) return undefined;
  return median(samples);
}

/** Ledger wallMs is unphased; use it only as a weak prior when no samples exist. */
export function ledgerFallbackMs(
  events: readonly UsageEntry[],
  phase: ProgressPhase,
): number | undefined {
  if (events.length < 3) return undefined;
  const mean = events.reduce((sum, row) => sum + row.wallMs, 0) / events.length;
  const fallback = DEFAULT_PHASE_MS[phase];
  if (!(mean > 0) || mean >= fallback * 4) return undefined;
  return Math.round((mean + fallback) / 2);
}

export function estimatePhaseMs(
  store: SuperagentStore,
  tenantId: string,
  phase: ProgressPhase,
): number {
  return (
    historicalPhaseMs(store, tenantId, phase) ??
    ledgerFallbackMs(store.usageEvents(tenantId), phase) ??
    DEFAULT_PHASE_MS[phase]
  );
}

export function remainingEtaMs(
  store: SuperagentStore,
  tenantId: string,
  progress: WorkerProgress,
  at: number,
): number {
  const phaseElapsed = Math.max(0, at - progress.phaseStartedAt);
  const current = estimatePhaseMs(store, tenantId, progress.phase);
  const currentLeft = Math.max(0, current - phaseElapsed);
  let rest = 0;
  for (const phase of progress.phases.slice(progress.index + 1)) {
    rest += estimatePhaseMs(store, tenantId, phase);
  }
  return currentLeft + rest;
}

export function progressPercent(progress: WorkerProgress, at: number, phaseEtaMs: number): number {
  const n = Math.max(1, progress.phases.length);
  const fraction =
    phaseEtaMs <= 0 ? 0 : Math.min(0.95, Math.max(0, at - progress.phaseStartedAt) / phaseEtaMs);
  return Math.min(99, Math.round(((progress.index + fraction) / n) * 100));
}

export function progressLook(
  worker: Pick<WorkerRecord, 'state' | 'progress' | 'lastHeartbeatAt' | 'lastProgressAt'>,
  at: number,
  opts: {
    heartbeatAfterMs: number;
    stallAfterMs: number;
    phaseEtaMs: number;
    stuckMargin: number;
  },
): ProgressLook {
  if (worker.state === 'retired' || worker.state === 'retiring') return 'done';
  if (worker.state === 'paused') return 'paused';
  if (worker.state === 'stuck') return 'stuck';
  if (worker.progress?.waiting || (worker.progress && isWaitingPhase(worker.progress.phase))) {
    return 'waiting';
  }
  if (looksStuck(worker, at, opts)) return 'stuck';
  return 'running';
}

export function looksStuck(
  worker: Pick<WorkerRecord, 'state' | 'progress' | 'lastHeartbeatAt' | 'lastProgressAt'>,
  at: number,
  opts: {
    heartbeatAfterMs: number;
    stallAfterMs: number;
    phaseEtaMs: number;
    stuckMargin: number;
  },
): boolean {
  if (worker.state === 'paused' || worker.state === 'retired' || worker.state === 'retiring') {
    return false;
  }
  if (worker.state === 'stuck') return true;
  const progress = worker.progress;
  if (!progress) return false;
  if (progress.waiting || isWaitingPhase(progress.phase)) return false;
  const marginMs = Math.max(0, opts.phaseEtaMs * opts.stuckMargin);
  const pastEta = at > progress.phaseStartedAt + opts.phaseEtaMs + marginMs;
  if (!pastEta) return false;
  const noHeartbeat = at - (progress.heartbeatAt || worker.lastHeartbeatAt) > opts.heartbeatAfterMs;
  const noProgress =
    at - worker.lastProgressAt > Math.min(opts.stallAfterMs, opts.phaseEtaMs + marginMs);
  return noHeartbeat || noProgress;
}

export function viewOf(
  worker: WorkerRecord,
  at: number,
  store: SuperagentStore,
  settings: ProgressSettings,
  watchdog: { heartbeatAfterMs: number; stallAfterMs: number },
): ProgressView {
  const progress = worker.progress ?? startProgress(worker.createdAt);
  const phaseEtaMs = estimatePhaseMs(store, worker.tenantId, progress.phase);
  const look = progressLook(worker, at, {
    ...watchdog,
    phaseEtaMs,
    stuckMargin: settings.stuckMargin,
  });
  const waiting =
    look === 'waiting' ? (progress.waiting ?? waitingOfFallback(progress.phase)) : undefined;
  return {
    workerId: worker.workerId,
    tenantId: worker.tenantId,
    state: worker.state,
    phase: progress.phase,
    k: progress.index + 1,
    n: Math.max(1, progress.phases.length),
    percent: look === 'done' ? 100 : progressPercent(progress, at, phaseEtaMs),
    elapsedMs: Math.max(0, at - progress.startedAt),
    etaMs: look === 'done' ? 0 : remainingEtaMs(store, worker.tenantId, progress, at),
    lastActivity: progress.lastActivity,
    heartbeatAt: progress.heartbeatAt,
    look,
    ...(waiting ? { waiting } : {}),
  };
}

export function statusSnapshotOf(
  store: SuperagentStore,
  at: number,
  settings: ProgressSettings,
  watchdog: { heartbeatAfterMs: number; stallAfterMs: number },
  tenantId?: string,
): StatusSnapshot {
  const workers = store
    .allWorkers()
    .filter((row) => (tenantId === undefined || row.tenantId === tenantId) && row.retiredAt == null)
    .map((row) => viewOf(row, at, store, settings, watchdog));
  return { at, workers };
}

export type LeadProgressKind = 'phase' | 'still' | 'stuck';

export function nextLeadKind(
  previous: WorkerProgress | undefined,
  next: WorkerProgress,
  view: ProgressView,
  at: number,
  settings: ProgressSettings,
  phaseChanged: boolean,
): LeadProgressKind | undefined {
  if (view.look === 'stuck' && !next.stuckSpoken) return 'stuck';
  if (phaseChanged) return 'phase';
  if (view.look === 'done' || view.look === 'paused') return undefined;
  const last = next.lastLeadAt ?? previous?.lastLeadAt ?? next.startedAt;
  const longEnough = at - next.phaseStartedAt >= settings.stillEveryMs;
  const quietEnough = at - last >= settings.stillEveryMs;
  if (longEnough && quietEnough) return 'still';
  return undefined;
}

export function formatLeadProgress(kind: LeadProgressKind, view: ProgressView): string {
  if (kind === 'phase') {
    if (view.look === 'waiting' && view.waiting) {
      return `waiting on ${view.waiting.kind}: ${view.waiting.detail}`;
    }
    return `${view.phase} ${view.k}/${view.n} (${view.percent}%)`;
  }
  if (kind === 'still') {
    const verb =
      view.look === 'waiting' ? `waiting on ${view.waiting?.kind ?? view.phase}` : view.phase;
    return `still ${verb}, did ${view.lastActivity}`;
  }
  return `looks stuck: ${view.phase} ${view.k}/${view.n}, last ${view.lastActivity}`;
}

export function formatProgressBar(percent: number, width = 20): string {
  const clamped = Math.min(100, Math.max(0, percent));
  const filled = Math.round((clamped / 100) * width);
  return `[${'#'.repeat(filled)}${'.'.repeat(Math.max(0, width - filled))}]`;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

export function formatProgressLine(view: ProgressView): string {
  if (view.look === 'waiting' && view.waiting) {
    return `${view.workerId}  waiting on ${view.waiting.kind}: ${view.waiting.detail}  last: ${view.lastActivity}`;
  }
  if (view.look === 'stuck') {
    return `${view.workerId}  looks stuck  ${view.phase} ${view.k}/${view.n}  last: ${view.lastActivity}`;
  }
  if (view.look === 'paused') {
    return `${view.workerId}  paused  ${view.phase} ${view.k}/${view.n}`;
  }
  if (view.look === 'done') {
    return `${view.workerId}  done`;
  }
  return `${view.workerId}  ${formatProgressBar(view.percent)} ${view.percent}%  ${view.k}/${view.n} ${view.phase}  ${formatElapsed(view.elapsedMs)}  eta ${formatElapsed(view.etaMs)}  last: ${view.lastActivity}`;
}

export function formatStatusText(snapshot: StatusSnapshot): string {
  if (snapshot.workers.length === 0) return 'no live workers';
  return snapshot.workers.map(formatProgressLine).join('\n');
}

export function encodeProgressSse(snapshot: StatusSnapshot, id = 1): string {
  return `id: ${id}\nevent: progress\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

export function wantsProgressSse(url: string, accept?: string): boolean {
  if (/\btext\/event-stream\b/i.test(accept ?? '')) return true;
  try {
    const parsed = new URL(url, 'http://superagent.local');
    return parsed.searchParams.get('stream') === '1' || parsed.searchParams.has('sse');
  } catch {
    return /[?&](stream=1|sse)\b/.test(url);
  }
}

function waitingOfFallback(phase: ProgressPhase): WaitingOn | undefined {
  return isWaitingPhase(phase) ? waitingOf(phase) : undefined;
}

function recordSample(progress: WorkerProgress, phase: ProgressPhase, ms: number): void {
  if (ms <= 0) return;
  const samples = { ...(progress.samples ?? {}) };
  const rows = [...(samples[phase] ?? []), ms].slice(-MAX_SAMPLES);
  samples[phase] = rows;
  progress.samples = samples;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const a = sorted[mid] ?? 0;
  if (sorted.length % 2 === 1) return a;
  return Math.round((a + (sorted[mid - 1] ?? a)) / 2);
}

function clipActivity(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}
