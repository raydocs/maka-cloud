import { DatabaseSync } from 'node:sqlite';

/** Another process (or another open in this one) already holds the supervisor database. */
export class SupervisorDatabaseInUseError extends Error {
  constructor(readonly path: string) {
    super(`The supervisor database is already open: ${path}`);
    this.name = 'SupervisorDatabaseInUseError';
  }
}

const SCHEMA_VERSION = 4;

const APPEND_ONLY = ['item_events', 'answer_log', 'verifier_spend'];

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  parent_task_id TEXT,
  runner TEXT,
  title TEXT,
  step_key TEXT NOT NULL,
  state TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  stall_raised INTEGER NOT NULL DEFAULT 0,
  finished_at INTEGER,
  manifest TEXT
);
CREATE INDEX tasks_active ON tasks (state, last_activity_at);
CREATE INDEX tasks_parent ON tasks (parent_task_id);

CREATE TABLE step_failures (
  step_key TEXT NOT NULL,
  task_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (step_key, task_id)
);

CREATE TABLE questions (
  question_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  state TEXT NOT NULL,
  asked_feed_id INTEGER NOT NULL
);
CREATE INDEX questions_open ON questions (conversation_id, state);

CREATE TABLE items (
  item_id TEXT PRIMARY KEY,
  n INTEGER NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  task_id TEXT,
  dedupe_key TEXT NOT NULL,
  ask TEXT NOT NULL,
  options TEXT NOT NULL,
  allow_text INTEGER NOT NULL,
  evidence TEXT NOT NULL,
  context TEXT NOT NULL,
  precondition TEXT NOT NULL,
  state TEXT NOT NULL,
  close_reason TEXT,
  version INTEGER NOT NULL,
  interrupt INTEGER NOT NULL,
  push_state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE UNIQUE INDEX items_open_dedupe ON items (dedupe_key) WHERE state != 'closed';
CREATE INDEX items_by_state ON items (state, n);
CREATE INDEX items_by_task ON items (task_id);
CREATE INDEX items_push ON items (push_state, n);

CREATE TABLE item_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  detail TEXT
);
CREATE INDEX item_events_item ON item_events (item_id, id);

CREATE TABLE answers (
  answer_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL UNIQUE,
  option_id TEXT NOT NULL,
  text TEXT,
  delivery TEXT NOT NULL,
  in_flight INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE answer_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  answer_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL
);
CREATE INDEX deliveries_at ON deliveries (at);

CREATE TABLE feed_outbox (item_id TEXT PRIMARY KEY, version INTEGER NOT NULL);

CREATE TABLE digests (
  digest_id TEXT PRIMARY KEY,
  slot TEXT UNIQUE,
  at INTEGER NOT NULL,
  body TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

${APPEND_ONLY.filter((table) => table !== 'verifier_spend')
  .map(
    (table) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;`,
  )
  .join('\n')}
`;

/** Added in schema 2: independent verification and its spend ledger. */
const SCHEMA_V2 = `
CREATE TABLE verifications (
  verification_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  epoch INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  result TEXT,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX verifications_due ON verifications (state, next_attempt_at);

CREATE TABLE verifier_spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  day TEXT NOT NULL,
  stage TEXT NOT NULL,
  usd REAL NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX verifier_spend_key ON verifier_spend (key, id);
CREATE INDEX verifier_spend_day ON verifier_spend (day);

CREATE TRIGGER verifier_spend_no_update BEFORE UPDATE ON verifier_spend
BEGIN SELECT RAISE(ABORT, 'verifier_spend is append-only'); END;
CREATE TRIGGER verifier_spend_no_delete BEFORE DELETE ON verifier_spend
BEGIN SELECT RAISE(ABORT, 'verifier_spend is append-only'); END;
`;

/**
 * Added in schema 3: who answered. The server checks that invite again when
 * the answer is delivered; an answer from before (NULL) is not delivered.
 */
const SCHEMA_V3 = `
ALTER TABLE answers ADD COLUMN caller TEXT;
`;

/**
 * Added in schema 4: whose digest it is. A digest summarizes the items of one owner, so its
 * model call is that owner's spend; NULL is the digest of items nobody owns.
 */
const SCHEMA_V4 = `
ALTER TABLE digests ADD COLUMN owner TEXT;
`;

/**
 * Opens the supervisor's own database for this process alone. The write paths
 * (answer claims, the hourly cap, digest slots) check and write inside one
 * transaction and assume nobody else writes, so a second opener fails at once.
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
    if (isBusy(error)) throw new SupervisorDatabaseInUseError(path);
    throw error;
  }
  db.exec('PRAGMA synchronous = FULL');
  try {
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: number }).errcode;
  return code !== undefined && [5, 6].includes(code & 0xff);
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (row.user_version === SCHEMA_VERSION) return;
  if (row.user_version > SCHEMA_VERSION) {
    throw new Error(`Unsupported supervisor database schema version ${row.user_version}`);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    if (row.user_version === 0) db.exec(SCHEMA);
    if (row.user_version < 2) db.exec(SCHEMA_V2);
    if (row.user_version < 3) db.exec(SCHEMA_V3);
    db.exec(SCHEMA_V4);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Runs `work` in one write transaction; a throw rolls everything back. Not reentrant. */
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
