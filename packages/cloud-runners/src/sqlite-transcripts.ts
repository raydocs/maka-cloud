import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import type { TaskId } from '@maka-cloud/orchestrator';
import {
  checkAppend,
  DEFAULT_TRANSCRIPT_LIMITS,
  type TranscriptInfo,
  type TranscriptKey,
  type TranscriptLimits,
  type TranscriptLine,
  type TranscriptPage,
  type TranscriptStore,
  TranscriptFull,
} from './transcripts.js';

/** Another process already holds the transcript database. */
export class TranscriptDatabaseInUseError extends Error {
  constructor(readonly path: string) {
    super(`The transcript database is already open by another server: ${path}`);
    this.name = 'TranscriptDatabaseInUseError';
  }
}

export class TranscriptDatabaseVersionError extends Error {
  constructor(
    readonly path: string,
    readonly version: number,
  ) {
    super(`Unsupported transcript database schema version ${version}: ${path}`);
    this.name = 'TranscriptDatabaseVersionError';
  }
}

const SCHEMA_VERSION = 1;

/**
 * One row per task (the project key its transcripts use and the bytes they take), one per
 * transcript, and one per kept line. A line with a uuid is unique in its transcript, so a batch sent
 * again lands once; `n` is the line's place, counted from 0, and a read pages by it.
 */
const SCHEMA = `
CREATE TABLE transcript_tasks (
  task_id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  bytes INTEGER NOT NULL
);
CREATE TABLE transcripts (
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  subpath TEXT NOT NULL,
  lines INTEGER NOT NULL,
  PRIMARY KEY (task_id, session_id, subpath)
);
CREATE TABLE transcript_lines (
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  subpath TEXT NOT NULL,
  n INTEGER NOT NULL,
  uuid TEXT,
  json TEXT NOT NULL,
  PRIMARY KEY (task_id, session_id, subpath, n)
);
CREATE UNIQUE INDEX transcript_lines_uuid
  ON transcript_lines (task_id, session_id, subpath, uuid) WHERE uuid IS NOT NULL;
`;

/**
 * Transcripts of Claude tasks in SQLite, in a file of their own: they are large, and the server's
 * other databases stay small and quick to back up. The process holds the file exclusively, so a
 * second server over it fails at once. Every call is one write transaction; nothing awaits inside
 * one, so calls never interleave.
 */
export class SqliteTranscriptStore implements TranscriptStore {
  private readonly limits: TranscriptLimits;
  private closed = false;

  private constructor(
    private readonly db: DatabaseSync,
    limits: Partial<TranscriptLimits>,
  ) {
    this.limits = { ...DEFAULT_TRANSCRIPT_LIMITS, ...limits };
  }

  static open(path: string, limits: Partial<TranscriptLimits> = {}): SqliteTranscriptStore {
    const db = new DatabaseSync(path);
    try {
      const version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version;
      if (version !== 0 && version !== SCHEMA_VERSION) {
        throw new TranscriptDatabaseVersionError(path, version);
      }
      db.exec('PRAGMA locking_mode = EXCLUSIVE');
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('BEGIN IMMEDIATE');
      db.exec('COMMIT');
      db.exec('PRAGMA synchronous = FULL');
      if (version === 0) {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec(SCHEMA);
          db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }
    } catch (error) {
      db.close();
      const code = (error as { errcode?: number }).errcode;
      if (code !== undefined && [5, 6].includes(code & 0xff)) {
        throw new TranscriptDatabaseInUseError(path);
      }
      throw error;
    }
    return new SqliteTranscriptStore(db, limits);
  }

  async append(
    taskId: TaskId,
    key: TranscriptKey,
    lines: readonly TranscriptLine[],
  ): Promise<TranscriptLine[]> {
    checkAppend(key, lines, this.limits);
    const subpath = key.subpath ?? '';
    return this.write(() => {
      const committed: TranscriptLine[] = [];
      const task = this.db
        .prepare('SELECT project_key, bytes FROM transcript_tasks WHERE task_id = ?')
        .get(taskId) as { project_key: string; bytes: number } | undefined;
      if (task && task.project_key !== key.projectKey) {
        throw new Error(
          'transcript refused: the task keeps its transcripts under another project key',
        );
      }
      const known = this.db
        .prepare(
          'SELECT lines FROM transcripts WHERE task_id = ? AND session_id = ? AND subpath = ?',
        )
        .get(taskId, key.sessionId, subpath) as { lines: number } | undefined;
      if (!known) {
        const count = (
          this.db
            .prepare('SELECT COUNT(*) AS count FROM transcripts WHERE task_id = ?')
            .get(taskId) as { count: number }
        ).count;
        if (count >= this.limits.maxTranscripts) {
          throw new TranscriptFull(
            `the task already keeps ${this.limits.maxTranscripts} transcripts`,
          );
        }
      }
      let next = known?.lines ?? 0;
      let added = 0;
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO transcript_lines (task_id, session_id, subpath, n, uuid, json) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const line of lines) {
        const result = insert.run(
          taskId,
          key.sessionId,
          subpath,
          next,
          line.uuid ?? null,
          line.json,
        );
        if (Number(result.changes) === 0) continue;
        next++;
        added += Buffer.byteLength(line.json);
        committed.push(line);
      }
      const total = (task?.bytes ?? 0) + added;
      if (total > this.limits.maxTaskBytes) {
        // The whole batch goes: the rollback keeps nothing of it.
        throw new TranscriptFull(
          `the task's transcripts are over the ${this.limits.maxTaskBytes} byte cap`,
        );
      }
      this.db
        .prepare(
          'INSERT INTO transcript_tasks (task_id, project_key, bytes) VALUES (?, ?, ?) ON CONFLICT (task_id) DO UPDATE SET bytes = excluded.bytes',
        )
        .run(taskId, key.projectKey, total);
      this.db
        .prepare(
          'INSERT INTO transcripts (task_id, session_id, subpath, lines) VALUES (?, ?, ?, ?) ON CONFLICT (task_id, session_id, subpath) DO UPDATE SET lines = excluded.lines',
        )
        .run(taskId, key.sessionId, subpath, next);
      return committed;
    });
  }

  async locate(taskId: TaskId, sessionId: string): Promise<TranscriptInfo | undefined> {
    const row = this.db
      .prepare(
        `SELECT t.lines AS lines, k.project_key AS project_key FROM transcripts t
         JOIN transcript_tasks k ON k.task_id = t.task_id
         WHERE t.task_id = ? AND t.session_id = ? AND t.subpath = ''`,
      )
      .get(taskId, sessionId) as { lines: number; project_key: string } | undefined;
    return row && { projectKey: row.project_key, lines: row.lines };
  }

  async read(
    taskId: TaskId,
    sessionId: string,
    cursor = 0,
    maxBytes = 1024 * 1024,
  ): Promise<TranscriptPage> {
    const rows = this.db
      .prepare(
        `SELECT n, json FROM transcript_lines
         WHERE task_id = ? AND session_id = ? AND subpath = '' AND n >= ? ORDER BY n`,
      )
      .iterate(taskId, sessionId, cursor) as Iterable<{ n: number; json: string }>;
    const lines: string[] = [];
    let bytes = 0;
    for (const row of rows) {
      if (lines.length > 0 && bytes >= maxBytes) return { lines, next: row.n };
      lines.push(row.json);
      bytes += Buffer.byteLength(row.json);
    }
    return { lines };
  }

  async deleteTask(taskId: TaskId): Promise<void> {
    this.write(() => {
      for (const table of ['transcript_lines', 'transcripts', 'transcript_tasks']) {
        this.db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(taskId);
      }
    });
  }

  /** A consistent copy of the database, for the daily backup. */
  async backupTo(destination: string): Promise<void> {
    await sqliteBackup(this.db, destination);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private write<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
