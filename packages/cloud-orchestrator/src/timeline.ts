import { applyEvent, runTimeMs, type TaskMap } from './reducer.js';
import type {
  AttemptCause,
  ReplayClass,
  SteerState,
  StepId,
  StepState,
  StoredEvent,
  TaskId,
  TaskState,
} from './types.js';

/** One turn of the task: the span of one attempt to drive it (the first is the task's start). */
export interface TimelineTurn {
  epoch: number;
  /** `start` for the task's own first run, else why the attempt began. */
  cause: 'start' | AttemptCause;
  startedAt: number;
  /** When the next attempt began or the task ended; absent while it is the one running. */
  endedAt?: number;
  /** Steps that began in this turn. */
  steps: number;
}

/** One step, as the log has it. A `safe` step that ran again after a restart is one row. */
export interface TimelineStep {
  stepId: StepId;
  /** What kind of step: the tool or action, never its arguments. */
  kind: string;
  replay: ReplayClass;
  state: StepState;
  /** The epoch that holds the step now (the latest to run it). */
  epoch: number;
  /** Times an attempt recorded this step's intent: more than one when it ran again after a restart. */
  attempts: number;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  /** Only with content on: the one printable line that says what the step did. */
  label?: string;
}

export interface TimelineCost {
  at: number;
  /** What the task's tree had spent as of this point. */
  totalUsd: number;
}

/** Cost points kept in a timeline: the series is thinned past this, so its size does not grow with the log. */
export const MAX_COST_POINTS = 120;
/** The most turns a timeline lists (the latest ones). */
export const MAX_TURNS = 100;
/** Steps in a page of a timeline when the caller names no limit, and the most it may ask for. */
export const STEPS_PAGE_DEFAULT = 100;
export const STEPS_PAGE_MAX = 500;

export interface RunTimeline {
  taskId: TaskId;
  state: TaskState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Time the task has run, as the task view counts it. */
  runMs: number;
  /** The latest `MAX_TURNS` turns, oldest first. */
  turns: TimelineTurn[];
  /** How many turns the task has had, those not listed included. */
  turnsTotal: number;
  /** One page of the steps, in the order they began. */
  steps: TimelineStep[];
  /** How many steps the task has, those not in this page included. */
  stepsTotal: number;
  /** Where the next page of steps starts (`after` of the next request); absent on the last page. */
  stepsNext?: number;
  /**
   * Cost over time, thinned to at most `2 * MAX_COST_POINTS + 1` points that keep the first, the
   * last and the shape between. Spend is recorded on the top-level task of a tree, so a child has none.
   */
  cost: TimelineCost[];
  /** How many cost reports the log holds, those thinned away included. */
  costReports: number;
  /** Messages the owner sent: how many were sent, read by the agent, or never read. Never their text. */
  messages: { sent: number; read: number; unseen: number; withdrawn: number };
  /** Whether step labels are included (the owner turned content on). */
  content: boolean;
  /** Set by a server that cut the page of steps short to keep the answer within its byte limit. */
  truncated?: boolean;
}

/** A series of points that never holds more than `2 * limit` of them: when it fills, every other one goes. */
class ThinSeries {
  private points: TimelineCost[] = [];
  private stride = 1;
  private seen = 0;
  private last: TimelineCost | undefined;

  constructor(private readonly limit: number) {}

  get count(): number {
    return this.seen;
  }

  add(point: TimelineCost): void {
    this.last = point;
    if (this.seen++ % this.stride !== 0) return;
    this.points.push(point);
    if (this.points.length >= 2 * this.limit) {
      this.points = this.points.filter((_, index) => index % 2 === 0);
      this.stride *= 2;
    }
  }

  /** The points kept, and always the last one reported. */
  result(): TimelineCost[] {
    const out = [...this.points];
    if (this.last && out.at(-1) !== this.last) out.push(this.last);
    return out;
  }
}

export interface TimelineOptions {
  content?: boolean;
  now?: number;
  /** The first step of the page (an index into the steps, default 0). */
  after?: number;
  /** Steps in the page. Default `STEPS_PAGE_DEFAULT`, at most `STEPS_PAGE_MAX`. */
  limit?: number;
}

/**
 * The run of one task, drawn from its log and nothing else: it reads, never writes, so a failure
 * here cannot touch the task. State comes from the same reducer that computes the task view, so the
 * timeline and the task cannot disagree; the log adds only when things happened. Metadata only:
 * kinds, states and times. A step's label (it carries the command or the file) is included only with
 * `content`.
 *
 * The log is taken one entry at a time with `add`, so a caller can read a long log in pages and
 * give the event loop its turns between them; `build` can be called more than once (it only
 * slices what `add` gathered), for a page of steps and for a smaller one.
 */
export class TimelineBuilder {
  private readonly tasks: TaskMap = new Map();
  private readonly turns: TimelineTurn[] = [];
  private turnsTotal = 0;
  private readonly times = new Map<
    StepId,
    { startedAt: number; endedAt?: number; attempts: number }
  >();
  private readonly cost = new ThinSeries(MAX_COST_POINTS);
  private taskId: TaskId | undefined;
  private epoch = 1;
  private entries = 0;

  /** How many log entries were added. */
  get added(): number {
    return this.entries;
  }

  private startTurn(turn: TimelineTurn): void {
    const last = this.turns.at(-1);
    if (last && last.endedAt === undefined) last.endedAt = turn.startedAt;
    this.turns.push(turn);
    this.turnsTotal++;
    if (this.turns.length > MAX_TURNS) this.turns.shift();
  }

  add(stored: StoredEvent): void {
    this.entries++;
    const { at, event } = stored;
    applyEvent(this.tasks, stored);
    if (event.type === 'task_created') {
      this.taskId = event.taskId;
      this.turnsTotal++;
      this.turns.push({ epoch: 1, cause: 'start', startedAt: at, steps: 0 });
      return;
    }
    if (this.taskId === undefined || event.taskId !== this.taskId) return;
    const task = this.tasks.get(this.taskId);
    if (!task) return;
    switch (event.type) {
      case 'task_attempt': {
        // Only an attempt the reducer followed is a turn.
        if (event.epoch !== this.epoch + 1 || task.epoch !== event.epoch) break;
        this.epoch = event.epoch;
        this.startTurn({ epoch: event.epoch, cause: event.cause, startedAt: at, steps: 0 });
        break;
      }
      case 'step_intent': {
        const known = this.times.get(event.stepId);
        const step = task.steps.get(event.stepId);
        // The reducer took this intent when the step is running in this epoch and is new or a rerun.
        if (step?.state !== 'running' || step.epoch !== event.epoch) break;
        this.times.set(event.stepId, { startedAt: at, attempts: (known?.attempts ?? 0) + 1 });
        const turn = [...this.turns].reverse().find((candidate) => candidate.epoch === event.epoch);
        if (turn) turn.steps += 1;
        break;
      }
      case 'step_outcome':
      case 'step_interrupted': {
        const time = this.times.get(event.stepId);
        const step = task.steps.get(event.stepId);
        if (time && step && step.state !== 'running' && time.endedAt === undefined) {
          time.endedAt = at;
        }
        break;
      }
      case 'task_cost':
        this.cost.add({ at, totalUsd: task.costUsd ?? 0 });
        break;
      default:
        break;
    }
  }

  build(options: TimelineOptions = {}): RunTimeline | undefined {
    const task = this.taskId === undefined ? undefined : this.tasks.get(this.taskId);
    if (!task) return undefined;
    const turns = this.turns.map((turn) => ({ ...turn }));
    const last = turns.at(-1);
    if (last && task.finishedAt !== undefined) last.endedAt ??= task.finishedAt;
    const content = options.content === true;
    const count = (state: SteerState): number =>
      [...task.steers.values()].filter((steer) => steer.state === state).length;
    const after = Math.max(0, Math.floor(options.after ?? 0));
    const limit = Math.min(
      STEPS_PAGE_MAX,
      Math.max(0, Math.floor(options.limit ?? STEPS_PAGE_DEFAULT)),
    );
    const stepsTotal = task.steps.size;
    const steps: TimelineStep[] = [];
    let index = 0;
    for (const step of task.steps.values()) {
      if (index++ < after) continue;
      if (steps.length >= limit) break;
      const time = this.times.get(step.stepId);
      const startedAt = time?.startedAt ?? task.createdAt;
      const endedAt = time?.endedAt;
      steps.push({
        stepId: step.stepId,
        kind: step.kind,
        replay: step.replay,
        state: step.state,
        epoch: step.epoch,
        attempts: time?.attempts ?? 1,
        startedAt,
        ...(endedAt === undefined ? {} : { endedAt }),
        ...(endedAt === undefined || step.state === 'interrupted'
          ? {}
          : { durationMs: Math.max(0, endedAt - startedAt) }),
        ...(content ? { label: step.label } : {}),
      });
    }
    const next = after + steps.length;
    return {
      taskId: task.taskId,
      state: task.state,
      createdAt: task.createdAt,
      ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
      ...(task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt }),
      runMs: options.now === undefined ? task.runMs : runTimeMs(task, options.now),
      turns,
      turnsTotal: this.turnsTotal,
      steps,
      stepsTotal,
      ...(next < stepsTotal && steps.length > 0 ? { stepsNext: next } : {}),
      cost: this.cost.result(),
      costReports: this.cost.count,
      messages: {
        sent: task.steers.size,
        read: count('delivered'),
        unseen: count('unseen'),
        withdrawn: count('withdrawn'),
      },
      content,
    };
  }
}

/** The timeline of a log that is all in hand; see `TimelineBuilder` for one read in pages. */
export function buildTimeline(
  events: Iterable<StoredEvent>,
  options: TimelineOptions = {},
): RunTimeline | undefined {
  const builder = new TimelineBuilder();
  for (const stored of events) builder.add(stored);
  return builder.build(options);
}
