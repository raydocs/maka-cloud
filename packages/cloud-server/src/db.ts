import { DatabaseSync } from 'node:sqlite';

/** Another process (or another open in this one) already holds the database. */
export class DatabaseInUseError extends Error {
  constructor(readonly path: string) {
    super(`The database is already open by another server: ${path}`);
    this.name = 'DatabaseInUseError';
  }
}

const SCHEMA_V1 = `
CREATE TABLE task_log (
  seq INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  event TEXT NOT NULL
);
CREATE INDEX task_log_task ON task_log (task_id, seq);

CREATE TABLE task_index (
  n INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  root_session_id TEXT NOT NULL,
  parent_task_id TEXT,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX task_index_parent ON task_index (parent_task_id, n);
CREATE INDEX task_index_root ON task_index (root_session_id, created_at);
CREATE INDEX task_index_state ON task_index (state);

CREATE TABLE conversations (
  conversation_id TEXT PRIMARY KEY,
  n INTEGER NOT NULL UNIQUE,
  title TEXT,
  session_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE messages (
  n INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  client_message_id TEXT,
  at INTEGER NOT NULL,
  UNIQUE (conversation_id, client_message_id)
);

CREATE TABLE feed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  conversation_id TEXT,
  ref TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX feed_conversation ON feed (conversation_id, id);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  token_sha256 BLOB NOT NULL,
  parent_task_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_task ON sessions (parent_task_id);

CREATE TABLE invites (
  invite_id TEXT PRIMARY KEY,
  token_sha256 BLOB NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

${['task_log', 'messages', 'feed']
  .map(
    (table) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;`,
  )
  .join('\n')}
`;

// Unused since task cost comes from the orchestrator's `task_cost` events; a shipped step is never edited.
const SCHEMA_V2 = `
CREATE TABLE task_cost_log (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL,
  usd REAL NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX task_cost_log_task ON task_cost_log (task_id, id);
CREATE TRIGGER task_cost_log_no_update BEFORE UPDATE ON task_cost_log
BEGIN SELECT RAISE(ABORT, 'task_cost_log is append-only'); END;
CREATE TRIGGER task_cost_log_no_delete BEFORE DELETE ON task_cost_log
BEGIN SELECT RAISE(ABORT, 'task_cost_log is append-only'); END;
`;

const SCHEMA_V3 = `
CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  since_feed_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX push_subscriptions_invite ON push_subscriptions (invite_id);
CREATE TABLE push_deliveries (
  endpoint TEXT NOT NULL,
  task_id TEXT NOT NULL,
  state TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (endpoint, task_id)
);
`;

/**
 * Step `i` takes the schema from version `i` to `i + 1`. Steps are only ever
 * appended: one that has shipped is never edited.
 */
const MIGRATIONS = [SCHEMA_V1, SCHEMA_V2, SCHEMA_V3];

/**
 * Opens the database for this process alone. `locking_mode=EXCLUSIVE` plus an
 * immediate write transaction takes the lock now, so a second server over the
 * same file fails here instead of corrupting assumptions later. The lock is the
 * kernel's, so a crashed server leaves nothing to clean up.
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('BEGIN IMMEDIATE');
    db.exec('COMMIT');
  } catch (error) {
    db.close();
    if (isBusy(error)) throw new DatabaseInUseError(path);
    throw error;
  }
  db.exec('PRAGMA synchronous = FULL');
  migrate(db);
  return db;
}

function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: number }).errcode;
  // SQLITE_BUSY (5) and SQLITE_LOCKED (6), including their extended codes.
  return code !== undefined && [5, 6].includes(code & 0xff);
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const version = row.user_version;
  if (version > MIGRATIONS.length) {
    throw new Error(`Unsupported database schema version ${version}`);
  }
  if (version === MIGRATIONS.length) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let step = version; step < MIGRATIONS.length; step += 1) {
      db.exec(MIGRATIONS[step] ?? '');
      db.exec(`PRAGMA user_version = ${step + 1}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Runs `work` in one write transaction; a throw rolls everything back. */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
