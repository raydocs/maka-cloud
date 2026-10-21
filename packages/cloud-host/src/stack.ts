import { mkdir } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import {
  type BoxService,
  type BoxServiceOptions,
  cliInstallCommands,
  pinnedVersions,
  startBoxService,
} from '@maka-cloud/boxes';
import { FREE_PLAYBOOK } from '@maka-cloud/conductor';
import { SqliteSpendJournal } from '@maka-cloud/gateway';
import { DEFAULT_INSTABOX_BASE_URL, InstaboxClient } from '@maka-cloud/instabox';
import {
  type Orchestrator,
  RunnerRegistry,
  containsSecret,
  type TaskId,
} from '@maka-cloud/orchestrator';
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
  loadAgentSdk,
  sameConversationInputPolicy,
  SqliteTranscriptStore,
  type TaskDirectory,
  TenantMachineProvider,
} from '@maka-cloud/runners';
import type { Supervisor } from '@maka-cloud/supervisor';
import {
  InviteStore,
  type PushTransport,
  pushConfigFromEnv,
  scrubErrorText,
} from '@maka-cloud/server';
import { backupLayoutOf, type StackConfig } from './config.js';
import { type CardsRuntime, createCards } from './cards/runtime.js';
import { createDuties, type DutiesRuntime } from './duties/runtime.js';
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
import { withModes } from './moded-runner.js';
import { SpendAlertWatcher } from './spend-alert.js';
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
  /** Replaces the GitHub reader that proposals inspect repositories with, for tests. */
  dutyInspector?: import('@maka-cloud/duties').RepoInspector;
  /** Replaces the GitHub reader and the timing of the card scans, for tests. */
  cards?: Pick<NonNullable<Parameters<typeof createCards>[0]>, 'reader' | 'schedule'>;
  /** How often schedules are looked at and finished duty runs settled, in milliseconds. Default 60000. */
  dutyTickMs?: number;
  /** How often the pause switch is read while the stack runs, in milliseconds. Default 1000. */
  pausePollMs?: number;
  /** Timing of the daily backup, for tests. */
  spendAlertTiming?: { pollMs?: number; now?: () => number };
  /** Replaces the Web Push transport, for tests; the product sends over HTTPS. */
  pushTransport?: PushTransport;
  backupTiming?: {
    tickMs?: number;
    firstTickMs?: number;
    retryAfterMs?: number;
    now?: () => number;
  };
  /**
   * Replaces the sandbox client, the egress guard and the timers of the box pool (`MAKA_CLOUD_BOXES=1`),
   * for tests. Unset in the product: the pool uses the account's `INSTABOX_API_KEY` and the real guard.
   */
  boxes?: Pick<BoxServiceOptions, 'guard' | 'timers'> & { client?: InstaboxClient };
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
  /** The standing duties; absent while `MAKA_GITHUB_WEBHOOK_SECRET` is not set. */
  duties?: DutiesRuntime;
  /** Proposed cards; absent while `MAKA_CLOUD_CARDS` is not set. */
  cards?: CardsRuntime;
  /** Writes a backup now, as the daily one does. Throws when `MAKA_CLOUD_BACKUP_DIR` is not set. */
  backup(): Promise<BackupResult>;
  /** Looks at the day's spend now and sends the alert if it is due. A no-op without an alert set. */
  checkSpendAlert(): Promise<void>;
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
  let supervisorRef:
    | {
        backupTo(destination: string): Promise<void>;
        raiseProposal(input: Parameters<Supervisor['raiseProposal']>[0]): boolean;
        raiseSuggestion(input: Parameters<Supervisor['raiseSuggestion']>[0]): boolean;
        raiseSuggestionOffer(input: Parameters<Supervisor['raiseSuggestionOffer']>[0]): boolean;
        closeSuggestion(lineage: string): boolean;
      }
    | undefined;
  let raiseCapHit:
    | ((input: {
        conversationId: string;
        taskId?: string;
        key: string;
        ask: string;
        once?: boolean;
      }) => boolean)
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
  // The webhook secret is read here and goes to the duties engine only. Without it the stack
  // has no duties: there is no webhook route and no project route.
  const webhookSecret = config.dutiesSet ? env.MAKA_GITHUB_WEBHOOK_SECRET?.trim() : undefined;
  let duties: DutiesRuntime | undefined;
  // The box pool and its sleep and cleanup loops, made only with `MAKA_CLOUD_BOXES=1`.
  let boxService: BoxService | undefined;
  // Proposed cards (T30): only when asked for, on top of the duties' database.
  let cards: CardsRuntime | undefined;
  // The conversations of Claude tasks, kept off the sandboxes. Made only when Claude runs through
  // the Agent SDK, which needs the agent's account.
  let transcripts: SqliteTranscriptStore | undefined;
  try {
    if (config.agentChannel !== undefined) {
      await mkdir(dirname(config.transcriptsDbPath), { recursive: true });
      transcripts = SqliteTranscriptStore.open(config.transcriptsDbPath);
    }
    duties =
      webhookSecret === undefined
        ? undefined
        : createDuties({
            dbPath: config.dutiesDbPath,
            webhookSecret,
            links: config.dutyLinks,
            cards: config.cardsSet,
            ...(dependencies.dutyInspector === undefined
              ? {}
              : { inspector: dependencies.dutyInspector }),
            ...(dependencies.dutyTickMs === undefined ? {} : { tickMs: dependencies.dutyTickMs }),
            onWarning: warn,
          });
    if (duties !== undefined && config.cardsSet) {
      const modes = config.modes;
      cards = createCards({
        engine: duties.engine,
        minRunUsd: (mode) => modes.modes[mode].budget.minRunUsd,
        ...(dependencies.cards?.reader === undefined ? {} : { reader: dependencies.cards.reader }),
        ...(dependencies.cards?.schedule === undefined
          ? {}
          : { schedule: dependencies.cards.schedule }),
        onWarning: warn,
      });
    }
    const publicUrl = config.mcp.publicUrl;
    if (config.boxes !== undefined) {
      const apiKey = env.INSTABOX_API_KEY;
      const client =
        dependencies.boxes?.client ??
        (apiKey === undefined || apiKey === ''
          ? undefined
          : new InstaboxClient({
              apiKey,
              baseUrl: config.instabox.apiUrl ?? DEFAULT_INSTABOX_BASE_URL,
            }));
      if (client === undefined) throw new Error('INSTABOX_API_KEY is not set.');
      boxService = startBoxService({
        client,
        templateId: config.boxes.templateId,
        maxPerInvite: config.boxes.maxPerInvite,
        ...(config.agentChannel === undefined ? {} : { agent: config.agentChannel }),
        // Until the orchestrator exists every task counts as live: a box is never freed by a guess.
        isTaskLive: (taskId) => {
          const state = orchestrator?.taskStateOf(taskId);
          return (
            orchestrator === undefined ||
            state === 'queued' ||
            state === 'running' ||
            state === 'paused'
          );
        },
        conversationOf: (taskId) => conversationOfTask?.(taskId),
        onWarning: warn,
        ...(dependencies.boxes?.guard === undefined ? {} : { guard: dependencies.boxes.guard }),
        ...(dependencies.boxes?.timers === undefined ? {} : { timers: dependencies.boxes.timers }),
      });
    }
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
      // A page the agent fetched and got an answer for goes on its task's sources card. The server
      // keeps only public https URLs, 20 a task, and only for a task that exists.
      onOpenedPage: (taskId, url) => {
        cloud?.server.recordOpenedPages(taskId, [{ url }]);
      },
      sandboxTools: [
        await citeCheckSandboxTool(),
        ...(gateway.gateway.canSearch ? [await webSearchSandboxTool()] : []),
      ],
      inputs: sameConversationInputPolicy(directory),
      tenantOf,
      // The pool makes, sleeps and deletes the boxes; the CLIs on them are the pinned, checked ones.
      sandboxes:
        boxService === undefined ? new TenantMachineProvider(config.sandboxes) : boxService.pool,
      ...(boxService === undefined
        ? {}
        : { installCommands: cliInstallCommands(), versions: pinnedVersions() }),
      ...(config.agentChannel === undefined || transcripts === undefined
        ? {}
        : {
            agentSdk: await loadAgentSdk(),
            agentChannel: config.agentChannel,
            transcripts,
          }),
      ...(publicUrl === undefined ? {} : { mcpUrlForSandbox: () => publicUrl }),
    };
    runners = (
      dependencies.createRunners ?? ((options) => createCloudRunnersFromEnv(env, options))
    )(runnerOptions);

    const deliveries = new JsonFileCodingDeliveries(config.codingDeliveriesPath);
    coding = createCodingRunner(runners, {
      deliveries,
      modes: config.modes,
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
    const pushSettings = config.pushSet ? pushConfigFromEnv(env) : undefined;
    const push =
      pushSettings === undefined
        ? undefined
        : {
            ...pushSettings,
            ...(dependencies.pushTransport ? { transport: dependencies.pushTransport } : {}),
          };
    cloud = await startCloud({
      ...(push === undefined ? {} : { push }),
      ...(duties === undefined ? {} : { duties: duties.service }),
      dbPath: config.dbPath,
      invitesPath: config.invitesPath,
      handoffRoot: config.handoffRoot,
      runners: new RunnerRegistry([
        ...runners.runners.map((runner) => withModes(runner, config.modes)),
        coding,
      ]),
      host: config.host,
      port: config.port,
      mcp: { host: config.mcp.host, port: config.mcp.port },
      sweepOrphans: (known) => runners.sweepOrphans(known),
      orchestrator: { recoveredSpend: journal, limits: config.taskLimits },
      timelineContent: config.timelineContent,
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
        modes: config.modes,
        tools: [pullRequests],
        // The orchestrator resumes its tasks after a restart, so the conductor follows them
        // instead of cancelling what it delegated.
        tasksSurviveRestart: true,
        scrubTaskText: scrubErrorText,
        carriesSecret: (value) => containsSecret(value),
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
            ...(duties === undefined ? {} : { proposals: duties.proposals }),
            ...(cards === undefined ? {} : { suggestions: cards.suggestions }),
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
    // Any other process that books spend against this ledger (the evals) runs under these caps.
    // They are written only once this process holds the server's database, which keeps a second
    // server out: a start that fails on the way never changes what the running server published.
    journal.setSpendPolicy(config.spend);
    // Boxes labelled with a task that ended while the server was down are freed (or kept, if live).
    boxService?.pool
      .reconcile()
      .catch((error: unknown) => warn('Box pool reconcile failed', error));
    const runsOf = (conversationId: string) => {
      const conductorState = cloud.conductor.state;
      return conductorState.runsOfConversation(conversationId).map((run) => ({
        runId: run.runId,
        dutyId: run.dutyId,
        state: run.state,
        spentUsd: conductorState.budget(run.runId).spentUsd,
        endReason: run.endReason,
      }));
    };
    duties?.start({
      server: cloud.server,
      runsOf,
      postNotice: (conversationId, text) => cloud.conductor.postNotice({ conversationId, text }),
      raiseProposal: (input) => supervisorRef?.raiseProposal(input) ?? false,
    });
    cards?.start({
      server: cloud.server,
      runsOf,
      raiseSuggestion: (input) => supervisorRef?.raiseSuggestion(input) ?? false,
      raiseOffer: (input) => supervisorRef?.raiseSuggestionOffer(input) ?? false,
      closeSuggestion: (lineage) => supervisorRef?.closeSuggestion(lineage) ?? false,
    });
  } catch (error) {
    await cards?.stop();
    await duties?.stop();
    duties?.close();
    await boxService?.close();
    transcripts?.close();
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
        ...(duties === undefined
          ? {}
          : { [relative(config.dataDir, config.dutiesDbPath)]: (to) => duties.backupTo(to) }),
        ...(transcripts === undefined
          ? {}
          : {
              [relative(config.dataDir, config.transcriptsDbPath)]: (to) =>
                transcripts.backupTo(to),
            }),
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
  const alerts =
    config.spendAlert === undefined
      ? undefined
      : new SpendAlertWatcher({
          thresholdUsd: config.spendAlert.usd,
          ownerInvite: config.spendAlert.ownerInvite,
          spentToday: () => journal.serverDaySpendUsd(),
          // An alert asked for and not delivered is kept in the journal until it is.
          owed: {
            save: (alert) => journal.savePendingAlert(alert),
            list: () => journal.pendingAlerts(),
            clear: (inviteId, key) => journal.clearPendingAlert(inviteId, key),
          },
          alert: (inviteId, key) => cloud.server.pushAlert(inviteId, key),
          // An alert that never reached a device must not hide a cap breach: it becomes a budget
          // item in the owner's inbox (in the owner's oldest conversation, as the inbox is per
          // owner; an owner with none gets an empty one made for it). It is raised once ever per
          // (invite, alert key), the supervisor keeping that record with the item itself, so a
          // restart, or a failed clearing of the owed alert, does not raise it a second time after
          // the first was answered. An owner who is no longer active has no inbox, so only the
          // log says.
          onDropped: (alert) => {
            let conversationId = cloud.server.conversationsOf(alert.inviteId)[0];
            if (conversationId === undefined) {
              const made = cloud.server.createConversation({
                owner: alert.inviteId,
                key: 'spend_alert',
                title: 'Spend alerts',
              });
              if (!made.ok) {
                if (made.reason === 'owner_inactive') return;
                throw new Error(`The spend alert's conversation could not be made: ${made.reason}`);
              }
              conversationId = made.conversationId;
            }
            if (raiseCapHit === undefined) throw new Error('The inbox is not running');
            const day = alert.key.slice('spend:'.length);
            const raised = raiseCapHit({
              conversationId,
              key: `spend_alert:${alert.inviteId}:${day}`,
              ask: `The alert that the server's spend reached its limit on ${day} was never delivered to your devices, so you may not have been told. Check the day's spend.`,
              once: true,
            });
            if (!raised) throw new Error('The inbox is not running');
          },
          onAlert: (day) => dependencies.onInfo?.('spend.alerted', { day }),
          onWarning: warn,
          ...dependencies.spendAlertTiming,
        });
  alerts?.start();
  let closing: Promise<void> | undefined;
  return {
    cloud,
    runners,
    coding,
    gateway,
    pause,
    ...(duties === undefined ? {} : { duties }),
    ...(cards === undefined ? {} : { cards }),
    backup,
    checkSpendAlert: () => alerts?.tick() ?? Promise.resolve(),
    // The watcher stops first, then the runs, then the gateway cuts whatever is still in flight.
    // Closing twice closes once.
    close: () => {
      closing ??= (async () => {
        try {
          await alerts?.close();
          await backups?.close();
          await watcher.close();
        } finally {
          try {
            // The timer and the launches stop first; the database closes once the server no
            // longer answers webhook requests.
            await cards?.stop();
            await duties?.stop();
            await cloud.close();
          } finally {
            duties?.close();
            await boxService?.close();
            transcripts?.close();
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
