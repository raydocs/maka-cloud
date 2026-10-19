import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import {
  Orchestrator,
  type OrchestratorOptions,
  OrchestratorServer,
  type OrchestratorServerOptions,
  type RunnerRegistry,
} from '@maka-cloud/orchestrator';
import { type ArtifactRead, type ArtifactSource, FileArtifactSource } from './artifacts.js';
import { ConductorFeed, type ConversationPublisher } from './conductor-feed.js';
import { ConversationStore } from './conversations.js';
import { openDatabase } from './db.js';
import { ExtensionFeed, type ExtensionEvent } from './extension-feed.js';
import { type FeedEntry, FeedHub, readFeed } from './feed.js';
import { type AnswerOutcome, DEFAULT_HTTP_LIMITS, type HttpLimits, PublicApi } from './http.js';
import { type InboxService, InboxRoutes } from './inbox.js';
import { InviteStore } from './invites.js';
import { RateLimiter } from './rate-limit.js';
import { SqliteSessionStore } from './sqlite-session-store.js';
import { SqliteTaskStore } from './sqlite-task-store.js';

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
    message: { conversationId: string; messageId: string; text: string },
    conductor: ConductorAccess,
  ): void | Promise<void>;
  /** Applies an answer to a question the handler posted. Without it the answers route is 404. */
  onAnswer?(
    answer: { conversationId: string; questionId: string; optionId: string; text?: string },
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
  /** The handler's answers route. Without a handler that takes answers, every question is `not_found`. */
  answers: {
    deliver(
      answer: { conversationId: string; questionId: string; optionId: string; text?: string },
      signal: AbortSignal,
    ): Promise<AnswerOutcome>;
  };
  /** Posts a user message into a conversation, like the messages route: idempotent on `clientMessageId`. */
  messages: {
    post(
      message: { conversationId: string; text: string; clientMessageId: string },
      signal: AbortSignal,
    ): Promise<{ messageId: string }>;
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
  orchestrator?: Pick<OrchestratorOptions, 'quotas' | 'caches' | 'maxDepth' | 'now'>;
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
  }) => ConversationHandler | Promise<ConversationHandler>;
  /** Where artifact content comes from. Default: the task's directory under `handoffRoot`. */
  artifacts?: ArtifactSource;
  sweepOrphans?: SweepOrphans;
  /**
   * Starts the supervisor once the handler exists and before the server listens, and
   * stops it before the handler and the database close. Without it the `/v1/inbox`
   * routes answer 404 and nothing else changes.
   */
  supervisor?: (parts: SupervisorParts) => InboxService | Promise<InboxService>;
  /** Reports things that must not stop the server: a failed sweep, a handler that threw. */
  onWarning?: (message: string, detail?: unknown) => void;
}

export interface CloudServer {
  /** Base URL of the public API. */
  url: string;
  mcpUrl: string;
  orchestrator: Orchestrator;
  invites: InviteStore;
  /** Where conductor output enters the conversation feed. */
  publisher: ConversationPublisher;
  /** Event streams currently open. */
  openStreams(): number;
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
  let mcp: OrchestratorServer | undefined;
  let http: Server | undefined;
  let handler: ConversationHandler | undefined;
  let inbox: InboxService | undefined;
  try {
    const hub = new FeedHub();
    const store = new SqliteTaskStore(db, hub);
    const orchestrator = await Orchestrator.create({
      ...options.orchestrator,
      store,
      sessions: new SqliteSessionStore(db, options.orchestrator?.now),
      runners: options.runners,
      handoffRoot: options.handoffRoot,
    });
    if (options.sweepOrphans) {
      try {
        const swept = await options.sweepOrphans(store.taskIds());
        if (swept.failed.length > 0) warn('sweepOrphans could not stop some runners', swept.failed);
      } catch (error) {
        warn('sweepOrphans failed', error);
      }
    }
    mcp = new OrchestratorServer(orchestrator, options.mcp);
    const mcpUrl = await mcp.listen();

    invites = new InviteStore(options.invitesPath);
    const conversations = new ConversationStore(
      db,
      hub,
      () => orchestrator.issueSession(),
      options.orchestrator?.now,
    );
    const publisher = new ConductorFeed(db, hub, options.orchestrator?.now);
    const accessFor = (sessionId: string): ConductorAccess => ({
      mcpUrl,
      rotateToken: () => {
        const rotated = orchestrator.rotateSession(sessionId);
        if (!rotated) throw new Error('The conversation has no session');
        return rotated.token;
      },
    });
    handler = options.createHandler
      ? await options.createHandler({
          publisher,
          orchestrator,
          conductorAccess: (conversationId) => {
            const sessionId = conversations.sessionOf(conversationId);
            return sessionId === undefined ? undefined : accessFor(sessionId);
          },
        })
      : options.handler;
    const ownHandler = handler;
    const limits = { ...DEFAULT_HTTP_LIMITS, ...options.http };
    const artifacts = options.artifacts ?? new FileArtifactSource(options.handoffRoot);
    const deliverMessage = (message: {
      conversationId: string;
      messageId: string;
      text: string;
      sessionId: string;
    }): void => {
      if (!ownHandler) return;
      const conductor = accessFor(message.sessionId);
      void Promise.resolve()
        .then(() =>
          ownHandler.onUserMessage(
            {
              conversationId: message.conversationId,
              messageId: message.messageId,
              text: message.text,
            },
            conductor,
          ),
        )
        .catch((error: unknown) => warn('The conversation handler failed', error));
    };
    const deliverAnswer = ownHandler?.onAnswer
      ? (answer: {
          conversationId: string;
          questionId: string;
          optionId: string;
          text?: string;
          sessionId: string;
        }): Promise<AnswerOutcome> =>
          (ownHandler.onAnswer as NonNullable<ConversationHandler['onAnswer']>)(
            {
              conversationId: answer.conversationId,
              questionId: answer.questionId,
              optionId: answer.optionId,
              ...(answer.text === undefined ? {} : { text: answer.text }),
            },
            accessFor(answer.sessionId),
          )
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
            if (sessionId === undefined || !deliverAnswer) {
              return { accepted: false, reason: 'not_found' };
            }
            return deliverAnswer({ ...answer, sessionId });
          },
        },
        messages: {
          post: async (message, signal) => {
            signal.throwIfAborted();
            const result = conversations.post(
              message.conversationId,
              message.text,
              message.clientMessageId,
            );
            if (!result.found) throw new Error('The conversation does not exist');
            if (!result.duplicate) {
              deliverMessage({
                conversationId: message.conversationId,
                messageId: result.messageId,
                text: result.text,
                sessionId: result.sessionId,
              });
            }
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
    const api = new PublicApi({
      db,
      invites,
      conversations,
      tasks: store,
      hub,
      messageLimiter: new RateLimiter(limits.messagesPerMinute),
      controlLimiter: new RateLimiter(limits.controlPerMinute),
      orchestrator,
      artifacts,
      artifactLimiter: new RateLimiter(limits.artifactsPerMinute),
      limits,
      onMessage: deliverMessage,
      ...(deliverAnswer ? { onAnswer: deliverAnswer } : {}),
      ...(inbox ? { inbox: new InboxRoutes(inbox, new RateLimiter(limits.controlPerMinute)) } : {}),
    });
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
    const ownInbox = inbox;
    let closing: Promise<void> | undefined;
    const shutdown = async (): Promise<void> => {
      api.closeStreams();
      server.closeAllConnections();
      try {
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
        // The database goes last and always: its lock is what keeps a second server out.
        ownInvites.close();
        db.close();
      }
    };
    return {
      url: `http://${options.host ?? '127.0.0.1'}:${port}`,
      mcpUrl,
      orchestrator,
      invites: ownInvites,
      publisher,
      openStreams: () => api.openStreams,
      close: () => {
        closing ??= shutdown();
        return closing;
      },
    };
  } catch (error) {
    http?.closeAllConnections();
    http?.close();
    await Promise.resolve(inbox?.stop()).catch(() => undefined);
    await Promise.resolve(handler?.close?.()).catch(() => undefined);
    await mcp?.close().catch(() => undefined);
    try {
      invites?.close();
    } finally {
      db.close();
    }
    throw error;
  }
}
