import type { ProgressPatch } from './progress.js';
import type { SandboxExecRequest, SandboxExecResult, SandboxPort } from './sandbox.js';
import type {
  HandlerResult,
  NormalizedEvent,
  Usage,
  WorkerContext,
  WorkerHandler,
  WorkerRecord,
} from './types.js';

/** Immediate progress-view ack when a message arrives mid-run. */
export const DUPLEX_ACK = 'received, will apply at next step';

export const PREEMPT_TYPES = new Set(['user_cancel', 'watchdog_cancel', 'user_correct']);

export const SEEN_EVENT_CAP = 64;

export type ToolStartResult = { status: 'started'; jobId: string };

export type PreemptKind = 'cancel' | 'correct';

export interface DuplexToolJob {
  jobId: string;
  cmd: string;
  startedAt: number;
  result?: SandboxExecResult;
  cancelled?: boolean;
}

export type DuplexStep =
  | {
      kind: 'tool';
      cmd: string;
      machineId?: string;
      memory?: string;
      plan?: string;
      progressUpdate?: ProgressPatch;
      usage?: Partial<Usage>;
    }
  | {
      kind: 'wait';
      memory?: string;
      plan?: string;
      progressUpdate?: ProgressPatch;
    }
  | {
      kind: 'done';
      memory?: string;
      plan?: string;
      progressUpdate?: ProgressPatch;
      usage?: Partial<Usage>;
      /** When set, the loop returns this result instead of a progress-only ack. */
      result?: HandlerResult;
    };

export interface DuplexContext {
  worker: WorkerRecord;
  event: NormalizedEvent;
  applied: NormalizedEvent[];
  jobs: Map<string, DuplexToolJob>;
  recall: () => string;
  sandbox: SandboxPort;
  pollInbox: () => NormalizedEvent[];
}

export interface DuplexProvider {
  next(ctx: DuplexContext): Promise<DuplexStep>;
}

export interface DuplexLoopOptions {
  wait?: () => Promise<void>;
  now?: () => number;
  maxSteps?: number;
}

export function eventField(event: NormalizedEvent, name: string): string {
  return event.fields.find(([key]) => key === name)?.[1] ?? '';
}

export function isPreemptEvent(event: NormalizedEvent): boolean {
  if (PREEMPT_TYPES.has(event.type)) return true;
  const text = (eventField(event, 'text') || eventField(event, 'comment')).trim();
  if (/^(cancel|abort|stop(\s+this)?(\s+now)?|never mind)\b/i.test(text)) return true;
  if (/^(correction|instead)\s*:/i.test(text)) return true;
  return false;
}

export function preemptKind(event: NormalizedEvent): PreemptKind {
  if (event.type === 'user_correct') return 'correct';
  if (event.type === 'user_cancel' || event.type === 'watchdog_cancel') return 'cancel';
  const text = (eventField(event, 'text') || eventField(event, 'comment')).trim();
  if (/^(correction|instead)\s*:/i.test(text)) return 'correct';
  return 'cancel';
}

export function isToolStart(value: unknown): value is ToolStartResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { status?: unknown }).status === 'started' &&
    typeof (value as { jobId?: unknown }).jobId === 'string'
  );
}

export function orderInbox(events: readonly NormalizedEvent[]): NormalizedEvent[] {
  const preempts = events.filter(isPreemptEvent).sort(byArrival);
  const rest = events.filter((event) => !isPreemptEvent(event)).sort(byArrival);
  return [...preempts, ...rest];
}

export async function startSandboxTool(
  sandbox: SandboxPort,
  machineId: string,
  request: SandboxExecRequest,
): Promise<ToolStartResult | SandboxExecResult> {
  const extra = sandbox as SandboxPort & {
    start?: (id: string, req: SandboxExecRequest) => Promise<ToolStartResult | SandboxExecResult>;
  };
  if (typeof extra.start === 'function') return extra.start(machineId, request);
  return sandbox.exec(machineId, request);
}

export function pollSandboxJob(sandbox: SandboxPort, jobId: string): DuplexToolJob | undefined {
  const extra = sandbox as SandboxPort & { jobs?: Map<string, DuplexToolJob> };
  return extra.jobs?.get(jobId);
}

export function rememberEventIds(
  current: readonly string[] | undefined,
  extra: readonly string[],
): string[] {
  return [...new Set([...(current ?? []), ...extra])].slice(-SEEN_EVENT_CAP);
}

/** Async ReAct worker: inbox is applied at the next step boundary. */
export class DuplexLoop implements WorkerHandler {
  readonly applied: NormalizedEvent[] = [];
  readonly steps: DuplexStep[] = [];

  constructor(
    readonly provider: DuplexProvider,
    readonly options: DuplexLoopOptions = {},
  ) {}

  async handle(ctx: WorkerContext, event: NormalizedEvent): Promise<HandlerResult> {
    const applied: NormalizedEvent[] = [];
    const jobs = new Map<string, DuplexToolJob>();
    const seen = new Set(ctx.worker.seenEventIds ?? []);

    const take = (incoming: NormalizedEvent): boolean => {
      if (seen.has(incoming.eventId)) return false;
      seen.add(incoming.eventId);
      applied.push(incoming);
      this.applied.push(incoming);
      ctx.ackInbox?.([incoming.eventId]);
      return true;
    };

    take(event);

    const view = (): DuplexContext => ({
      worker: ctx.worker,
      event,
      applied: [...applied],
      jobs,
      recall: ctx.recall,
      sandbox: ctx.sandbox,
      pollInbox: () => ctx.pollInbox?.() ?? [],
    });

    let memory = ctx.worker.memory;
    let plan = ctx.worker.plan;
    let progressUpdate: ProgressPatch | undefined;
    let usage: Partial<Usage> | undefined;
    const maxSteps = this.options.maxSteps ?? 64;

    for (let i = 0; i < maxSteps; i += 1) {
      const incoming = orderInbox(ctx.pollInbox?.() ?? []);
      for (const row of incoming) {
        if (!take(row)) continue;
        if (isPreemptEvent(row) && preemptKind(row) === 'cancel') {
          for (const job of jobs.values()) job.cancelled = true;
          return {
            progress: true,
            memory,
            plan: plan || 'cancelled',
            progressUpdate: { activity: `preempt cancel ${row.eventId}` },
          };
        }
        if (isPreemptEvent(row) && preemptKind(row) === 'correct') {
          for (const job of jobs.values()) job.cancelled = true;
          plan = `correction: ${eventField(row, 'text') || eventField(row, 'comment') || row.summary}`;
        }
      }

      harvestJobs(ctx.sandbox, jobs);

      const step = await this.provider.next(view());
      this.steps.push(step);
      if (step.memory !== undefined) memory = step.memory;
      if (step.plan !== undefined) plan = step.plan;
      if (step.progressUpdate) progressUpdate = step.progressUpdate;
      if ('usage' in step && step.usage) usage = { ...usage, ...step.usage };

      if (step.kind === 'done') {
        if (step.result) return step.result;
        return { progress: true, memory, plan, progressUpdate, usage };
      }

      if (step.kind === 'tool') {
        const machineId = step.machineId ?? ctx.worker.sandboxRef ?? 'box';
        const started = await startSandboxTool(ctx.sandbox, machineId, { cmd: step.cmd });
        if (isToolStart(started)) {
          jobs.set(started.jobId, {
            jobId: started.jobId,
            cmd: step.cmd,
            startedAt: this.options.now?.() ?? Date.now(),
          });
          await waitBoundary(ctx, jobs, this.options.wait);
          continue;
        }
        jobs.set(`sync:${i}`, {
          jobId: `sync:${i}`,
          cmd: step.cmd,
          startedAt: this.options.now?.() ?? Date.now(),
          result: started,
        });
        continue;
      }

      await waitBoundary(ctx, jobs, this.options.wait);
    }

    return { progress: true, memory, plan, progressUpdate, usage };
  }
}

function harvestJobs(sandbox: SandboxPort, jobs: Map<string, DuplexToolJob>): void {
  for (const job of jobs.values()) {
    if (job.result || job.cancelled) continue;
    const latest = pollSandboxJob(sandbox, job.jobId);
    if (latest?.result) job.result = latest.result;
  }
}

async function waitBoundary(
  ctx: WorkerContext,
  jobs: Map<string, DuplexToolJob>,
  wait?: () => Promise<void>,
): Promise<void> {
  const tick = wait ?? defaultWait;
  for (let i = 0; i < 2_000; i += 1) {
    if ((ctx.pollInbox?.() ?? []).length > 0) return;
    harvestJobs(ctx.sandbox, jobs);
    const pending = [...jobs.values()].some((job) => !job.result && !job.cancelled);
    if (!pending) {
      await tick();
      return;
    }
    if ([...jobs.values()].some((job) => job.result)) return;
    await tick();
  }
}

function defaultWait(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function byArrival(a: NormalizedEvent, b: NormalizedEvent): number {
  return a.receivedAt - b.receivedAt || a.eventId.localeCompare(b.eventId);
}
