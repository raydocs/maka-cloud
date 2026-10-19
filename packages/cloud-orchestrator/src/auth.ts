import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BoundedCache, type CacheLimits } from './cache.js';
import type { SessionId, TaskId } from './types.js';

export interface SessionInfo {
  sessionId: SessionId;
  /** The task this session runs, for executor sessions. Tasks it delegates become its children. */
  parentTaskId?: TaskId;
}

export interface IssuedSession extends SessionInfo {
  /** Bearer token. Shown once; only its hash is kept. */
  token: string;
}

/** What is kept per session: who it is and the digest of its token, never the token. */
export interface StoredSession {
  info: SessionInfo;
  digest: Buffer;
}

/**
 * Where session digests live. Synchronous because every request and tool call
 * reads it. The default is a map; a server that must keep connections across a
 * restart supplies a durable one.
 */
export interface SessionStore {
  /** Inserts or replaces the entry for `sessionId`. */
  put(sessionId: SessionId, session: StoredSession): void;
  get(sessionId: SessionId): StoredSession | undefined;
  delete(sessionId: SessionId): void;
  /** Deletes every session issued for `taskId` and returns their ids. */
  deleteForTask(taskId: TaskId): SessionId[];
}

export class MemorySessionStore implements SessionStore {
  private readonly bySession = new Map<SessionId, StoredSession>();
  private readonly byTask = new Map<TaskId, Set<SessionId>>();

  put(sessionId: SessionId, session: StoredSession): void {
    this.bySession.set(sessionId, session);
    const { parentTaskId } = session.info;
    if (parentTaskId === undefined) return;
    let sessions = this.byTask.get(parentTaskId);
    if (!sessions) {
      sessions = new Set();
      this.byTask.set(parentTaskId, sessions);
    }
    sessions.add(sessionId);
  }

  get(sessionId: SessionId): StoredSession | undefined {
    return this.bySession.get(sessionId);
  }

  delete(sessionId: SessionId): void {
    const session = this.bySession.get(sessionId);
    if (!session) return;
    this.bySession.delete(sessionId);
    const { parentTaskId } = session.info;
    if (parentTaskId === undefined) return;
    const sessions = this.byTask.get(parentTaskId);
    sessions?.delete(sessionId);
    if (sessions?.size === 0) this.byTask.delete(parentTaskId);
  }

  deleteForTask(taskId: TaskId): SessionId[] {
    const sessions = [...(this.byTask.get(taskId) ?? [])];
    for (const sessionId of sessions) this.delete(sessionId);
    return sessions;
  }
}

function digestToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

const TOKEN_PREFIX = 'mko_';

/** Tokens read `mko_<sessionId>.<secret>`; the id is public and only picks the entry to compare against. */
function sessionIdOf(token: string): SessionId | undefined {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined;
  const dot = token.indexOf('.');
  return dot === -1 ? undefined : token.slice(TOKEN_PREFIX.length, dot);
}

function newToken(sessionId: SessionId): string {
  return `${TOKEN_PREFIX}${sessionId}.${randomBytes(32).toString('base64url')}`;
}

export const DEFAULT_SESSION_CACHE: CacheLimits = { maxEntries: 1024 };

/**
 * Session tokens. Tokens are never written to the task log; only digests are
 * kept. Lookups go through a small cache in front of the store; every path that
 * removes or replaces a session evicts it first, so a revoked token cannot be
 * served from the cache.
 */
export class SessionAuth {
  private readonly cache: BoundedCache<SessionId, StoredSession>;

  constructor(
    private readonly store: SessionStore = new MemorySessionStore(),
    cache: CacheLimits = DEFAULT_SESSION_CACHE,
  ) {
    this.cache = new BoundedCache(cache);
  }

  get cached(): number {
    return this.cache.size;
  }

  issue(options: { parentTaskId?: TaskId } = {}): IssuedSession {
    const sessionId = `ses_${randomBytes(8).toString('hex')}`;
    const token = newToken(sessionId);
    const info: SessionInfo = {
      sessionId,
      ...(options.parentTaskId === undefined ? {} : { parentTaskId: options.parentTaskId }),
    };
    this.store.put(sessionId, { info, digest: digestToken(token) });
    return { ...info, token };
  }

  /**
   * Replaces the secret of an existing session, for a holder that lost its
   * token. The session keeps its id, so it still sees the tasks it started; the
   * old token stops working at once.
   */
  rotate(sessionId: SessionId): IssuedSession | undefined {
    const current = this.store.get(sessionId);
    if (!current) return undefined;
    this.cache.delete(sessionId);
    const token = newToken(sessionId);
    this.store.put(sessionId, { info: current.info, digest: digestToken(token) });
    return { ...current.info, token };
  }

  resolve(token: string): SessionInfo | undefined {
    const sessionId = sessionIdOf(token);
    const entry = sessionId === undefined ? undefined : this.lookup(sessionId);
    if (!entry) return undefined;
    return timingSafeEqual(entry.digest, digestToken(token)) ? entry.info : undefined;
  }

  /** Whether the session still holds a valid token, for checks after the request was authenticated. */
  isActive(sessionId: SessionId): boolean {
    return this.lookup(sessionId) !== undefined;
  }

  revoke(sessionId: SessionId): void {
    this.cache.delete(sessionId);
    this.store.delete(sessionId);
  }

  /** Revokes the executor sessions issued for a task. */
  revokeForTask(taskId: TaskId): void {
    for (const sessionId of this.store.deleteForTask(taskId)) this.cache.delete(sessionId);
  }

  private lookup(sessionId: SessionId): StoredSession | undefined {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;
    const stored = this.store.get(sessionId);
    if (stored) this.cache.set(sessionId, stored);
    return stored;
  }
}
