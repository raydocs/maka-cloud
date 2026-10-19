import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ExperimentCell,
  ExperimentExecutor,
  JsonObject,
  SubjectAdapter,
  SubjectExecutionResult,
} from '@maka/eval';
import type { BudgetLedger, Reservation } from './ledger.js';
import {
  DriverError,
  type Grader,
  type HiddenTestSource,
  type Outcome,
  type PublicTask,
  type SubjectDriver,
  type SuiteId,
} from './types.js';

export const CLOUD_EXECUTOR_KIND = 'cloud';

export interface CloudBudget {
  taskBudgetUsd: number;
  totalBudgetUsd: number;
  timeoutSeconds: number;
}

export interface CloudEvalsOptions {
  mode: 'dry-run' | 'live';
  /** One driver per subject id. */
  drivers: ReadonlyMap<string, SubjectDriver>;
  grader: Grader;
  hidden: HiddenTestSource;
  ledger: BudgetLedger;
  /** Host directory under which each attempt gets a private directory. */
  workRoot: string;
  now?: () => number;
  newTaskId?: (cellId: string) => string;
}

export interface CloudEvals {
  executor: ExperimentExecutor;
  subject: SubjectAdapter;
}

interface AttemptState {
  taskId: string;
  cap: number;
  started: boolean;
  executed: boolean;
  costUsd: number | null;
  outcome: Outcome | null;
  noOutcomeReason: string | null;
}

export function budgetOf(budget: JsonObject): CloudBudget {
  const read = (key: string): number => {
    const value = budget[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
      throw new Error(`budget.${key} must be a positive number`);
    return value;
  };
  return {
    taskBudgetUsd: read('taskBudgetUsd'),
    totalBudgetUsd: read('totalBudgetUsd'),
    timeoutSeconds: read('timeoutSeconds'),
  };
}

/** What a subject may be told about a cell's task: public fields only. */
export function publicTaskOf(cell: ExperimentCell): PublicTask {
  const { config, id, input } = cell.task;
  const suite = config.suite;
  if (suite !== 'swe-bench-verified' && suite !== 'terminal-bench')
    throw new Error(`task ${id} has no valid suite`);
  const text = (key: string): string | null => {
    const value = config[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  return {
    id,
    suite: suite as SuiteId,
    repo: text('repo'),
    baseCommit: text('baseCommit'),
    statement: input,
    testCommand: text('testCommand'),
  };
}

/**
 * Names the id the model gateway's spend journal used for this attempt, so a restart can tell
 * which journaled spend an attempt record already holds.
 */
function gatewayArtifact(taskId: string): JsonObject {
  return { kind: 'gateway', taskId };
}

function defaultTaskId(cellId: string): string {
  return `tsk_${createHash('sha256').update(`${cellId}\u0000${randomUUID()}`).digest('hex').slice(0, 32)}`;
}

/**
 * The executor and subject adapter that run an experiment's cells through subject drivers and a
 * grader. They share one table of attempts in flight: the adapter runs the subject and stops it,
 * and only then does the executor's `verify` ask the grader, which is the one place hidden tests
 * are loaded.
 */
export function createCloudEvals(options: CloudEvalsOptions): CloudEvals {
  const now = options.now ?? Date.now;
  const attempts = new Map<string, AttemptState>();

  const validate = (cell: ExperimentCell): void => {
    budgetOf(cell.budget);
    publicTaskOf(cell);
    if (!options.drivers.has(cell.subject.id))
      throw new Error(`unknown subject: ${cell.subject.id}`);
    if (options.mode === 'live' && cell.task.config.suite === 'terminal-bench') {
      throw new Error(
        'Terminal-Bench tasks need their task image, which the sandbox cannot run yet: dry-run only',
      );
    }
  };

  const executor: ExperimentExecutor = {
    kind: CLOUD_EXECUTOR_KIND,
    validate,
    async runAttempt(input, operation) {
      const { cell } = input;
      const budget = budgetOf(cell.budget);
      // The whole cap is reserved before the first await.
      const reservation: Reservation | null = options.ledger.reserve(cell.id, budget.taskBudgetUsd);
      if (!reservation) {
        return {
          kind: 'not_started',
          code: 'preparation-failed',
          artifacts: [
            { kind: 'budget', reason: 'the experiment budget has no room for this cell' },
          ],
        };
      }
      const state: AttemptState = {
        taskId: (options.newTaskId ?? defaultTaskId)(cell.id),
        cap: budget.taskBudgetUsd,
        started: false,
        executed: false,
        costUsd: null,
        outcome: null,
        noOutcomeReason: null,
      };
      let dir: string | undefined;
      try {
        dir = await mkdtemp(join(options.workRoot, 'cell-'));
        attempts.set(cell.id, state);
        const value = await operation({
          context: {
            cwd: dir,
            taskInput: cell.task.input,
            metadata: {},
            ...(input.signal ? { signal: input.signal } : {}),
            execute: async () => {
              throw new Error('cloud subjects run through drivers, not commands');
            },
          },
          verify: () => verify(cell, state, input.signal),
        });
        return { kind: 'settled', value };
      } finally {
        attempts.delete(cell.id);
        // A run that started and reported no cost is charged its whole cap.
        reservation.settle(state.costUsd ?? (state.started ? state.cap : 0));
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };

  async function verify(cell: ExperimentCell, state: AttemptState, signal?: AbortSignal) {
    if (!state.executed) throw new Error('the subject has not finished');
    if (!state.outcome) {
      return {
        status: 'completed' as const,
        score: 0,
        failureReason: state.noOutcomeReason ?? 'the subject left no change',
        artifacts: [] as JsonObject[],
      };
    }
    try {
      const task = publicTaskOf(cell);
      const hidden = await options.hidden.load(task.id);
      const grade = await options.grader.grade({
        task,
        hidden,
        outcome: state.outcome,
        ...(signal ? { signal } : {}),
      });
      return {
        status: 'completed' as const,
        score: grade.resolved ? 1 : 0,
        failureReason: null,
        artifacts: [
          { kind: 'grade', resolved: grade.resolved, detail: grade.detail },
        ] as JsonObject[],
      };
    } catch (error) {
      return {
        status: 'infra_failed' as const,
        score: null,
        failureReason: `grading failed: ${error instanceof Error ? error.message : String(error)}`,
        artifacts: [] as JsonObject[],
      };
    }
  }

  const subject: SubjectAdapter = {
    kind: 'external',
    validate,
    async execute({ cell, context }): Promise<SubjectExecutionResult> {
      const state = attempts.get(cell.id);
      if (!state) throw new Error('no attempt is in flight for this cell');
      const driver = options.drivers.get(cell.subject.id);
      if (!driver) throw new Error(`unknown subject: ${cell.subject.id}`);
      const budget = budgetOf(cell.budget);
      const started = now();
      state.started = true;
      try {
        const result = await driver.run({
          task: publicTaskOf(cell),
          taskId: state.taskId,
          hostDir: context.cwd,
          budgetUsd: budget.taskBudgetUsd,
          timeoutMs: budget.timeoutSeconds * 1000,
          signal: context.signal ?? new AbortController().signal,
        });
        state.executed = true;
        state.costUsd = result.costUsd;
        state.outcome = result.outcome;
        state.noOutcomeReason = result.failureReason;
        const spent = (result.costUsd ?? 0) > 0;
        const status: SubjectExecutionResult['status'] =
          result.end === 'finished'
            ? 'completed'
            : result.end === 'cancelled'
              ? 'indeterminate'
              : spent
                ? 'failed'
                : 'infra_failed';
        return {
          usage: null,
          costUsd: result.costUsd,
          durationMs: now() - started,
          status,
          failureReason: result.failureReason,
          artifacts: [
            gatewayArtifact(state.taskId),
            ...(result.outcome
              ? [
                  {
                    kind: 'outcome',
                    sha256: result.outcome.sha256,
                    files: result.outcome.files,
                    patch: result.outcome.patch,
                  },
                ]
              : []),
          ],
        };
      } catch (error) {
        const costUsd = error instanceof DriverError ? error.costUsd : null;
        state.costUsd = costUsd;
        return {
          usage: null,
          costUsd,
          durationMs: now() - started,
          status: 'infra_failed',
          failureReason: error instanceof Error ? error.message : String(error),
          artifacts: [gatewayArtifact(state.taskId)],
        };
      }
    },
  };

  return { executor, subject };
}
