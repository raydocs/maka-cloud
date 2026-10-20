import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ExperimentSpec } from '@maka/eval';
import { SqliteSpendJournal } from '@maka-cloud/gateway';
import {
  gatewayModelAccess,
  gatewayPrices,
  openServerLedger,
  readStackConfig,
  startGateway,
} from '@maka-cloud/host';
import {
  FleetCodingSandbox,
  JsonFileCodingDeliveries,
  createCodingRunner,
} from '@maka-cloud/playbooks/coding';
import {
  type CloudRunners,
  type CloudRunnersOptions,
  createCloudRunnersFromEnv,
} from '@maka-cloud/runners';
import type { RecoveredSpend } from './recovery.js';
import { PlaybookDriver, VendorAloneDriver } from './drivers.js';
import { SweBenchDataset } from './suites.js';
import { SweBenchGrader } from './swebench-grader.js';
import type { Grader, HiddenTestSource, SubjectDriver } from './types.js';

export interface EvalDeps {
  drivers: ReadonlyMap<string, SubjectDriver>;
  grader: Grader;
  hidden: HiddenTestSource;
  /** What earlier processes of this run spent through the gateway (live only). */
  recovered?: RecoveredSpend;
  /** Closes what the deps opened (the model gateway); called once the run is over. */
  close?(): Promise<void>;
}

export interface LiveOptions {
  /**
   * Where the model gateway's spend journal lives. It must outlive the run, so it is the
   * experiment directory, not the scratch directory that is removed at the end.
   */
  stateDir: string;
  /** Builds the runner fleet from the options set here. Default: `createCloudRunnersFromEnv`. */
  createRunners?: (options: Partial<CloudRunnersOptions>) => CloudRunners;
  onWarning?: (message: string, detail?: unknown) => void;
}

type Vendor = 'anthropic' | 'openai';

/** The vendors each subject calls: the playbook hands over to the other vendor once. */
const SUBJECT_VENDORS: Readonly<Record<string, readonly Vendor[]>> = {
  'claude-agent-sdk': ['anthropic'],
  codex: ['openai'],
  'coding-playbook': ['anthropic', 'openai'],
};

const VENDOR_KEYS: Readonly<Record<Vendor, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

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
 * `assertLiveApproved`; nothing here is exercised against a real vendor by a test.
 *
 * Model calls go through the model gateway, started here: the vendor keys stay in this process,
 * and each run's sandbox gets a token for its own budget. It refuses to build, before anything
 * is contacted, when a subject's vendor has no key or no price.
 */
export async function createLiveDeps(
  spec: ExperimentSpec,
  workRoot: string,
  env: NodeJS.ProcessEnv,
  options: LiveOptions,
): Promise<EvalDeps> {
  const dataDir = env.MAKA_EVALS_DATA_DIR;
  const python = env.MAKA_EVALS_PYTHON;
  if (!dataDir) throw new Error('MAKA_EVALS_DATA_DIR is not set.');
  if (!python) throw new Error('MAKA_EVALS_PYTHON is not set.');
  const vendors = new Set<Vendor>();
  for (const subject of spec.subjects) {
    const needs = SUBJECT_VENDORS[subject.id];
    if (!needs) throw new Error(`unknown subject: ${subject.id}`);
    for (const vendor of needs) vendors.add(vendor);
  }
  // The stack's own reader checks the gateway's settings (ports, URL scheme, prices). Its data
  // directory is this run's, so no product database or journal is touched.
  // The harness has no invites: one machine runs every cell, so it keeps INSTABOX_MACHINE_ID.
  const config = readStackConfig(
    { ...env, MAKA_CLOUD_DATA_DIR: options.stateDir },
    { sandboxes: 'single-machine' },
  );
  // Real money is spent against the server's caps, whoever spends it: the benchmark is booked to
  // an invite of the server it runs next to, and its approved budget is a limit on top of theirs.
  const serverDir = env.MAKA_CLOUD_DATA_DIR?.trim();
  if (!serverDir) {
    throw new Error('MAKA_CLOUD_DATA_DIR is not set: a live run is booked to the server there.');
  }
  const accountInvite = env.MAKA_EVALS_INVITE_ID?.trim();
  if (!accountInvite) {
    throw new Error('MAKA_EVALS_INVITE_ID is not set: a live run is booked to that invite.');
  }
  const serverConfig = readStackConfig({ ...env }, { sandboxes: 'single-machine' });
  if (resolve(serverConfig.gatewaySpendPath) === resolve(config.gatewaySpendPath)) {
    throw new Error('the experiment directory is the server data directory');
  }
  for (const vendor of vendors) {
    if (!env[VENDOR_KEYS[vendor]]?.trim()) {
      throw new Error(`${VENDOR_KEYS[vendor]} is not set, and a subject of this spec needs it.`);
    }
  }
  if (vendors.has('openai') && !config.gateway.models.some((m) => m.vendor === 'openai')) {
    throw new Error('MAKA_CLOUD_GATEWAY_MODELS has no OpenAI model, so Codex has no price.');
  }
  const datasetPath = join(dataDir, 'swe-bench-verified.jsonl');
  const dataset = await SweBenchDataset.read(datasetPath);

  const ledger = openServerLedger(serverConfig);
  if (!ledger.hasInvite(accountInvite)) {
    ledger.close();
    throw new Error(`MAKA_EVALS_INVITE_ID is not an active invite of the server: ${accountInvite}`);
  }
  await mkdir(options.stateDir, { recursive: true });
  const warn = options.onWarning ?? (() => undefined);
  const journal = new SqliteSpendJournal(config.gatewaySpendPath);
  let gateway: Awaited<ReturnType<typeof startGateway>>;
  try {
    gateway = await startGateway(
      config.gateway,
      env,
      warn,
      gatewayPrices(config.gateway.models, []),
      journal,
      ledger.accounts,
      (event) => warn('A spending limit stopped the benchmark', event.cap),
    );
  } catch (error) {
    journal.close();
    ledger.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  try {
    const modelAccess = gatewayModelAccess(gateway.gateway, gateway.sandboxUrl, () => ({
      inviteId: accountInvite,
    }));
    const cloud = (options.createRunners ?? ((o) => createCloudRunnersFromEnv(env, o)))({
      modelAccess,
    });
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
      recovered: journal,
      close: () => {
        closing ??= (async () => {
          await gateway.close();
          journal.close();
          ledger.close();
        })();
        return closing;
      },
    };
  } catch (error) {
    await gateway.close();
    journal.close();
    ledger.close();
    throw error;
  }
}
