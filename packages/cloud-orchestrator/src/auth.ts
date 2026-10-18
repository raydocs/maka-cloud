import { createHash, randomBytes } from 'node:crypto';
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

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** In-memory session tokens. Tokens are never written to the task log. */
export class SessionAuth {
  private readonly byHash = new Map<string, SessionInfo>();
  private readonly hashBySession = new Map<SessionId, string>();

  issue(options: { parentTaskId?: TaskId } = {}): IssuedSession {
    const sessionId = `ses_${randomBytes(8).toString('hex')}`;
    const token = `mko_${randomBytes(32).toString('base64url')}`;
    const info: SessionInfo = {
      sessionId,
      ...(options.parentTaskId === undefined ? {} : { parentTaskId: options.parentTaskId }),
    };
    const hash = hashToken(token);
    this.byHash.set(hash, info);
    this.hashBySession.set(sessionId, hash);
    return { ...info, token };
  }

  resolve(token: string): SessionInfo | undefined {
    return this.byHash.get(hashToken(token));
  }

  revoke(sessionId: SessionId): void {
    const hash = this.hashBySession.get(sessionId);
    if (hash === undefined) return;
    this.byHash.delete(hash);
    this.hashBySession.delete(sessionId);
  }
}
