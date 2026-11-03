import type { SuperagentStore } from './store.js';
import type {
  AdmissionPolicy,
  EventSource,
  IdFactory,
  Mandate,
  NormalizedEvent,
  Subject,
  TenantUsage,
} from './types.js';
import { admitSpawn } from './router.js';

export const TASK_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_SIZES = ['S', 'M', 'L'] as const;
export type TaskSize = (typeof TASK_SIZES)[number];

export const TASK_STATES = ['queued', 'waiting', 'admitted', 'running', 'blocked', 'done'] as const;
export type ScheduledTaskState = (typeof TASK_STATES)[number];

export const DEFAULT_MAX_WORKERS = 4;
export const DEFAULT_RESERVED_HUMAN_SLOTS = 1;
export const DEFAULT_AGE_EVERY_MS = 15 * 60_000;
export const SCHEDULER_DOCUMENT = 'scheduler';

export const PRIORITY_RANK: Record<TaskPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

export const SIZE_COST: Record<TaskSize, { tokens: number; usdMicros: number }> = {
  S: { tokens: 50_000, usdMicros: 50_000 },
  M: { tokens: 200_000, usdMicros: 200_000 },
  L: { tokens: 800_000, usdMicros: 1_000_000 },
};

export type TaskDependency =
  | { kind: 'task'; taskId: string }
  | { kind: 'pr_merged'; repo: string; number: number }
  | { kind: 'ci_green'; repo: string; number?: number; sha?: string };

export type StartCondition =
  | { kind: 'immediate' }
  | { kind: 'time'; at: number }
  | { kind: 'pr_merged'; repo: string; number: number }
  | { kind: 'ci_green'; repo: string; number?: number; sha?: string }
  | { kind: 'label'; repo: string; number: number; label: string };

export interface TenantBudget {
  tokensPerDay?: number;
  usdPerDay?: number;
  concurrentTokens?: number;
  concurrentUsd?: number;
}

export interface SchedulerSettings {
  maxWorkers: number;
  reservedHumanSlots: number;
  ageEveryMs: number;
  budget: TenantBudget;
}

export const DEFAULT_SCHEDULER: SchedulerSettings = {
  maxWorkers: DEFAULT_MAX_WORKERS,
  reservedHumanSlots: DEFAULT_RESERVED_HUMAN_SLOTS,
  ageEveryMs: DEFAULT_AGE_EVERY_MS,
  budget: {},
};

export interface ScheduledTask {
  taskId: string;
  tenantId: string;
  eventId: string;
  subjectKey: string;
  repo?: string;
  title: string;
  mandate: Mandate;
  priority: TaskPriority;
  size: TaskSize;
  dependencies: TaskDependency[];
  footprint: string[];
  start: StartCondition;
  reserved: boolean;
  source: EventSource;
  state: ScheduledTaskState;
  reason?: string;
  queuedAt: number;
  updatedAt: number;
  admittedAt?: number;
  startedAt?: number;
  doneAt?: number;
  workerId?: string;
}

export interface SchedulerFacts {
  merged: string[];
  ciGreen: string[];
  labels: string[];
}

export interface SchedulerLedgerEntry {
  taskId: string;
  state: ScheduledTaskState;
  reason?: string;
  waitMs: number;
  at: number;
}

export interface SchedulerSnapshot {
  tasks: ScheduledTask[];
  facts: SchedulerFacts;
  ledger: SchedulerLedgerEntry[];
}

export interface QueueView {
  taskId: string;
  tenantId: string;
  title: string;
  state: ScheduledTaskState;
  reason?: string;
  waitMs: number;
  priority: TaskPriority;
  size: TaskSize;
  reserved: boolean;
  queuedAt: number;
  repo?: string;
  footprint: string[];
}

export interface SchedulerChange {
  tenantId: string;
  taskId: string;
  state: ScheduledTaskState;
  reason?: string;
  waitMs: number;
  at: number;
}

export interface AdmitContext {
  boxedLive: number;
  wouldBox: boolean;
  tenantUsage: TenantUsage;
  usageEvents: Array<{ tokens: number; usdMicros: number; at: number }>;
  policy: Pick<AdmissionPolicy, 'maxBoxes' | 'spendCapUsd'>;
}

const WORK_RE = /\b(fix|implement|please|can you|ship|open a pr|investigate)\b/iu;
const MAX_LEDGER = 200;

export function emptyFacts(): SchedulerFacts {
  return { merged: [], ciGreen: [], labels: [] };
}

export function emptySnapshot(): SchedulerSnapshot {
  return { tasks: [], facts: emptyFacts(), ledger: [] };
}

export function mergeSettings(partial?: Partial<SchedulerSettings>): SchedulerSettings {
  return {
    maxWorkers: partial?.maxWorkers ?? DEFAULT_SCHEDULER.maxWorkers,
    reservedHumanSlots: partial?.reservedHumanSlots ?? DEFAULT_SCHEDULER.reservedHumanSlots,
    ageEveryMs: partial?.ageEveryMs ?? DEFAULT_SCHEDULER.ageEveryMs,
    budget: { ...DEFAULT_SCHEDULER.budget, ...partial?.budget },
  };
}

export function isHumanEvent(event: NormalizedEvent): boolean {
  return event.source === 'chat' || event.type === 'user_message' || event.type === 'issue_comment';
}

export function estimateSize(event: NormalizedEvent): TaskSize {
  const text = field(event, 'body') || field(event, 'text') || '';
  const files = field(event, 'files')
    .split(',')
    .map((row) => row.trim())
    .filter(Boolean);
  if (text.length > 2_000 || files.length > 8) return 'L';
  if (event.type === 'user_message' || event.type === 'issue_comment') return 'S';
  return 'M';
}

export function estimatePriority(event: NormalizedEvent, reserved: boolean): TaskPriority {
  if (reserved) return 'urgent';
  const text = field(event, 'text') || field(event, 'body') || field(event, 'comment') || '';
  if (/\b(urgent|asap|prod|p0)\b/iu.test(text)) return 'urgent';
  if (WORK_RE.test(text)) return 'high';
  if (event.source === 'timer') return 'low';
  return 'normal';
}

export function estimateFootprint(event: NormalizedEvent, mandate: Mandate): string[] {
  const paths = [
    ...(mandate.scope.paths ?? []),
    ...field(event, 'file')
      .split(',')
      .map((row) => row.trim()),
    ...field(event, 'path')
      .split(',')
      .map((row) => row.trim()),
    ...field(event, 'files')
      .split(',')
      .map((row) => row.trim()),
  ].filter(Boolean);
  return unique(paths);
}

export function normalizeFootprint(path: string): string {
  return path.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

export function pathOverlaps(left: string, right: string): boolean {
  const a = normalizeFootprint(left);
  const b = normalizeFootprint(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (globMatch(a, b) || globMatch(b, a)) return true;
  const aBase = stripGlob(a);
  const bBase = stripGlob(b);
  if (a.includes('*') && (b === aBase || b.startsWith(`${aBase}/`))) return true;
  if (b.includes('*') && (a === bBase || a.startsWith(`${bBase}/`))) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function footprintsOverlap(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  return left.some((a) => right.some((b) => pathOverlaps(a, b)));
}

export function effectiveRank(task: Pick<ScheduledTask, 'priority' | 'queuedAt'>, now: number, ageEveryMs: number): number {
  const base = PRIORITY_RANK[task.priority];
  const boosts = ageEveryMs <= 0 ? 0 : Math.floor(Math.max(0, now - task.queuedAt) / ageEveryMs);
  return Math.min(PRIORITY_RANK.urgent, base + boosts);
}

export function compareTasks(
  a: ScheduledTask,
  b: ScheduledTask,
  now: number,
  ageEveryMs: number,
): number {
  if (a.reserved !== b.reserved) return a.reserved ? -1 : 1;
  const rank = effectiveRank(b, now, ageEveryMs) - effectiveRank(a, now, ageEveryMs);
  if (rank !== 0) return rank;
  return a.queuedAt - b.queuedAt;
}

export function orderTasks(
  tasks: readonly ScheduledTask[],
  now: number,
  ageEveryMs: number,
): ScheduledTask[] {
  return [...tasks].sort((a, b) => compareTasks(a, b, now, ageEveryMs));
}

export function waitMsOf(task: Pick<ScheduledTask, 'queuedAt'>, now: number): number {
  return Math.max(0, now - task.queuedAt);
}

export function startOfUtcDay(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function prKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

export function shaKey(repo: string, sha: string): string {
  return `${repo.toLowerCase()}@${sha.toLowerCase()}`;
}

export function labelKey(repo: string, number: number, label: string): string {
  return `${repo.toLowerCase()}#${number}:${label.toLowerCase()}`;
}

export function queueViewOf(task: ScheduledTask, now: number): QueueView {
  return {
    taskId: task.taskId,
    tenantId: task.tenantId,
    title: task.title,
    state: task.state,
    ...(task.reason ? { reason: task.reason } : {}),
    waitMs: waitMsOf(task, now),
    priority: task.priority,
    size: task.size,
    reserved: task.reserved,
    queuedAt: task.queuedAt,
    ...(task.repo ? { repo: task.repo } : {}),
    footprint: [...task.footprint],
  };
}

export function formatQueueLine(view: QueueView): string {
  const why = view.reason ? `  ${view.reason}` : '';
  return `${view.taskId}  ${view.state}${why}  wait ${formatWait(view.waitMs)}  ${view.priority}/${view.size}${view.reserved ? '  reserved' : ''}  ${view.title}`;
}

export type GateReason =
  | { ok: true }
  | { ok: false; reason: string; state: Exclude<ScheduledTaskState, 'admitted' | 'running' | 'done'> };

export function startGate(task: ScheduledTask, facts: SchedulerFacts, now: number): GateReason {
  const start = task.start;
  if (start.kind === 'immediate') return { ok: true };
  if (start.kind === 'time') {
    return now >= start.at ? { ok: true } : { ok: false, reason: 'start_time', state: 'waiting' };
  }
  if (start.kind === 'pr_merged') {
    return facts.merged.includes(prKey(start.repo, start.number))
      ? { ok: true }
      : { ok: false, reason: 'start_pr_merged', state: 'waiting' };
  }
  if (start.kind === 'ci_green') {
    return ciSatisfied(facts, start)
      ? { ok: true }
      : { ok: false, reason: 'start_ci_green', state: 'waiting' };
  }
  return facts.labels.includes(labelKey(start.repo, start.number, start.label))
    ? { ok: true }
    : { ok: false, reason: 'start_label', state: 'waiting' };
}

export function dependencyGate(task: ScheduledTask, snapshot: SchedulerSnapshot): GateReason {
  for (const dep of task.dependencies) {
    if (dep.kind === 'task') {
      const other = snapshot.tasks.find((row) => row.taskId === dep.taskId);
      if (!other || other.state !== 'done') {
        return { ok: false, reason: `dep_task:${dep.taskId}`, state: 'waiting' };
      }
      continue;
    }
    if (dep.kind === 'pr_merged') {
      if (!snapshot.facts.merged.includes(prKey(dep.repo, dep.number))) {
        return { ok: false, reason: 'dep_pr_merged', state: 'waiting' };
      }
      continue;
    }
    if (!ciSatisfied(snapshot.facts, dep)) {
      return { ok: false, reason: 'dep_ci_green', state: 'waiting' };
    }
  }
  return { ok: true };
}

export function footprintGate(task: ScheduledTask, running: readonly ScheduledTask[]): GateReason {
  if (!task.repo || task.footprint.length === 0) return { ok: true };
  for (const other of running) {
    if (other.taskId === task.taskId) continue;
    if ((other.repo ?? '').toLowerCase() !== task.repo.toLowerCase()) continue;
    if (footprintsOverlap(task.footprint, other.footprint)) {
      return { ok: false, reason: 'footprint', state: 'blocked' };
    }
  }
  return { ok: true };
}

export function budgetGate(
  task: ScheduledTask,
  running: readonly ScheduledTask[],
  ctx: AdmitContext,
  budget: TenantBudget,
  now: number,
): GateReason {
  const cost = SIZE_COST[task.size];
  const day = startOfUtcDay(now);
  const today = ctx.usageEvents.filter((row) => row.at >= day);
  const dayTokens = today.reduce((sum, row) => sum + row.tokens, 0);
  const dayUsd = today.reduce((sum, row) => sum + row.usdMicros, 0);
  const runningCost = running.reduce(
    (sum, row) => {
      const next = SIZE_COST[row.size];
      return { tokens: sum.tokens + next.tokens, usdMicros: sum.usdMicros + next.usdMicros };
    },
    { tokens: 0, usdMicros: 0 },
  );
  const tokensPerDay = budget.tokensPerDay;
  if (tokensPerDay !== undefined && dayTokens + runningCost.tokens + cost.tokens > tokensPerDay) {
    return { ok: false, reason: 'budget_daily', state: 'blocked' };
  }
  const usdPerDay = budget.usdPerDay;
  if (
    usdPerDay !== undefined &&
    dayUsd + runningCost.usdMicros + cost.usdMicros > Math.round(usdPerDay * 1_000_000)
  ) {
    return { ok: false, reason: 'budget_daily', state: 'blocked' };
  }
  if (
    budget.concurrentTokens !== undefined &&
    runningCost.tokens + cost.tokens > budget.concurrentTokens
  ) {
    return { ok: false, reason: 'budget_concurrent', state: 'blocked' };
  }
  if (
    budget.concurrentUsd !== undefined &&
    runningCost.usdMicros + cost.usdMicros > Math.round(budget.concurrentUsd * 1_000_000)
  ) {
    return { ok: false, reason: 'budget_concurrent', state: 'blocked' };
  }
  const spend = admitSpawn({
    boxedLive: ctx.boxedLive,
    wouldBox: ctx.wouldBox,
    tenantUsdMicros: ctx.tenantUsage.usdMicros,
    policy: { spendCapUsd: ctx.policy.spendCapUsd },
  });
  if (!spend.ok) return { ok: false, reason: spend.reason, state: 'blocked' };
  return { ok: true };
}

export function boxGate(ctx: AdmitContext): GateReason {
  const boxes = admitSpawn({
    boxedLive: ctx.boxedLive,
    wouldBox: ctx.wouldBox,
    tenantUsdMicros: 0,
    policy: { maxBoxes: ctx.policy.maxBoxes },
  });
  if (!boxes.ok) return { ok: false, reason: boxes.reason, state: 'queued' };
  return { ok: true };
}

export function noteEventOnFacts(facts: SchedulerFacts, event: NormalizedEvent): SchedulerFacts {
  const next: SchedulerFacts = {
    merged: [...facts.merged],
    ciGreen: [...facts.ciGreen],
    labels: [...facts.labels],
  };
  const repo = event.subject?.repo;
  const number = event.subject?.number;
  if (event.type === 'ci_passed' && repo) {
    if (number !== undefined) pushUnique(next.ciGreen, prKey(repo, number));
    const sha = field(event, 'sha');
    if (sha) pushUnique(next.ciGreen, shaKey(repo, sha));
  }
  if ((event.type === 'pr_closed' || event.type === 'pr_updated') && repo && number !== undefined) {
    if (field(event, 'merged') === 'true') pushUnique(next.merged, prKey(repo, number));
  }
  if (repo && number !== undefined) {
    const added = field(event, 'label');
    if (added) pushUnique(next.labels, labelKey(repo, number, added));
    for (const label of field(event, 'labels')
      .split(',')
      .map((row) => row.trim())
      .filter(Boolean)) {
      pushUnique(next.labels, labelKey(repo, number, label));
    }
  }
  return next;
}

export class Scheduler {
  constructor(
    private readonly store: SuperagentStore,
    private readonly ids: IdFactory,
    private readonly now: () => number,
    private readonly settings: SchedulerSettings,
    private readonly onChange?: (change: SchedulerChange) => void,
  ) {}

  load(tenantId: string): SchedulerSnapshot {
    const raw = this.store.getDocument(tenantId, SCHEDULER_DOCUMENT);
    if (!raw) return emptySnapshot();
    try {
      const parsed = JSON.parse(raw) as SchedulerSnapshot;
      return {
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map(cloneTask) : [],
        facts: parsed.facts ?? emptyFacts(),
        ledger: Array.isArray(parsed.ledger) ? parsed.ledger.map((row) => ({ ...row })) : [],
      };
    } catch {
      return emptySnapshot();
    }
  }

  save(tenantId: string, snapshot: SchedulerSnapshot): void {
    this.store.putDocument(tenantId, SCHEDULER_DOCUMENT, JSON.stringify(snapshot), this.now());
  }

  tasks(tenantId: string): ScheduledTask[] {
    return this.load(tenantId).tasks;
  }

  task(tenantId: string, taskId: string): ScheduledTask | undefined {
    return this.tasks(tenantId).find((row) => row.taskId === taskId);
  }

  views(tenantId: string, now = this.now()): QueueView[] {
    return this.tasks(tenantId)
      .filter((row) => row.state !== 'done')
      .map((row) => queueViewOf(row, now));
  }

  allViews(now = this.now()): QueueView[] {
    const seen = new Set<string>();
    const views: QueueView[] = [];
    for (const worker of this.store.allWorkers()) {
      if (seen.has(worker.tenantId)) continue;
      seen.add(worker.tenantId);
      views.push(...this.views(worker.tenantId, now));
    }
    for (const tenantId of this.knownTenants()) {
      if (seen.has(tenantId)) continue;
      seen.add(tenantId);
      views.push(...this.views(tenantId, now));
    }
    return views;
  }

  enqueue(input: {
    tenantId: string;
    eventId: string;
    subject: Subject;
    title: string;
    mandate: Mandate;
    priority?: TaskPriority;
    size?: TaskSize;
    dependencies?: TaskDependency[];
    footprint?: string[];
    start?: StartCondition;
    reserved?: boolean;
    source?: EventSource;
  }): ScheduledTask {
    const at = this.now();
    const snapshot = this.load(input.tenantId);
    const task: ScheduledTask = {
      taskId: this.ids.task(),
      tenantId: input.tenantId,
      eventId: input.eventId,
      subjectKey: input.subject.key,
      repo: input.subject.repo,
      title: input.title,
      mandate: input.mandate,
      priority: input.priority ?? 'normal',
      size: input.size ?? 'M',
      dependencies: input.dependencies ?? [],
      footprint: input.footprint ?? [],
      start: input.start ?? { kind: 'immediate' },
      reserved: input.reserved === true,
      source: input.source ?? 'internal',
      state: 'queued',
      queuedAt: at,
      updatedAt: at,
    };
    snapshot.tasks.push(task);
    this.record(snapshot, task, at);
    this.save(input.tenantId, snapshot);
    return cloneTask(task);
  }

  noteEvent(event: NormalizedEvent): void {
    const snapshot = this.load(event.tenantId);
    snapshot.facts = noteEventOnFacts(snapshot.facts, event);
    this.save(event.tenantId, snapshot);
  }

  markDone(tenantId: string, workerId: string): ScheduledTask | undefined {
    const snapshot = this.load(tenantId);
    const task = snapshot.tasks.find((row) => row.workerId === workerId && row.state !== 'done');
    if (!task) return undefined;
    const at = this.now();
    this.setState(task, 'done', undefined, at);
    this.record(snapshot, task, at);
    this.save(tenantId, snapshot);
    return cloneTask(task);
  }

  /**
   * Recompute waiting reasons and return tasks that may start now, in fair order.
   * Caller starts the worker and calls `markRunning`.
   */
  pickAdmittable(tenantId: string, ctx: AdmitContext): ScheduledTask[] {
    const snapshot = this.load(tenantId);
    const at = this.now();
    const picked: ScheduledTask[] = [];
    let dirty = false;

    const refresh = (): void => {
      for (const task of snapshot.tasks) {
        if (task.state === 'done' || task.state === 'running' || task.state === 'admitted') continue;
        const gate = this.gate(task, snapshot, ctx, at);
        if (gate.ok) continue;
        if (task.state !== gate.state || task.reason !== gate.reason) {
          this.setState(task, gate.state, gate.reason, at);
          this.record(snapshot, task, at);
          dirty = true;
        }
      }
    };

    refresh();

    while (true) {
      const live = snapshot.tasks.filter(
        (row) => row.state === 'running' || row.state === 'admitted',
      );
      if (live.length >= this.settings.maxWorkers) break;
      const reservedWaiting = snapshot.tasks.some(
        (row) =>
          row.reserved &&
          row.state !== 'done' &&
          row.state !== 'running' &&
          row.state !== 'admitted' &&
          this.gate(row, snapshot, ctx, at).ok,
      );
      const backgroundLive = live.filter((row) => !row.reserved).length;
      const backgroundCap = Math.max(0, this.settings.maxWorkers - this.settings.reservedHumanSlots);
      const eligible = orderTasks(
        snapshot.tasks.filter((row) => {
          if (row.state === 'done' || row.state === 'running' || row.state === 'admitted') {
            return false;
          }
          if (!this.gate(row, snapshot, ctx, at).ok) return false;
          if (!row.reserved && reservedWaiting && backgroundLive >= backgroundCap) return false;
          return true;
        }),
        at,
        this.settings.ageEveryMs,
      );
      const next = eligible[0];
      if (!next) {
        if (reservedWaiting) {
          for (const task of snapshot.tasks) {
            if (task.reserved || task.state === 'done' || task.state === 'running') continue;
            if (this.gate(task, snapshot, ctx, at).ok) {
              this.setState(task, 'queued', 'reserved_slot', at);
              this.record(snapshot, task, at);
              dirty = true;
            }
          }
        }
        break;
      }
      this.setState(next, 'admitted', undefined, at);
      next.admittedAt = at;
      this.record(snapshot, next, at);
      picked.push(cloneTask(next));
      dirty = true;
    }

    if (dirty) this.save(tenantId, snapshot);
    return picked;
  }

  markRunning(tenantId: string, taskId: string, workerId: string): ScheduledTask | undefined {
    const snapshot = this.load(tenantId);
    const task = snapshot.tasks.find((row) => row.taskId === taskId);
    if (!task) return undefined;
    const at = this.now();
    this.setState(task, 'running', undefined, at);
    task.workerId = workerId;
    task.startedAt = at;
    this.record(snapshot, task, at);
    this.save(tenantId, snapshot);
    return cloneTask(task);
  }

  markBlocked(tenantId: string, taskId: string, reason: string): ScheduledTask | undefined {
    const snapshot = this.load(tenantId);
    const task = snapshot.tasks.find((row) => row.taskId === taskId);
    if (!task) return undefined;
    const at = this.now();
    this.setState(task, 'blocked', reason, at);
    this.record(snapshot, task, at);
    this.save(tenantId, snapshot);
    return cloneTask(task);
  }

  tenants(): string[] {
    return this.knownTenants();
  }

  private gate(
    task: ScheduledTask,
    snapshot: SchedulerSnapshot,
    ctx: AdmitContext,
    at: number,
  ): GateReason {
    const start = startGate(task, snapshot.facts, at);
    if (!start.ok) return start;
    const deps = dependencyGate(task, snapshot);
    if (!deps.ok) return deps;
    const boxes = boxGate(ctx);
    if (!boxes.ok) return boxes;
    const live = snapshot.tasks.filter((row) => row.state === 'running' || row.state === 'admitted');
    const budget = budgetGate(task, live, ctx, this.settings.budget, at);
    if (!budget.ok) return budget;
    const footprint = footprintGate(task, live);
    if (!footprint.ok) return footprint;
    if (live.length >= this.settings.maxWorkers) {
      return { ok: false, reason: 'slot', state: 'queued' };
    }
    return { ok: true };
  }

  private setState(
    task: ScheduledTask,
    state: ScheduledTaskState,
    reason: string | undefined,
    at: number,
  ): void {
    task.state = state;
    if (reason) task.reason = reason;
    else delete task.reason;
    task.updatedAt = at;
    if (state === 'done') task.doneAt = at;
  }

  private record(snapshot: SchedulerSnapshot, task: ScheduledTask, at: number): void {
    const entry: SchedulerLedgerEntry = {
      taskId: task.taskId,
      state: task.state,
      ...(task.reason ? { reason: task.reason } : {}),
      waitMs: waitMsOf(task, at),
      at,
    };
    snapshot.ledger = [...snapshot.ledger, entry].slice(-MAX_LEDGER);
    this.onChange?.({
      tenantId: task.tenantId,
      taskId: task.taskId,
      state: task.state,
      ...(task.reason ? { reason: task.reason } : {}),
      waitMs: entry.waitMs,
      at,
    });
  }

  private knownTenants(): string[] {
    const ids = new Set<string>(this.store.listDocumentTenants(SCHEDULER_DOCUMENT));
    for (const worker of this.store.allWorkers()) ids.add(worker.tenantId);
    return [...ids];
  }
}

function ciSatisfied(
  facts: SchedulerFacts,
  dep: { repo: string; number?: number; sha?: string },
): boolean {
  if (dep.number !== undefined && facts.ciGreen.includes(prKey(dep.repo, dep.number))) return true;
  if (dep.sha && facts.ciGreen.includes(shaKey(dep.repo, dep.sha))) return true;
  return false;
}

function cloneTask(task: ScheduledTask): ScheduledTask {
  return {
    ...task,
    mandate: {
      ...task.mandate,
      scope: { repos: [...task.mandate.scope.repos], paths: task.mandate.scope.paths?.slice() },
      budgets: { ...task.mandate.budgets },
    },
    dependencies: task.dependencies.map((row) => ({ ...row })),
    footprint: [...task.footprint],
    start: { ...task.start },
  };
}

function field(event: NormalizedEvent, label: string): string {
  return event.fields.find(([name]) => name === label)?.[1] ?? '';
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((row) => row.trim()).filter(Boolean))];
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function stripGlob(path: string): string {
  return normalizeFootprint(path).replace(/\/\*\*?$/, '');
}

function globMatch(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return false;
  const escaped = normalizeFootprint(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ':::GLOBSTAR:::')
    .replace(/\*/g, '[^/]*')
    .replace(/:::GLOBSTAR:::/g, '.*');
  return new RegExp(`^${escaped}$`).test(normalizeFootprint(value));
}

function formatWait(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}
