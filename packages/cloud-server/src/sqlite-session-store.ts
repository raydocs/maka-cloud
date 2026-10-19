import type { DatabaseSync } from 'node:sqlite';
import type { SessionId, SessionStore, StoredSession, TaskId } from '@maka-cloud/orchestrator';

interface SessionRow {
  session_id: string;
  token_sha256: Uint8Array;
  parent_task_id: string | null;
}

/**
 * Orchestrator session digests in SQLite. Statements are single writes, so
 * calls made inside a surrounding transaction join it.
 */
export class SqliteSessionStore implements SessionStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  put(sessionId: SessionId, session: StoredSession): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO sessions (session_id, token_sha256, parent_task_id, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(sessionId, session.digest, session.info.parentTaskId ?? null, this.now());
  }

  get(sessionId: SessionId): StoredSession | undefined {
    const row = this.db
      .prepare('SELECT session_id, token_sha256, parent_task_id FROM sessions WHERE session_id = ?')
      .get(sessionId) as unknown as SessionRow | undefined;
    if (!row) return undefined;
    return {
      info: {
        sessionId: row.session_id,
        ...(row.parent_task_id === null ? {} : { parentTaskId: row.parent_task_id }),
      },
      digest: Buffer.from(row.token_sha256),
    };
  }

  delete(sessionId: SessionId): void {
    this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
  }

  deleteForTask(taskId: TaskId): SessionId[] {
    const rows = this.db
      .prepare('SELECT session_id AS id FROM sessions WHERE parent_task_id = ?')
      .all(taskId) as unknown as Array<{ id: string }>;
    this.db.prepare('DELETE FROM sessions WHERE parent_task_id = ?').run(taskId);
    return rows.map((row) => row.id);
  }
}
