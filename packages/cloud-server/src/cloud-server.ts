import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { backup as sqliteBackup, type DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '@maka-cloud/memory';
import {
  Orchestrator,
  type OrchestratorOptions,
  OrchestratorServer,
  type OrchestratorServerOptions,
  type RunnerRegistry,
} from '@maka-cloud/orchestrator';
import { type ArtifactRead, type ArtifactSource, FileArtifactSource } from './artifacts.js';
import { ConductorFeed, type ConversationPublisher } from './conductor-feed.js';
import type { ComputerSource } from './computer.js';
import { OpenedPages, PreviewService, type PreviewOptions, type SourceLabel } from './previews.js';
import { createSafeFetch } from './safe-fetch.js';
import {
  ConversationStore,
  MAX_MESSAGE_BYTES,
  type MessageMeta,
  MessageMetaSchema,
} from './conversations.js';
import { openDatabase } from './db.js';
import { type DeliveryOptions, type DeliveryStats, MessageDeliveries } from './deliveries.js';
import { type DutyService, DutyRoutes } from './duties.js';
import { ExtensionFeed, type ExtensionEvent } from './extension-feed.js';
import { type FeedEntry, FeedHub, readFeed } from './feed.js';
import {
  type AnswerOutcome,
  DEFAULT_HTTP_LIMITS,
  type HttpLimits,
  PublicApi,
  type TimelineLimits,
} from './http.js';
import { HomeRoutes, HomeStore } from './home.js';
import { type InboxService, InboxRoutes } from './inbox.js';
import { AccountStore } from './accounts.js';
import { type AuthLimits, AuthRoutes } from './auth-routes.js';
import { EmailCodes, type Mailer, NonceStore } from './challenges.js';
import {
  APPLE,
  createOidcVerifier,
  GOOGLE,
  type IdentityVerifier,
  type JwksSource,
  jwksFromSafeFetch,
} from './identity.js';
import { InviteStore } from './invites.js';
import { type PushConfig, type PushOptions, PushService } from './push.js';
import { RateLimiter } from './rate-limit.js';
import { SqliteSessionStore } from './sqlite-session-store.js';
import { SqliteTaskStore } from './sqlite-task-store.js';

/** Webhook requests accepted per minute, from every sender together. */
const WEBHOOKS_PER_MINUTE = 600;

/** What T6's runners package returns to clean up after a previous process. */
export type SweepOrphans = (knownTaskIds: Iterable<string>) => Promise<{
  stopped: readonly unknown[];
  failed: Array<{ machineId: string; taskId?: string; error: string }>;
}>;

/** What a conversation handler (the conductor, in T5) gets to talk to the orchestrator as the conversation. */
export interface ConductorAccess {
  /** The orchestrator MCP endpoint. */
  mcpUrl: string;
  /** Issues a new bearer token for the conversation's orchestrator session; the previous one stops working. */
  rotateToken(): string;
}

export interface ConversationHandler {
  onUserMessage(
    message: {
      conversationId: string;
      messageId: string;
      text: string;
      /** The text comes from outside the owner (a standing duty's event): taint the conversation first. */
      external?: boolean;
      /** The limits of the run this message starts, from a standing duty. */
      run?: NonNullable<MessageMeta['run']>;
      /** The mode the user picked for this message (T25); it applies if the message starts a run. */
      mode?: NonNullable<MessageMeta['mode']>;
    },
    conductor: ConductorAccess,
  ): void | Promise<void>;
  /**
   * Applies an answer to a question the handler posted. Without it the answers
   * route is 404. `caller` is the invite that answered: it owned the
   * conversation and was active when this was called. An answer whose effect
   * comes later (an approved irreversible call) checks it again then, with
   * `authorized` from `createHandler`.
   */
  onAnswer?(
    answer: {
      conversationId: string;
      questionId: string;
      optionId: string;
      text?: string;
      caller: string;
    },
    conductor: ConductorAccess,
  ): Promise<AnswerOutcome>;
  /** Called on shutdown while the orchestrator endpoint is still up. */
  close?(): void | Promise<void>;
}

/**
 * What the server hands a component that runs inside its process and watches
 * every conversation (the supervisor). Everything here is in-process: the
 * database is locked to this process, so the component cannot read it from
 * outside, and nothing here adds authority over tasks or sandboxes.
 */
export interface SupervisorParts {
  feed: {
    /** Entries after `after` of all conversations, runner ids kept. Synchronous: a database read. */
    read(after: number, limit: number): FeedEntry[];
    /** Called after the feed moved. Returns the unsubscribe function. */
    subscribe(listener: () => void): () => void;
  };
  /** Appends to the feed clients stream. Throws for an unknown conversation or unstorable data. */
  publish(event: ExtensionEvent): void;
  /**
   * The handler's answers route, for an answer a human gave through the inbox.
   * `caller` is the invite that gave it: when it is no longer active or does not
   * own the conversation, the answer is `not_found` and nothing is applied.
   * Without a handler that takes answers, every question is `not_found`.
   */
  answers: {
    deliver(
      answer: {
        conversationId: string;
        questionId: string;
        optionId: string;
        text?: string;
        caller?: string;
      },
      signal: AbortSignal,
    ): Promise<AnswerOutcome>;
  };
  /**
   * Posts a user message into a conversation, like the messages route:
   * idempotent on `clientMessageId`. `caller` is the invite whose inbox answer
   * this is; one no longer active, or not the owner, is `refused` and nothing
   * is posted.
   */
  messages: {
    post(
      message: { conversationId: string; text: string; clientMessageId: string; caller?: string },
      signal: AbortSignal,
    ): Promise<{ messageId: string } | { refused: 'not_found' }>;
  };
  /** Reads one artifact of a task of that conversation, with the checks of the artifact route. */
  artifacts: {
    read(
      task: { taskId: string; conversationId: string },
      ref: string,
      signal: AbortSignal,
    ): Promise<ArtifactRead>;
  };
  onWarning(message: string, detail?: unknown): void;
}

export interface CloudServerOptions {
  /** The SQLite file. Exactly one server may have it open. */
  dbPath: string;
  /** Invite tokens live in a file of their own so the CLI can write them while the server runs. */
  invitesPath: string;
  handoffRoot: string;
  runners: RunnerRegistry;
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  mcp?: OrchestratorServerOptions;
  http?: Partial<HttpLimits>;
  orchestrator?: Pick<
    OrchestratorOptions,
    'quotas' | 'caches' | 'maxDepth' | 'now' | 'stopRetry' | 'recoveredSpend' | 'limits'
  >;
  handler?: ConversationHandler;
  /**
   * Builds the handler once the database is open, with the publisher it posts
   * assistant messages, notices and questions through. Wins over `handler`.
   */
  createHandler?: (context: {
    publisher: ConversationPublisher;
    /** The restored orchestrator, before the server listens. */
    orchestrator: Orchestrator;
    /**
     * The orchestrator access of a conversation, for work the handler resumes
     * at start before any message arrives (retrying cancels a crash left undone).
     */
    conductorAccess(conversationId: string): ConductorAccess | undefined;
    /**
     * Whether `caller` (an answer's) is still an active invite that owns the
     * conversation. Synchronous, so a check and the effect it guards can run
     * with nothing in between.
     */
    authorized(caller: string, conversationId: string): boolean;
    /** Invite-scoped memory; unknown, unowned or revoked conversations have no access. */
    memory: {
      /**
       * The memory snapshot for the conversation's next turn. `external` is true while it holds
       * any fact or task summary, which may carry content from outside the user (T15).
       */
      context(conversationId: string): { text: string; external: boolean };
      remember(message: { eventId: string; conversationId: string; text: string }): void;
    };
    /**
     * The invite that owns the conversation a task belongs to, or undefined when the task is
     * unknown or its conversation has no owner (a pre-v5 one nobody adopted). Never a guess.
     */
    ownerOfTask(taskId: string): string | undefined;
    /** The invite that owns the conversation, or undefined when it is unknown or has no owner. */
    ownerOfConversation(conversationId: string): string | undefined;
    /** The conversation a task belongs to, or undefined for an unknown task. */
    conversationOfTask(taskId: string): string | undefined;
  }) => ConversationHandler | Promise<ConversationHandler>;
  /** Where artifact content comes from. Default: the task's directory under `handoffRoot`. */
  artifacts?: ArtifactSource;
  /**
   * Task timelines include what each step did (its command or file), not only its kind. Default
   * false: a timeline is metadata.
   */
  timelineContent?: boolean;
  /** Bounds on one timeline response (log entries folded, bytes answered). Tests lower them. */
  timelineLimits?: Partial<TimelineLimits>;
  /** Computer routes are absent without a trusted desktop/terminal adapter. */
  computer?: ComputerSource;
  /** The preview proxy for pages a task opened. Tests give it a fetcher that touches no network. */
  previews?: Pick<
    PreviewOptions,
    'fetch' | 'ttlMs' | 'failureTtlMs' | 'maxEntries' | 'maxImageBytes' | 'maxInFlight'
  >;
  sweepOrphans?: SweepOrphans;
  /** Web Push settings (see `pushConfigFromEnv`). Without them the push routes answer 404. */
  push?: PushConfig & Pick<PushOptions, 'transport' | 'retryDelayMs' | 'maxAttempts' | 'timeoutMs'>;
  /** Retry timing for handing user messages to the handler. */
  delivery?: DeliveryOptions;
  /**
   * Starts the supervisor once the handler exists and before the server listens, and
   * stops it before the handler and the database close. Without it the `/v1/inbox`
   * routes answer 404 and nothing else changes.
   */
  supervisor?: (parts: SupervisorParts) => InboxService | Promise<InboxService>;
  /**
   * The duties engine behind `POST /github/webhook` and `/v1/projects`. Without it both answer
   * like any unknown path. The caller owns it and closes it after the server.
   */
  duties?: DutyService;
  /**
   * Signing in with Apple, Google or an emailed code (T31). `apple` and `google` list the client
   * ids the owner registered; a provider with none is off, and with no `mailer` there is no email
   * sign-in. Without any of them `/v1/auth` answers like any unknown path and invite tokens remain
   * the only way in. `jwks` replaces the fetch of the providers' public keys (tests only).
   */
  auth?: {
    apple?: { audiences: string[] };
    google?: { audiences: string[] };
    mailer?: Mailer;
    jwks?: JwksSource;
    limits?: Partial<AuthLimits>;
    /** Mail the server may send in an hour, over all addresses (default 300). */
    maxMailsPerHour?: number;
    /** The server is behind one reverse proxy: count sign-in limits per forwarded client address. */
    trustProxy?: boolean;
    /** Tests only: the clock of nonces, codes and rate limits. */
    now?: () => number;
  };
  /** Reports things that must not stop the server: a failed sweep, a handler that threw. */
  onWarning?: (message: string, detail?: unknown) => void;
}

/** What an in-process caller starts a conversation with. Public routes cannot send any of it. */
export interface StartConversationInput {
  /** The invite that will own the conversation. It must be active. */
  owner: string;
  /** Starting twice with the same key (per owner) starts one conversation and posts one message. */
  key: string;
  title?: string;
  text: string;
  meta: MessageMeta;
}

export interface CreateConversationInput {
  owner: string;
  /** Creating twice with the same key (per owner) makes one conversation. */
  key: string;
  title?: string;
}

export type CreateConversationResult =
  | { ok: true; conversationId: string }
  | { ok: false; reason: 'owner_inactive' | 'invalid' };

export type StartConversationResult =
  | { ok: true; conversationId: string; messageId: string; duplicate: boolean }
  | { ok: false; reason: 'owner_inactive' | 'invalid' };

export interface CloudServer {
  /** Base URL of the public API. */
  url: string;
  mcpUrl: string;
  orchestrator: Orchestrator;
  invites: InviteStore;
  accounts: AccountStore;
  /** Where conductor output enters the conversation feed. */
  publisher: ConversationPublisher;
  /**
   * Records pages a task opened, for its sources card. Only trusted in-process code may call this
   * (a tool result in the transcript, a pull request the employee opened); the pages are the only
   * URLs the preview proxy will fetch. Returns how many were new; an unknown task keeps none.
   */
  recordOpenedPages(taskId: string, pages: readonly { url: string; label?: SourceLabel }[]): number;
  /** Event streams currently open. */
  openStreams(): number;
  /** Where handing user messages to the handler stands; undefined without a handler. */
  deliveryStats(): DeliveryStats | undefined;
  /**
   * Writes a consistent copy of the main database to `destination` while the server runs. The
   * server holds that file exclusively, so only the server can make this copy.
   */
  backupDatabase(destination: string): Promise<void>;
  /**
   * Sends the operator's alert `key` to the devices of `inviteId`, each at most once per key.
   * Resolves `true` when every device was told or cannot be, `false` when some are still owed
   * because the push service kept failing (ask again later); without Web Push it resolves `true`.
   */
  pushAlert(inviteId: string, key: string): Promise<boolean>;
  /** The ids of the conversations `inviteId` owns, oldest first. */
  conversationsOf(inviteId: string): string[];
  /**
   * Puts one fact on `owner`'s Home: a known template with typed parameters (`HomeNote`), never
   * text. The same fact twice is one card; anything else is `invalid`.
   */
  addHomeNote(owner: string, note: unknown): 'added' | 'duplicate' | 'invalid';
  /**
   * Starts a conversation owned by `owner` with a first message that carries `meta`, for a
   * standing duty. Idempotent on `key`. The message is delivered at least once with its meta.
   */
  startConversation(input: StartConversationInput): StartConversationResult;
  /**
   * The conversation `startConversation` made for `owner` and `key`, once its first message is
   * stored; a conversation that exists without it is not a started one. Reads only: a launch
   * that must know whether an earlier attempt got as far as making the run asks here.
   */
  startedConversation(input: {
    owner: string;
    key: string;
  }): { conversationId: string } | undefined;
  /**
   * Creates an empty conversation owned by `owner`, which nothing runs in: a place for an inbox
   * item that belongs to no chat yet. Idempotent on `key`.
   */
  createConversation(input: CreateConversationInput): CreateConversationResult;
  close(): Promise<void>;
}

/**
 * Opens the database, restores the orchestrator from it, and only then starts
 * listening. A second server on the same database fails at the first step.
 */
export async function startCloudServer(options: CloudServerOptions): Promise<CloudServer> {
  const warn = options.onWarning ?? (() => undefined);
  const db: DatabaseSync = openDatabase(options.dbPath);
  let invites: InviteStore | undefined;
  let accounts: AccountStore | undefined;
  let mcp: OrchestratorServer | undefined;
  let http: Server | undefined;
  let push: PushService | undefined;
  let handler: ConversationHandler | undefined;
  let inbox: InboxService | undefined;
  let deliveries: MessageDeliveries | undefined;
  try {
    const hub = new FeedHub();
    const store = new SqliteTaskStore(db, hub);
    const orchestrator = await Orchestrator.create({
      ...options.orchestrator,
      store,
      sessions: new SqliteSessionStore(db, options.orchestrator?.now),
      runners: options.runners,
      handoffRoot: options.handoffRoot,
      // Tasks a restart resumes start at the end of this function, once the MCP endpoint, the
      // handler and the supervisor are up: a resumed run needs the endpoint, and the host's
      // tenant lookup (set in `createHandler`'s `onReady`) to find its sandbox.
      resume: 'manual',
    });
    if (options.sweepOrphans) {
      try {
        // A task that owes a stop is not left alone just because the log knows it.
        const owed = new Set(store.stopPendingTaskIds());
        const swept = await options.sweepOrphans(
          (function* () {
            for (const taskId of store.taskIds()) if (!owed.has(taskId)) yield taskId;
          })(),
        );
        if (swept.failed.length > 0) warn('sweepOrphans could not stop some runners', swept.failed);
      } catch (error) {
        warn('sweepOrphans failed', error);
      }
    }
    mcp = new OrchestratorServer(orchestrator, options.mcp);
    const mcpUrl = await mcp.listen();

    invites = new InviteStore(options.invitesPath);
    accounts = new AccountStore(options.invitesPath);
    const conversations = new ConversationStore(
      db,
      hub,
      () => orchestrator.issueSession(),
      options.orchestrator?.now,
    );
    if (options.push) {
      const { transport, retryDelayMs, maxAttempts, timeoutMs, ...config } = options.push;
      push = new PushService(db, hub, invites, {
        config,
        ...(transport ? { transport } : {}),
        ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
        ...(maxAttempts === undefined ? {} : { maxAttempts }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        now: options.orchestrator?.now,
        onWarning: warn,
      });
    }
    const publisher = new ConductorFeed(db, hub, options.orchestrator?.now);
    const accessFor = (sessionId: string): ConductorAccess => ({
      mcpUrl,
      rotateToken: () => {
        const rotated = orchestrator.rotateSession(sessionId);
        if (!rotated) throw new Error('The conversation has no session');
        return rotated.token;
      },
    });
    const conversationOfTask = (taskId: string): string | undefined => {
      const sessionId = orchestrator.rootSessionOfTask(taskId);
      return sessionId === undefined ? undefined : conversations.conversationOf(sessionId);
    };
    const ownInviteStore = invites;
    const ownAccountStore = accounts;
    /** The invite is active and, for a device session, that session is still good. */
    const callerActive = (inviteId: string, sessionId?: string): boolean =>
      ownInviteStore.active(inviteId) &&
      (sessionId === undefined || ownAccountStore.active(sessionId));
    const authorized = (caller: string, conversationId: string): boolean =>
      ownInviteStore.active(caller) && conversations.owns(caller, conversationId);
    const memory = new MemoryStore(db);
    const memoryOwner = (conversationId: string): string | undefined => {
      const owner = conversations.ownerOf(conversationId);
      return owner !== undefined && ownInviteStore.active(owner) ? owner : undefined;
    };
    handler = options.createHandler
      ? await options.createHandler({
          publisher,
          orchestrator,
          conductorAccess: (conversationId) => {
            const sessionId = conversations.sessionOf(conversationId);
            return sessionId === undefined ? undefined : accessFor(sessionId);
          },
          authorized,
          memory: {
            context: (conversationId) => {
              const owner = memoryOwner(conversationId);
              if (owner === undefined) return { text: '', external: false };
              const { facts, summaries } = memory.profile(owner);
              return {
                text: memory.context(owner),
                external: facts.length > 0 || summaries.length > 0,
              };
            },
            remember: (message) => {
              const owner = memoryOwner(message.conversationId);
              if (owner !== undefined) {
                memory.remember(owner, {
                  id: message.eventId,
                  conversationId: message.conversationId,
                  text: message.text,
                });
              }
            },
          },
          ownerOfTask: (taskId) => {
            const conversationId = conversationOfTask(taskId);
            return conversationId === undefined ? undefined : conversations.ownerOf(conversationId);
          },
          conversationOfTask,
          ownerOfConversation: (conversationId) => conversations.ownerOf(conversationId),
        })
      : options.handler;
    const ownHandler = handler;
    const limits = { ...DEFAULT_HTTP_LIMITS, ...options.http };
    const artifacts = options.artifacts ?? new FileArtifactSource(options.handoffRoot);
    const openedPages = new OpenedPages(db);
    const previewService = new PreviewService({
      ...options.previews,
      fetch: options.previews?.fetch ?? createSafeFetch(),
    });
    // Without a handler, messages stay pending until a server with one starts.
    const ownDeliveries = ownHandler
      ? new MessageDeliveries(
          db,
          (message) =>
            ownHandler.onUserMessage(
              {
                conversationId: message.conversationId,
                messageId: message.messageId,
                text: message.text,
                ...(message.external === undefined ? {} : { external: message.external }),
                ...(message.run === undefined ? {} : { run: message.run }),
                ...(message.mode === undefined ? {} : { mode: message.mode }),
              },
              accessFor(message.sessionId),
            ),
          warn,
          options.delivery,
        )
      : undefined;
    deliveries = ownDeliveries;
    const deliverMessage = (message: { messageId: string }): void => {
      ownDeliveries?.kick(message.messageId);
    };
    const deliverAnswer = ownHandler?.onAnswer
      ? async (answer: {
          conversationId: string;
          questionId: string;
          optionId: string;
          text?: string;
          sessionId: string;
          caller: string;
        }): Promise<AnswerOutcome> => {
          // Checked here, synchronously before the handler applies it, for every route an answer takes.
          if (!authorized(answer.caller, answer.conversationId)) {
            return { accepted: false, reason: 'not_found' };
          }
          return (ownHandler.onAnswer as NonNullable<ConversationHandler['onAnswer']>)(
            {
              conversationId: answer.conversationId,
              questionId: answer.questionId,
              optionId: answer.optionId,
              ...(answer.text === undefined ? {} : { text: answer.text }),
              caller: answer.caller,
            },
            accessFor(answer.sessionId),
          );
        }
      : undefined;
    if (options.supervisor) {
      const extensions = new ExtensionFeed(db, hub, options.orchestrator?.now);
      inbox = await options.supervisor({
        feed: {
          read: (after, limit) => readFeed(db, after, limit, undefined, { internal: true }),
          subscribe: (listener) => hub.subscribe(listener),
        },
        publish: (event) => void extensions.publish(event),
        answers: {
          deliver: async (answer, signal) => {
            signal.throwIfAborted();
            const sessionId = conversations.sessionOf(answer.conversationId);
            if (sessionId === undefined || !deliverAnswer || answer.caller === undefined) {
              return { accepted: false, reason: 'not_found' };
            }
            return deliverAnswer({ ...answer, sessionId, caller: answer.caller });
          },
        },
        messages: {
          post: async (message, signal) => {
            signal.throwIfAborted();
            if (!conversations.exists(message.conversationId)) {
              throw new Error('The conversation does not exist');
            }
            if (
              message.caller === undefined ||
              !authorized(message.caller, message.conversationId)
            ) {
              return { refused: 'not_found' };
            }
            const result = conversations.post(
              message.conversationId,
              message.text,
              message.clientMessageId,
            );
            if (!result.found) throw new Error('The conversation does not exist');
            deliverMessage({ messageId: result.messageId });
            return { messageId: result.messageId };
          },
        },
        artifacts: {
          read: async (task, ref, signal) => {
            signal.throwIfAborted();
            // The task must belong to the conversation the caller names.
            const session = orchestrator.rootSessionOfTask(task.taskId);
            if (
              session === undefined ||
              conversations.conversationOf(session) !== task.conversationId
            ) {
              return { ok: false, reason: 'not_found' };
            }
            return artifacts.read(task.taskId, ref);
          },
        },
        onWarning: warn,
      });
    }
    const authOptions = options.auth;
    const verifiers: Partial<Record<'apple' | 'google', IdentityVerifier>> = {};
    if (authOptions) {
      const jwks = authOptions.jwks ?? jwksFromSafeFetch(createSafeFetch());
      const apple =
        authOptions.apple && createOidcVerifier({ ...APPLE, ...authOptions.apple }, jwks);
      const google =
        authOptions.google && createOidcVerifier({ ...GOOGLE, ...authOptions.google }, jwks);
      if (apple) verifiers.apple = apple;
      if (google) verifiers.google = google;
    }
    const auth =
      authOptions && (verifiers.apple || verifiers.google || authOptions.mailer)
        ? new AuthRoutes({
            accounts,
            invites,
            nonces: new NonceStore(authOptions.now),
            verifiers,
            ...(authOptions.mailer
              ? {
                  emailCodes: new EmailCodes(
                    authOptions.mailer,
                    authOptions.now,
                    authOptions.maxMailsPerHour,
                  ),
                }
              : {}),
            ...(authOptions.now ? { now: authOptions.now } : {}),
            ...(authOptions.trustProxy ? { trustProxy: true } : {}),
            ...(authOptions.limits ? { limits: authOptions.limits } : {}),
            reauthenticate: (invite) => api.reauthenticate(invite),
            removePush: (inviteId, endpoint) => push?.remove(inviteId, endpoint) ?? false,
          })
        : undefined;
    const homeStore = new HomeStore(db);
    const api = new PublicApi({
      db,
      memory,
      invites,
      accounts,
      ...(auth ? { auth } : {}),
      conversations,
      tasks: store,
      hub,
      messageLimiter: new RateLimiter(limits.messagesPerMinute),
      controlLimiter: new RateLimiter(limits.controlPerMinute),
      orchestrator,
      ...(push ? { push } : {}),
      artifacts,
      computer: options.computer,
      publisher,
      artifactLimiter: new RateLimiter(limits.artifactsPerMinute),
      opened: openedPages,
      previews: previewService,
      previewLimiter: new RateLimiter(limits.previewsPerMinute),
      limits,
      ...(options.timelineContent === true ? { timelineContent: true } : {}),
      ...(options.timelineLimits ? { timelineLimits: options.timelineLimits } : {}),
      onMessage: deliverMessage,
      ...(deliverAnswer ? { onAnswer: deliverAnswer } : {}),
      ...(options.duties
        ? {
            duties: new DutyRoutes(
              options.duties,
              new RateLimiter(limits.controlPerMinute),
              new RateLimiter(WEBHOOKS_PER_MINUTE),
              { active: callerActive },
            ),
          }
        : {}),
      home: new HomeRoutes(
        homeStore,
        { ...(inbox ? { inbox } : {}), ...(options.duties ? { duties: options.duties } : {}) },
        new RateLimiter(limits.controlPerMinute),
        { active: callerActive, conversationsOf: (inviteId) => conversations.idsOf(inviteId) },
      ),
      ...(inbox
        ? {
            inbox: new InboxRoutes(inbox, new RateLimiter(limits.controlPerMinute), {
              active: callerActive,
              conversationsOf: (inviteId) => conversations.idsOf(inviteId),
            }),
          }
        : {}),
    });
    // What a previous process committed and never handed over goes first.
    ownDeliveries?.start();
    const server = createServer((req, res) => {
      void api.handle(req, res);
    });
    http = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    const ownInvites = invites;
    const ownAccounts = accounts;
    const ownPush = push;
    ownPush?.start();
    const ownInbox = inbox;
    let closing: Promise<void> | undefined;
    const shutdown = async (): Promise<void> => {
      // First: runs let go of at once (their pollers and calls end, nothing is cancelled), so the
      // process can exit and the next one resumes the tasks, instead of waiting out a grace period.
      orchestrator.detachRuns();
      ownDeliveries?.stop();
      api.closeStreams();
      server.closeAllConnections();
      try {
        await ownPush?.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        try {
          await ownInbox?.stop();
        } catch (error) {
          warn('The supervisor failed to stop', error);
        }
        try {
          await ownHandler?.close?.();
        } catch (error) {
          warn('The conversation handler failed to close', error);
        }
        await mcp?.close();
      } finally {
        // Owed stops are retried by the next process over this database.
        orchestrator.close();
        // The database goes last and always: its lock is what keeps a second server out.
        ownAccounts.close();
        ownInvites.close();
        db.close();
      }
    };
    orchestrator.startRestored();
    return {
      url: `http://${options.host ?? '127.0.0.1'}:${port}`,
      mcpUrl,
      orchestrator,
      invites: ownInvites,
      accounts: ownAccounts,
      publisher,
      openStreams: () => api.openStreams,
      deliveryStats: () => ownDeliveries?.stats(),
      pushAlert: (inviteId, key) => ownPush?.alert(inviteId, key) ?? Promise.resolve(true),
      conversationsOf: (inviteId) => conversations.idsOf(inviteId),
      recordOpenedPages: (taskId, pages) =>
        orchestrator.rootSessionOfTask(taskId) === undefined
          ? 0
          : openedPages.record(taskId, pages),
      createConversation: (input) => {
        if (!/^[A-Za-z0-9_:.-]{1,128}$/u.test(input.key)) return { ok: false, reason: 'invalid' };
        if (!ownInviteStore.active(input.owner)) return { ok: false, reason: 'owner_inactive' };
        const conversation = conversations.create(input.owner, input.title, input.key);
        return { ok: true, conversationId: conversation.conversationId };
      },
      startedConversation: (input) => {
        const conversationId = conversations.startedBy(input.owner, input.key);
        return conversationId === undefined ? undefined : { conversationId };
      },
      startConversation: (input) => {
        const meta = MessageMetaSchema.safeParse(input.meta);
        const keyOk = /^[A-Za-z0-9_:.-]{1,128}$/u.test(input.key);
        const textOk = input.text.length > 0 && Buffer.byteLength(input.text) <= MAX_MESSAGE_BYTES;
        if (!meta.success || !keyOk || !textOk) return { ok: false, reason: 'invalid' };
        // Checked right before the effect, with nothing awaited in between.
        if (!ownInviteStore.active(input.owner)) return { ok: false, reason: 'owner_inactive' };
        const conversation = conversations.create(input.owner, input.title, input.key);
        const posted = conversations.post(
          conversation.conversationId,
          input.text,
          input.key,
          meta.data,
        );
        if (!posted.found) return { ok: false, reason: 'invalid' };
        deliverMessage({ messageId: posted.messageId });
        return {
          ok: true,
          conversationId: conversation.conversationId,
          messageId: posted.messageId,
          duplicate: posted.duplicate,
        };
      },
      backupDatabase: (destination) => sqliteBackup(db, destination).then(() => undefined),
      addHomeNote: (owner, note) => homeStore.addNote(owner, note),
      close: () => {
        closing ??= shutdown();
        return closing;
      },
    };
  } catch (error) {
    deliveries?.stop();
    http?.closeAllConnections();
    http?.close();
    await push?.close().catch(() => undefined);
    await Promise.resolve(inbox?.stop()).catch(() => undefined);
    await Promise.resolve(handler?.close?.()).catch(() => undefined);
    await mcp?.close().catch(() => undefined);
    try {
      accounts?.close();
      invites?.close();
    } finally {
      db.close();
    }
    throw error;
  }
}
