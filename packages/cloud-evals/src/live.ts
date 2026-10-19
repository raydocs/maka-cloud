import { join } from 'node:path';
import type { ExperimentSpec } from '@maka/eval';
import {
  FleetCodingSandbox,
  JsonFileCodingDeliveries,
  createCodingRunner,
} from '@maka-cloud/playbooks/coding';
import { createCloudRunnersFromEnv } from '@maka-cloud/runners';
import { PlaybookDriver, VendorAloneDriver } from './drivers.js';
import { SweBenchDataset } from './suites.js';
import { SweBenchGrader } from './swebench-grader.js';
import type { Grader, HiddenTestSource, SubjectDriver } from './types.js';

export interface EvalDeps {
  drivers: ReadonlyMap<string, SubjectDriver>;
  grader: Grader;
  hidden: HiddenTestSource;
}

export interface LiveApproval {
  /** `--live` was given. */
  live: boolean;
  /** `--approve-budget`, dollars. */
  approvedUsd: number | undefined;
}

/**
 * The gate every live run passes before anything is built or contacted. It throws, with the
 * reason, unless the run was asked for as live and its budget was approved at or above the
 * worst case: every cell spending its whole cap.
 */
export function assertLiveApproved(spec: ExperimentSpec, approval: LiveApproval): void {
  const mode = spec.executor.config.mode;
  if (mode !== 'live') {
    if (approval.live) throw new Error('--live was given for a spec whose mode is not "live"');
    return;
  }
  if (!approval.live) throw new Error('this spec is live: it spends money, so it needs --live');
  const cap = spec.budget.taskBudgetUsd;
  const total = spec.budget.totalBudgetUsd;
  if (typeof cap !== 'number' || typeof total !== 'number')
    throw new Error('the spec has no taskBudgetUsd and totalBudgetUsd');
  if (approval.approvedUsd === undefined || !Number.isFinite(approval.approvedUsd))
    throw new Error('a live run needs --approve-budget <usd>');
  const cells = spec.tasks.length * spec.repetitions * spec.subjects.length;
  const worst = cells * cap;
  if (approval.approvedUsd < worst) {
    throw new Error(
      `--approve-budget $${approval.approvedUsd} is below the worst case $${worst} (${cells} cells at $${cap} each)`,
    );
  }
  if (total > approval.approvedUsd)
    throw new Error(
      `the spec's total budget $${total} is above the approved $${approval.approvedUsd}`,
    );
}

/**
 * Builds the real subjects, sandbox fleet and grader from the environment. Called only after
 * `assertLiveApproved`; nothing here is exercised by a test.
 */
export async function createLiveDeps(
  workRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EvalDeps> {
  const dataDir = env.MAKA_EVALS_DATA_DIR;
  const python = env.MAKA_EVALS_PYTHON;
  if (!dataDir) throw new Error('MAKA_EVALS_DATA_DIR is not set.');
  if (!python) throw new Error('MAKA_EVALS_PYTHON is not set.');
  const datasetPath = join(dataDir, 'swe-bench-verified.jsonl');
  const dataset = await SweBenchDataset.read(datasetPath);
  const cloud = createCloudRunnersFromEnv(env);
  const sandbox = new FleetCodingSandbox(cloud.fleet);
  const deliveries = new JsonFileCodingDeliveries(join(workRoot, 'deliveries.json'));
  const coding = createCodingRunner(cloud, { deliveries });
  return {
    drivers: new Map<string, SubjectDriver>([
      ['claude-agent-sdk', new VendorAloneDriver({ runner: cloud.claude, sandbox })],
      ['codex', new VendorAloneDriver({ runner: cloud.codex, sandbox })],
      ['coding-playbook', new PlaybookDriver({ runner: coding, deliveries, sandbox })],
    ]),
    grader: new SweBenchGrader({ python, datasetPath, workDir: workRoot }),
    hidden: dataset,
  };
}
