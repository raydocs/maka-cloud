import { mkdir } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
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
import { InviteStore, pushConfigFromEnv } from '@maka-cloud/server';
import { backupLayoutOf, type StackConfig } from './config.js';
import {
  conductorGateway,
  gatewayModelAccess,
  gatewayPrices,
  type Owner,
  type StackGateway,
  startGateway,
} from './gateway.js';
import { type Cloud, startCloud } from './host.js';
import { capReporter } from './cap-report.js';
import { SUMMARY_DAILY_CAP_USD } from './inbox/models.js';
import { type InboxSetup, startInbox } from './inbox/setup.js';
import { PauseSwitch, PauseWatcher } from './pause.js';
import { BackupScheduler } from './backup-schedule.js';
import { BackupError, backupAll, type BackupResult, listBackups } from './backup.js';
import { accountLedgerOf } from './spend.js';

/** What a user is told when the operator's pause switch stopped their work. */
export const PAUSED_NOTICE =
  'This work was stopped because spending was paused by the operator. Send your request again once it resumes.';

/** The playbooks the stack runs: T7's research playbook, T8's coding playbook and the free one. */
export const STACK_PLAYBOOKS = [researchPlaybook, codingPlaybook, FREE_PLAYBOOK] as const;

export interface StackDependencies {
  /** Builds the runner fleet from the options the stack sets. Default: `createCloudRunnersFromEnv`. */
  createRunners?: (options: Partial<CloudRunnersOptions>) => CloudRunners;
  /** Replaces the inbox's models, fetcher and timers, for tests. */
  inbox?: InboxSetup['override'];
  /**
   * Replaces the lookup of the invite that owns a task when model access is issued, for tests that
   * issue it to tasks no conversation owns. Unset in the product: there a task with no owning
   * invite gets no model access.
   */
  ownerOfTask?: (taskId: string) => string | undefined;
  /** How often the pause switch is read while the stack runs, in milliseconds. Default 1000. */
  pausePollMs?: number;
  /** Timing of the daily backup, for tests. */
  backupTiming?: {
    tickMs?: number;
    firstTickMs?: number;
    retryAfterMs?: number;
    now?: () => number;
  };
  onWarning?: (message: string, detail?: unknown) => void;
  /** Routine events worth a log line, such as a finished backup. */
  onInfo?: (event: string, fields: Record<string, string | number>) => void;
}

export interface Stack {
  cloud: Cloud;
  runners: CloudRunners;
  coding: CodingRunner;
  /** The model gateway: sandbox runs get a token for it, never a vendor key. */
  gateway: StackGateway;
  /** The operator's kill switch, as the stack reads it. */
  pause: PauseSwitch;
  /** Writes a backup now, as the daily one does. Throws when `MAKA_CLOUD_BACKUP_DIR` is not set. */
  backup(): Promise<BackupResult>;
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
  let ownerOfConversation: ((conversationId: string) => string | undefined) | undefined;
  let conversationOfTask: ((taskId: string) => string | undefined) | undefined;
  // Set when the supervisor starts: a spending limit that stops work raises an item in its inbox.
  let supervisorRef: { backupTo(destination: string): Promise<void> } | undefined;
  let raiseCapHit:
    | ((input: { conversationId: string; taskId?: string; key: string; ask: string }) => void)
    | undefined;
  const tenantOf = (taskId: TaskId): string => {
    const owner = ownerOfTask?.(taskId);
    if (owner === undefined) throw new Error(`Task ${taskId} has no owning invite, so no sandbox`);
    return owner;
  };
  // Whose model spend a conductor session or a check is: the invite that owns its conversation.
  const ownerOfSession = (makaSessionId: string): Owner | undefined => {
    const conversationId = conductor?.conversationOfSession(makaSessionId);
    const inviteId =
      conversationId === undefined ? undefined : ownerOfConversation?.(conversationId);
    return inviteId === undefined || conversationId === undefined
      ? undefined
      : { inviteId, conversationId };
  };
  const warn = dependencies.onWarning ?? (() => undefined);
  // Every request of a task's run is written down before it is sent, so a crash cannot lose what
  // it cost: the orchestrator records it on restore.
  await mkdir(dirname(config.gatewaySpendPath), { recursive: true });
  const journal = new SqliteSpendJournal(config.gatewaySpendPath);
  const pause = new PauseSwitch(config.pausePath);
  // Every model request is also reserved against its invite's daily and monthly caps (read from
  // the invites file each time, so the command line changes them at once) and the server's.
  let invites: InviteStore | undefined;
  let gateway: StackGateway;
  try {
    const inviteStore = new InviteStore(config.invitesPath);
    invites = inviteStore;
    gateway = await startGateway(
      config.gateway,
      env,
      warn,
      gatewayPrices(config.gateway.models, config.inbox.verifierModels),
      journal,
      accountLedgerOf(journal, inviteStore, config.spend, pause),
      // A cap that ends spending is told to the conversation and raised as a budget item.
      capReporter({
        raise: (input) => {
          if (raiseCapHit === undefined) throw new Error('The inbox is not running');
          raiseCapHit(input);
        },
        notice: async (conversationId, text) => {
          if (conductor === undefined) throw new Error('The conductor is not running');
          await conductor.postNotice({ conversationId, text });
        },
        warn,
      }),
    );
  } catch (error) {
    invites?.close();
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
      modelAccess: gatewayModelAccess(gateway.gateway, gateway.sandboxUrl, (taskId) => {
        const inviteId = dependencies.ownerOfTask
          ? dependencies.ownerOfTask(taskId)
          : ownerOfTask?.(taskId);
        if (inviteId === undefined) return undefined;
        const conversationId = conversationOfTask?.(taskId);
        return conversationId === undefined ? { inviteId } : { inviteId, conversationId };
      }),
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
          gateway: conductorGateway(gateway.gateway, ownerOfSession),
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
            summaryBudget: (owner) =>
              journal.dailyLimit(`digest summary ${owner}`, SUMMARY_DAILY_CAP_USD),
            accountOf: (conversationId) => {
              const inviteId = ownerOfConversation?.(conversationId);
              return inviteId === undefined ? undefined : { inviteId };
            },
            onStarted: (supervisor) => {
              supervisorRef = supervisor;
              raiseCapHit = (input) => supervisor.raiseCapHit(input);
            },
            ...(dependencies.inbox === undefined ? {} : { override: dependencies.inbox }),
          },
          context,
        ),
      onReady: (parts) => {
        orchestrator = parts.orchestrator;
        conductor = parts.conductor;
        ownerOfTask = parts.ownerOfTask;
        ownerOfConversation = parts.ownerOfConversation;
        conversationOfTask = parts.conversationOfTask;
      },
      onWarning: warn,
    });
  } catch (error) {
    await gateway.close();
    invites.close();
    journal.close();
    throw error;
  }
  // While spending is paused, every open run is stopped through the conductor's normal stop path,
  // which cancels the tasks through the orchestrator.
  const watcher = new PauseWatcher({
    switch: pause,
    onPause: () => cloud.conductor.stopAll('paused', PAUSED_NOTICE),
    onWarning: warn,
    ...(dependencies.pausePollMs === undefined ? {} : { pollMs: dependencies.pausePollMs }),
  });
  watcher.start();
  const layout = backupLayoutOf(config.dataDir);
  const backup = (): Promise<BackupResult> => {
    if (config.backupDir === undefined) {
      return Promise.reject(new BackupError('MAKA_CLOUD_BACKUP_DIR is not set'));
    }
    return backupAll({
      dataDir: config.dataDir,
      backupDir: config.backupDir,
      layout,
      env,
      inProcess: {
        // These two files are held exclusively by this process, so only it can copy them.
        [relative(config.dataDir, config.dbPath)]: (to) => cloud.server.backupDatabase(to),
        [relative(config.dataDir, config.supervisorDbPath)]: (to) =>
          supervisorRef
            ? supervisorRef.backupTo(to)
            : Promise.reject(new Error('The inbox is not running')),
      },
    });
  };
  const backups =
    config.backupDir === undefined
      ? undefined
      : new BackupScheduler({
          latest: async () => (await listBackups(config.backupDir as string))[0]?.createdAt,
          run: async () => {
            const done = await backup();
            dependencies.onInfo?.('backup.written', {
              stamp: done.stamp,
              files: done.files,
              bytes: done.bytes,
              removed: done.removed.length,
            });
          },
          onWarning: warn,
          ...dependencies.backupTiming,
        });
  backups?.start();
  let closing: Promise<void> | undefined;
  return {
    cloud,
    runners,
    coding,
    gateway,
    pause,
    backup,
    // The watcher stops first, then the runs, then the gateway cuts whatever is still in flight.
    // Closing twice closes once.
    close: () => {
      closing ??= (async () => {
        try {
          await backups?.close();
          await watcher.close();
        } finally {
          try {
            await cloud.close();
          } finally {
            await gateway.close();
            invites?.close();
            journal.close();
          }
        }
      })();
      return closing;
    },
  };
}
