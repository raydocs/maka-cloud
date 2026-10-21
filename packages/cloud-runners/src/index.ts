import { DEFAULT_INSTABOX_BASE_URL, InstaboxClient } from '@maka-cloud/instabox';
import type { Runner } from '@maka-cloud/orchestrator';
import { Fleet, type CloudRunnersOptions, type SweepResult } from './fleet.js';
import { FixedMachineProvider } from './providers.js';
import { SandboxCliRunner } from './runner.js';
import { claudeAdapter, codexAdapter } from './vendors.js';

export { Fleet, type CloudRunnersOptions, type RunnerName, type SweepResult } from './fleet.js';
export {
  ARTIFACTS_PREFIX,
  type BriefHeader,
  INPUTS_PREFIX,
  type InputPolicy,
  type InputRequest,
  parseBriefHeader,
  sameConversationInputPolicy,
  type TaskDirectory,
} from './inputs.js';
export {
  DEFAULT_STAGE_LIMITS,
  MAX_RESULT_BYTES,
  RemoteMachine,
  type StageLimits,
} from './machine.js';
export {
  DEFAULT_TENANT,
  FixedMachineProvider,
  noModelAccess,
  TenantMachineProvider,
} from './providers.js';
export { type PollBackoff } from './poller.js';
export { ExecProcess, type ExecProcessOptions } from './process-channel.js';
export { type ResumeInput, SandboxCliRunner } from './runner.js';
export { type AgentSdk, loadAgentSdk } from './sdk-turn.js';
export {
  JsonFileSessionStore,
  MemorySessionStore,
  referencedSnapshotIds,
} from './session-store.js';
export type {
  AccessMeter,
  ModelAccess,
  ModelAccessProvider,
  RunnerSessionRecord,
  RunnerSessionStore,
  SandboxLease,
  SandboxProvider,
  SandboxTool,
} from './types.js';
export {
  claudeAdapter,
  codexAdapter,
  DEFAULT_PRICES,
  type TokenPrices,
  type VendorAdapter,
} from './vendors.js';

export interface CloudRunners {
  /** `claude-agent-sdk` and `codex`, ready for a `RunnerRegistry`. */
  runners: Runner[];
  claude: SandboxCliRunner;
  codex: SandboxCliRunner;
  /**
   * Stops live runs whose task is not in `knownTaskIds`. Call once after the orchestrator has
   * restored, with every task id in its log. An unreachable sandbox is reported, never thrown.
   */
  sweepOrphans(
    knownTaskIds: Iterable<string>,
    options?: { timeoutMs?: number },
  ): Promise<SweepResult>;
  fleet: Fleet;
}

export function createCloudRunners(options: CloudRunnersOptions): CloudRunners {
  const fleet = new Fleet(options);
  const claude = new SandboxCliRunner(fleet, claudeAdapter);
  const codex = new SandboxCliRunner(fleet, codexAdapter);
  return {
    runners: [claude, codex],
    claude,
    codex,
    sweepOrphans: (known, sweepOptions) => fleet.sweepOrphans(known, sweepOptions),
    fleet,
  };
}

/**
 * Reads `INSTABOX_API_KEY` (optionally `INSTABOX_API_URL`) and, unless `overrides.sandboxes` says
 * where tasks run, `INSTABOX_MACHINE_ID`. Model access is `overrides.modelAccess`: without it every
 * run fails to start.
 */
export function createCloudRunnersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<CloudRunnersOptions> = {},
): CloudRunners {
  const apiKey = env.INSTABOX_API_KEY;
  const machineId = env.INSTABOX_MACHINE_ID;
  if (!apiKey) throw new Error('INSTABOX_API_KEY is not set.');
  if (!machineId && !overrides.sandboxes) throw new Error('INSTABOX_MACHINE_ID is not set.');
  return createCloudRunners({
    client: new InstaboxClient({
      apiKey,
      baseUrl: env.INSTABOX_API_URL ?? DEFAULT_INSTABOX_BASE_URL,
    }),
    // Without an INSTABOX_MACHINE_ID the caller's provider is the only one; never an empty fixed one.
    sandboxes: overrides.sandboxes ?? new FixedMachineProvider(machineId as string),
    ...overrides,
  });
}
