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

export interface RunTimeline {
  taskId: TaskId;
  state: TaskState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Time the task has run, as the task view counts it. */
  runMs: number;
  turns: TimelineTurn[];
  steps: TimelineStep[];
  /** Cost over time. Spend is recorded on the top-level task of a tree, so a child has none. */
  cost: TimelineCost[];
  /** Messages the owner sent: how many were sent, read by the agent, or never read. Never their text. */
  messages: { sent: number; read: number; unseen: number; withdrawn: number };
  /** Whether step labels are included (the owner turned content on). */
  content: boolean;
}

/**
 * The run of one task, drawn from its log and nothing else: it reads, never writes, so a failure
 * here cannot touch the task. State comes from the same reducer that computes the task view, so the
 * timeline and the task cannot disagree; the log adds only when things happened. Metadata only:
 * kinds, states and times. A step's label (it carries the command or the file) is included only with
 * `content`.
 */
export function buildTimeline(
  events: Iterable<StoredEvent>,
  options: { content?: boolean; now?: number } = {},
): RunTimeline | undefined {
  const tasks: TaskMap = new Map();
  const turns: TimelineTurn[] = [];
  const times = new Map<StepId, { startedAt: number; endedAt?: number; attempts: number }>();
  const cost: TimelineCost[] = [];
  let taskId: TaskId | undefined;
  let epoch = 1;

  for (const stored of events) {
    const { at, event } = stored;
    applyEvent(tasks, stored);
    if (event.type === 'task_created') {
      taskId = event.taskId;
      turns.push({ epoch: 1, cause: 'start', startedAt: at, steps: 0 });
      continue;
    }
    if (taskId === undefined || event.taskId !== taskId) continue;
    const task = tasks.get(taskId);
    if (!task) continue;
    switch (event.type) {
      case 'task_attempt': {
        // Only an attempt the reducer followed is a turn.
        if (event.epoch !== epoch + 1 || task.epoch !== event.epoch) break;
        epoch = event.epoch;
        const last = turns.at(-1);
        if (last && last.endedAt === undefined) last.endedAt = at;
        turns.push({ epoch: event.epoch, cause: event.cause, startedAt: at, steps: 0 });
        break;
      }
      case 'step_intent': {
        const known = times.get(event.stepId);
        const step = task.steps.get(event.stepId);
        // The reducer took this intent when the step is running in this epoch and is new or a rerun.
        if (step?.state !== 'running' || step.epoch !== event.epoch) break;
        times.set(event.stepId, { startedAt: at, attempts: (known?.attempts ?? 0) + 1 });
        const turn = turns.find((candidate) => candidate.epoch === event.epoch);
        if (turn) turn.steps += 1;
        break;
      }
      case 'step_outcome':
      case 'step_interrupted': {
        const time = times.get(event.stepId);
        const step = task.steps.get(event.stepId);
        if (time && step && step.state !== 'running' && time.endedAt === undefined) {
          time.endedAt = at;
        }
        break;
      }
      case 'task_cost':
        cost.push({ at, totalUsd: task.costUsd ?? 0 });
        break;
      default:
        break;
    }
  }

  const task = taskId === undefined ? undefined : tasks.get(taskId);
  if (!task) return undefined;
  const last = turns.at(-1);
  if (last && task.finishedAt !== undefined) last.endedAt ??= task.finishedAt;
  const content = options.content === true;
  const count = (state: SteerState): number =>
    [...task.steers.values()].filter((steer) => steer.state === state).length;
  const steps: TimelineStep[] = [...task.steps.values()].map((step) => {
    const time = times.get(step.stepId);
    const startedAt = time?.startedAt ?? task.createdAt;
    const endedAt = time?.endedAt;
    return {
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
    };
  });
  return {
    taskId: task.taskId,
    state: task.state,
    createdAt: task.createdAt,
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
    ...(task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt }),
    runMs: options.now === undefined ? task.runMs : runTimeMs(task, options.now),
    turns,
    steps,
    cost,
    messages: {
      sent: task.steers.size,
      read: count('delivered'),
      unseen: count('unseen'),
      withdrawn: count('withdrawn'),
    },
    content,
  };
}
