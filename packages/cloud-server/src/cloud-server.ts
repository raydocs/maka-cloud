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
import { type ArtifactSource, FileArtifactSource } from './artifacts.js';
import { ConductorFeed, type ConversationPublisher } from './conductor-feed.js';
import { ConversationStore } from './conversations.js';
import { openDatabase } from './db.js';
import { FeedHub } from './feed.js';
import { type AnswerOutcome, DEFAULT_HTTP_LIMITS, type HttpLimits, PublicApi } from './http.js';
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
    /**
     * The orchestrator access of a conversation, for work the handler resumes
     * at start before any message arrives (retrying cancels a crash left undone).
     */
    conductorAccess(conversationId: string): ConductorAccess | undefined;
  }) => ConversationHandler | Promise<ConversationHandler>;
  /** Where artifact content comes from. Default: the task's directory under `handoffRoot`. */
  artifacts?: ArtifactSource;
  sweepOrphans?: SweepOrphans;
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
          conductorAccess: (conversationId) => {
            const sessionId = conversations.sessionOf(conversationId);
            return sessionId === undefined ? undefined : accessFor(sessionId);
          },
        })
      : options.handler;
    const ownHandler = handler;
    const limits = { ...DEFAULT_HTTP_LIMITS, ...options.http };
    const api = new PublicApi({
      db,
      invites,
      conversations,
      tasks: store,
      hub,
      messageLimiter: new RateLimiter(limits.messagesPerMinute),
      controlLimiter: new RateLimiter(limits.controlPerMinute),
      orchestrator,
      artifacts: options.artifacts ?? new FileArtifactSource(options.handoffRoot),
      artifactLimiter: new RateLimiter(limits.artifactsPerMinute),
      limits,
      onMessage: (message) => {
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
      },
      ...(ownHandler?.onAnswer
        ? {
            onAnswer: (answer) =>
              (ownHandler.onAnswer as NonNullable<ConversationHandler['onAnswer']>)(
                {
                  conversationId: answer.conversationId,
                  questionId: answer.questionId,
                  optionId: answer.optionId,
                  ...(answer.text === undefined ? {} : { text: answer.text }),
                },
                accessFor(answer.sessionId),
              ),
          }
        : {}),
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
    let closing: Promise<void> | undefined;
    const shutdown = async (): Promise<void> => {
      api.closeStreams();
      server.closeAllConnections();
      try {
        await new Promise<void>((resolve) => server.close(() => resolve()));
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
