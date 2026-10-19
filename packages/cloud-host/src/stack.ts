import { mkdir } from 'node:fs/promises';
import { FREE_PLAYBOOK } from '@maka-cloud/conductor';
import { type Orchestrator, RunnerRegistry, type TaskId } from '@maka-cloud/orchestrator';
import { researchPlaybook } from '@maka-cloud/playbooks';
import {
  type CodingRunner,
  codingPlaybook,
  createCodingRunner,
  GitHubPublisher,
  JsonFileCodingDeliveries,
  openPullRequestTool,
} from '@maka-cloud/playbooks/coding';
import { citeCheckSandboxTool } from '@maka-cloud/playbooks/sandbox-tool';
import {
  type CloudRunners,
  type CloudRunnersOptions,
  createCloudRunnersFromEnv,
  JsonFileSessionStore,
  sameConversationInputPolicy,
  type TaskDirectory,
} from '@maka-cloud/runners';
import type { StackConfig } from './config.js';
import { type Cloud, startCloud } from './host.js';

/** The playbooks the stack runs: T7's research playbook, T8's coding playbook and the free one. */
export const STACK_PLAYBOOKS = [researchPlaybook, codingPlaybook, FREE_PLAYBOOK] as const;

export interface StackDependencies {
  /** Builds the runner fleet from the options the stack sets. Default: `createCloudRunnersFromEnv`. */
  createRunners?: (options: Partial<CloudRunnersOptions>) => CloudRunners;
  onWarning?: (message: string, detail?: unknown) => void;
}

export interface Stack {
  cloud: Cloud;
  runners: CloudRunners;
  coding: CodingRunner;
  close(): Promise<void>;
}

/**
 * Starts the whole stack: the runner fleet, the cloud server with its orchestrator, the conductor
 * and the product playbooks. Starting it runs nothing: tasks start only when a user's message
 * reaches the conductor. At start the server stops leftover sandbox runs whose task it does not
 * know, and the conductor retries cancels that a shutdown left undone.
 */
export async function startStack(
  config: StackConfig,
  env: NodeJS.ProcessEnv,
  dependencies: StackDependencies = {},
): Promise<Stack> {
  await mkdir(config.handoffRoot, { recursive: true });
  await mkdir(config.conductorRoot, { recursive: true });

  // The input policy asks the orchestrator, which the server creates, and the pull request tool
  // asks the conductor. Both are set before the server listens, so nothing reaches them unset.
  let orchestrator: Orchestrator | undefined;
  let conductor: Cloud['conductor'] | undefined;
  const directory: TaskDirectory = {
    rootSessionOfTask: (taskId: TaskId) => orchestrator?.rootSessionOfTask(taskId),
    taskStateOf: (taskId: TaskId) => orchestrator?.taskStateOf(taskId),
  };
  const publicUrl = config.mcp.publicUrl;
  const runnerOptions: Partial<CloudRunnersOptions> = {
    sessions: new JsonFileSessionStore(config.runnerSessionsPath),
    sandboxTools: [await citeCheckSandboxTool()],
    inputs: sameConversationInputPolicy(directory),
    ...(publicUrl === undefined ? {} : { mcpUrlForSandbox: () => publicUrl }),
  };
  const runners = (
    dependencies.createRunners ?? ((options) => createCloudRunnersFromEnv(env, options))
  )(runnerOptions);

  const warn = dependencies.onWarning ?? (() => undefined);
  const deliveries = new JsonFileCodingDeliveries(config.codingDeliveriesPath);
  const coding = createCodingRunner(runners, {
    deliveries,
    onCleanupError: (failure) => warn('A coding task cleanup step failed', failure),
  });
  const pullRequests = openPullRequestTool({
    deliveries,
    // The token is read from MAKA_GITHUB_TOKEN when a pull request is opened, never earlier.
    publisher: new GitHubPublisher({ env }),
    ownsTask: (runId, taskId) => conductor?.state.tasksOf(runId).includes(taskId) ?? false,
  });

  const cloud = await startCloud({
    dbPath: config.dbPath,
    invitesPath: config.invitesPath,
    handoffRoot: config.handoffRoot,
    runners: new RunnerRegistry([...runners.runners, coding]),
    host: config.host,
    port: config.port,
    mcp: { host: config.mcp.host, port: config.mcp.port },
    sweepOrphans: (known) => runners.sweepOrphans(known),
    conductorRoot: config.conductorRoot,
    conductor: { access: config.conductor, playbooks: STACK_PLAYBOOKS, tools: [pullRequests] },
    onReady: (parts) => {
      orchestrator = parts.orchestrator;
      conductor = parts.conductor;
    },
    onWarning: warn,
  });
  return { cloud, runners, coding, close: () => cloud.close() };
}
