import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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

interface Entry {
  info: SessionInfo;
  digest: Buffer;
}

/** In-memory session tokens. Tokens are never written to the task log; only digests are kept. */
export class SessionAuth {
  private readonly bySession = new Map<SessionId, Entry>();

  issue(options: { parentTaskId?: TaskId } = {}): IssuedSession {
    const sessionId = `ses_${randomBytes(8).toString('hex')}`;
    const token = `${TOKEN_PREFIX}${sessionId}.${randomBytes(32).toString('base64url')}`;
    const info: SessionInfo = {
      sessionId,
      ...(options.parentTaskId === undefined ? {} : { parentTaskId: options.parentTaskId }),
    };
    this.bySession.set(sessionId, { info, digest: digestToken(token) });
    return { ...info, token };
  }

  resolve(token: string): SessionInfo | undefined {
    const sessionId = sessionIdOf(token);
    const entry = sessionId === undefined ? undefined : this.bySession.get(sessionId);
    if (!entry) return undefined;
    return timingSafeEqual(entry.digest, digestToken(token)) ? entry.info : undefined;
  }

  /** Whether the session still holds a valid token, for checks after the request was authenticated. */
  isActive(sessionId: SessionId): boolean {
    return this.bySession.has(sessionId);
  }

  revoke(sessionId: SessionId): void {
    this.bySession.delete(sessionId);
  }
}
