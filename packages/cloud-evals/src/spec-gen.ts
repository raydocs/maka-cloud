import { type ExperimentSpec, parseExperimentSpec } from '@maka/eval';
import { SUBJECT_IDS, type PublicTask, type SubjectId, type SuiteId } from './types.js';

export interface MakeSpecInput {
  suite: SuiteId;
  tasks: readonly PublicTask[];
  /** Pins the benchmark data: `sha256:` of the dataset file, or a commit. */
  benchmarkVersion: string;
  subjects?: readonly SubjectId[];
  repetitions?: number;
  /** Required: nothing has a default dollar amount. */
  taskBudgetUsd: number;
  totalBudgetUsd: number;
  timeoutSeconds?: number;
  mode: 'dry-run' | 'live';
  id?: string;
}

/** An experiment spec in `packages/eval`'s format, run by the `cloud` executor. */
export function makeSpec(input: MakeSpecInput): ExperimentSpec {
  const subjects = input.subjects ?? SUBJECT_IDS;
  const id =
    input.id ??
    `cloud-evals-${input.suite}-${input.tasks.length}-${input.mode}`.replace(/_/gu, '-');
  return parseExperimentSpec({
    schemaVersion: 'maka.eval.v1',
    id,
    benchmark: { id: input.suite, version: input.benchmarkVersion, config: {} },
    executor: { kind: 'cloud', config: { mode: input.mode } },
    execution: { maxConcurrentTaskGroups: 1 },
    subjects: subjects.map((subject) => ({
      id: subject,
      kind: 'external',
      credentials: [],
      config: {},
    })),
    tasks: input.tasks.map((task) => ({
      id: task.id,
      input: task.statement,
      config: {
        suite: task.suite,
        ...(task.repo ? { repo: task.repo } : {}),
        ...(task.baseCommit ? { baseCommit: task.baseCommit } : {}),
        ...(task.testCommand ? { testCommand: task.testCommand } : {}),
      },
    })),
    repetitions: input.repetitions ?? 1,
    budget: {
      taskBudgetUsd: input.taskBudgetUsd,
      totalBudgetUsd: input.totalBudgetUsd,
      timeoutSeconds: input.timeoutSeconds ?? 3600,
    },
    verifier: { kind: 'resolved' },
  });
}
