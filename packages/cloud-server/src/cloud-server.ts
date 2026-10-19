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
import { ConversationStore } from './conversations.js';
import { openDatabase } from './db.js';
import { FeedHub } from './feed.js';
import { DEFAULT_HTTP_LIMITS, type HttpLimits, PublicApi } from './http.js';
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
    const limits = { ...DEFAULT_HTTP_LIMITS, ...options.http };
    const api = new PublicApi({
      db,
      invites,
      conversations,
      tasks: store,
      hub,
      messageLimiter: new RateLimiter(limits.messagesPerMinute),
      limits,
      onMessage: (message) => {
        const handler = options.handler;
        if (!handler) return;
        const conductor: ConductorAccess = {
          mcpUrl,
          rotateToken: () => {
            const rotated = orchestrator.rotateSession(message.sessionId);
            if (!rotated) throw new Error('The conversation has no session');
            return rotated.token;
          },
        };
        void Promise.resolve()
          .then(() =>
            handler.onUserMessage(
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
      openStreams: () => api.openStreams,
      close: () => {
        closing ??= shutdown();
        return closing;
      },
    };
  } catch (error) {
    http?.closeAllConnections();
    http?.close();
    await mcp?.close().catch(() => undefined);
    try {
      invites?.close();
    } finally {
      db.close();
    }
    throw error;
  }
}
