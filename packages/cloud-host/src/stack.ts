import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FREE_PLAYBOOK } from '@maka-cloud/conductor';
import { SqliteSpendJournal } from '@maka-cloud/gateway';
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
import { citeCheckSandboxTool, webSearchSandboxTool } from '@maka-cloud/playbooks/sandbox-tool';
import {
  type CloudRunners,
  type CloudRunnersOptions,
  createCloudRunnersFromEnv,
  JsonFileSessionStore,
  sameConversationInputPolicy,
  type TaskDirectory,
  TenantMachineProvider,
} from '@maka-cloud/runners';
import { pushConfigFromEnv } from '@maka-cloud/server';
import type { StackConfig } from './config.js';
import {
  conductorGateway,
  gatewayModelAccess,
  gatewayPrices,
  type StackGateway,
  startGateway,
} from './gateway.js';
import { type Cloud, startCloud } from './host.js';
import { SUMMARY_DAILY_CAP_USD } from './inbox/models.js';
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
  // A task's sandbox is its invite's: the tenant is the invite that owns the task's conversation.
  // A task with no such invite (unknown, or a conversation nobody owns) has no sandbox, so it
  // fails to start instead of landing on a machine another invite uses.
  let ownerOfTask: ((taskId: string) => string | undefined) | undefined;
  const tenantOf = (taskId: TaskId): string => {
    const owner = ownerOfTask?.(taskId);
    if (owner === undefined) throw new Error(`Task ${taskId} has no owning invite, so no sandbox`);
    return owner;
  };
  const warn = dependencies.onWarning ?? (() => undefined);
  // Every request of a task's run is written down before it is sent, so a crash cannot lose what
  // it cost: the orchestrator records it on restore.
  await mkdir(dirname(config.gatewaySpendPath), { recursive: true });
  const journal = new SqliteSpendJournal(config.gatewaySpendPath);
  let gateway: StackGateway;
  try {
    gateway = await startGateway(
      config.gateway,
      env,
      warn,
      gatewayPrices(config.gateway.models, config.inbox.verifierModels),
      journal,
    );
  } catch (error) {
    journal.close();
    throw error;
  }
  // Every exit from here on closes the gateway: a failed start, or the stack's close.
  let runners: CloudRunners;
  let coding: CodingRunner;
  let cloud: Cloud;
  try {
    const publicUrl = config.mcp.publicUrl;
    const runnerOptions: Partial<CloudRunnersOptions> = {
      modelAccess: gatewayModelAccess(gateway.gateway, gateway.sandboxUrl),
      sessions: new JsonFileSessionStore(config.runnerSessionsPath),
      sandboxTools: [
        await citeCheckSandboxTool(),
        ...(gateway.gateway.canSearch ? [await webSearchSandboxTool()] : []),
      ],
      inputs: sameConversationInputPolicy(directory),
      tenantOf,
      sandboxes: new TenantMachineProvider(config.sandboxes),
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

    // Web Push is on when all three VAPID settings are set. The private key is read here from the
    // environment and goes to the server only; it is not part of the config the stack describes.
    const push = config.pushSet ? pushConfigFromEnv(env) : undefined;
    cloud = await startCloud({
      ...(push === undefined ? {} : { push }),
      dbPath: config.dbPath,
      invitesPath: config.invitesPath,
      handoffRoot: config.handoffRoot,
      runners: new RunnerRegistry([...runners.runners, coding]),
      host: config.host,
      port: config.port,
      mcp: { host: config.mcp.host, port: config.mcp.port },
      sweepOrphans: (known) => runners.sweepOrphans(known),
      orchestrator: { recoveredSpend: journal },
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
            summaryBudget: journal.dailyLimit('digest summary', SUMMARY_DAILY_CAP_USD),
            ...(dependencies.inbox === undefined ? {} : { override: dependencies.inbox }),
          },
          context,
        ),
      onReady: (parts) => {
        orchestrator = parts.orchestrator;
        conductor = parts.conductor;
        ownerOfTask = parts.ownerOfTask;
      },
      onWarning: warn,
    });
  } catch (error) {
    await gateway.close();
    journal.close();
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
        journal.close();
      }
    },
  };
}
