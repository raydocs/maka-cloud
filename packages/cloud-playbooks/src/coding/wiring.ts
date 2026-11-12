import type { CloudRunners } from '@maka-cloud/runners';
import { CodingRunner, type CodingRunnerOptions } from './runner.js';
import { FleetCodingSandbox } from './sandbox.js';

/**
 * The coding runner over the T6 runners: their Claude and Codex runners as the agents and their
 * sandbox fleet as the workspace. Register the result with the orchestrator next to them.
 */
export function createCodingRunner(
  cloud: Pick<CloudRunners, 'claude' | 'codex' | 'fleet'>,
  options: Omit<CodingRunnerOptions, 'agents' | 'sandbox'>,
): CodingRunner {
  return new CodingRunner({
    ...options,
    agents: { 'claude-agent-sdk': cloud.claude, codex: cloud.codex },
    sandbox: new FleetCodingSandbox(cloud.fleet),
  });
}
