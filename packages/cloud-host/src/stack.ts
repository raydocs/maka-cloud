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
import {
  conductorGateway,
  gatewayModelAccess,
  gatewayPrices,
  type StackGateway,
  startGateway,
} from './gateway.js';
import { type Cloud, startCloud } from './host.js';
import { type InboxSetup, startInbox } from './inbox/setup.js';

/** The playbooks the stack runs: T7's research playbook, T8's coding playbook and the free one. */
export const STACK_PLAYBOOKS = [researchPlaybook, codingPlaybook, FREE_PLAYBOOK] as const;

export interface StackDependencies {
  /** Builds the runner fleet from the options the stack sets. Default: `createCloudRunnersFromEnv`. */
  createRunners?: (options: Partial<CloudRunnersOptions>) => CloudRunners;
  /** Replaces the inbox's models, fetcher and timers, for tests. */
  inbox?: InboxSetup['override'];
  onWarning?: (message: string, detail?: unknown) => void;
}

export interface Stack {
  cloud: Cloud;
  runners: CloudRunners;
  coding: CodingRunner;
  /** The model gateway: sandbox runs get a token for it, never a vendor key. */
  gateway: StackGateway;
  close(): Promise<void>;
}

/**
 * Starts the whole stack: the runner fleet, the cloud server with its orchestrator, the conductor
 * the product playbooks and the supervisor with its inbox. Starting it runs nothing: tasks start only when a user's message
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
  const warn = dependencies.onWarning ?? (() => undefined);
  const gateway = await startGateway(
    config.gateway,
    env,
    warn,
    gatewayPrices(config.gateway.models, config.inbox.verifierModels),
  );
  // Every exit from here on closes the gateway: a failed start, or the stack's close.
  let runners: CloudRunners;
  let coding: CodingRunner;
  let cloud: Cloud;
  try {
    const publicUrl = config.mcp.publicUrl;
    const runnerOptions: Partial<CloudRunnersOptions> = {
      modelAccess: gatewayModelAccess(gateway.gateway, gateway.sandboxUrl),
      sessions: new JsonFileSessionStore(config.runnerSessionsPath),
      sandboxTools: [await citeCheckSandboxTool()],
      inputs: sameConversationInputPolicy(directory),
      ...(publicUrl === undefined ? {} : { mcpUrlForSandbox: () => publicUrl }),
    };
    runners = (
      dependencies.createRunners ?? ((options) => createCloudRunnersFromEnv(env, options))
    )(runnerOptions);

    const deliveries = new JsonFileCodingDeliveries(config.codingDeliveriesPath);
    coding = createCodingRunner(runners, {
      deliveries,
      onCleanupError: (failure) => warn('A coding task cleanup step failed', failure),
    });
    const pullRequests = openPullRequestTool({
      deliveries,
      // The token is read from MAKA_GITHUB_TOKEN when a pull request is opened, never earlier.
      publisher: new GitHubPublisher({ env }),
      ownsTask: (runId, taskId) => conductor?.state.tasksOf(runId).includes(taskId) ?? false,
    });

    cloud = await startCloud({
      dbPath: config.dbPath,
      invitesPath: config.invitesPath,
      handoffRoot: config.handoffRoot,
      runners: new RunnerRegistry([...runners.runners, coding]),
      host: config.host,
      port: config.port,
      mcp: { host: config.mcp.host, port: config.mcp.port },
      sweepOrphans: (known) => runners.sweepOrphans(known),
      conductorRoot: config.conductorRoot,
      conductor: {
        // The vendor key stays in the gateway: the conductor's requests go through it in process.
        access: {
          apiKey: 'gateway-in-process',
          ...(config.conductor.connectionId === undefined
            ? {}
            : { connectionId: config.conductor.connectionId }),
          gateway: conductorGateway(gateway.gateway),
        },
        playbooks: STACK_PLAYBOOKS,
        tools: [pullRequests],
      },
      supervisor: (context) =>
        startInbox(
          {
            dbPath: config.supervisorDbPath,
            config: config.inbox,
            gateway: gateway.gateway,
            ...(dependencies.inbox === undefined ? {} : { override: dependencies.inbox }),
          },
          context,
        ),
      onReady: (parts) => {
        orchestrator = parts.orchestrator;
        conductor = parts.conductor;
      },
      onWarning: warn,
    });
  } catch (error) {
    await gateway.close();
    throw error;
  }
  return {
    cloud,
    runners,
    coding,
    gateway,
    // The runs stop first, then the gateway cuts whatever is still in flight.
    close: async () => {
      try {
        await cloud.close();
      } finally {
        await gateway.close();
      }
    },
  };
}
