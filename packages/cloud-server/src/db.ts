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

/**
 * Step `i` takes the schema from version `i` to `i + 1`. Steps are only ever
 * appended: one that has shipped is never edited.
 */
/**
 * v3: what the conductor publishes into a conversation (notices, questions,
 * answers), one row per event, keyed by the event's stable id so a retried
 * publish is a no-op. Assistant messages also record their event id here and
 * live in `messages` with role 'assistant'.
 */
const SCHEMA_V3 = `
CREATE TABLE conductor_events (
  event_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  data TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TRIGGER conductor_events_no_update BEFORE UPDATE ON conductor_events
BEGIN SELECT RAISE(ABORT, 'conductor_events is append-only'); END;
CREATE TRIGGER conductor_events_no_delete BEFORE DELETE ON conductor_events
BEGIN SELECT RAISE(ABORT, 'conductor_events is append-only'); END;
`;

/**
 * v4: what components that share the server process (the supervisor's inbox) put
 * into the feed, one row per event. The feed kind says whose event it is, so
 * nothing about a component is baked into the feed schema.
 */
const SCHEMA_V4 = `
CREATE TABLE extension_events (
  event_id INTEGER PRIMARY KEY,
  conversation_id TEXT,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TRIGGER extension_events_no_update BEFORE UPDATE ON extension_events
BEGIN SELECT RAISE(ABORT, 'extension_events is append-only'); END;
CREATE TRIGGER extension_events_no_delete BEFORE DELETE ON extension_events
BEGIN SELECT RAISE(ABORT, 'extension_events is append-only'); END;
`;

/**
 * v5: per-invite isolation and durable message delivery.
 *
 * `owner` is the invite that created the conversation; tasks, artifacts, inbox
 * items and feed rows belong to whoever owns their conversation. Conversations
 * from before v5 keep a NULL owner: no invite sees them until
 * `cloud-server conversation adopt` gives them to one.
 *
 * `message_deliveries` holds one row per user message, written in the
 * message's own transaction, until the handler acknowledges it. Messages from
 * before v5 get no row: they were handed over at the time, or not at all, and
 * replaying them after an upgrade would start runs nobody just asked for.
 */
const SCHEMA_V5 = `
ALTER TABLE conversations ADD COLUMN owner TEXT;
CREATE INDEX conversations_owner ON conversations (owner, n);

CREATE TABLE message_deliveries (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX message_deliveries_pending ON message_deliveries (next_attempt_at)
  WHERE delivered_at IS NULL;
`;

/**
 * v6: which tasks owe a stop (`task_stop_pending` with no `task_stopped` after
 * it), ended or not, so a restart finds the stops it must retry.
 */
const SCHEMA_V6 = `
ALTER TABLE task_index ADD COLUMN stop_pending INTEGER NOT NULL DEFAULT 0;
CREATE INDEX task_index_stop_pending ON task_index (n) WHERE stop_pending = 1;
`;

/**
 * v7: Web Push. A subscription belongs to the invite that registered it;
 * `since_feed_id` is where the feed stood when the device subscribed, so only
 * tasks that end after that are sent. `push_deliveries` records each message
 * once, so a restart neither loses nor repeats one.
 */
const SCHEMA_V7 = `
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
 * v8 (T23): what a message carries besides its text when it was started by a standing duty, kept
 * with the message so a delivery that is retried after a crash still taints the conversation and
 * still carries the run's limits. Only in-process callers write it; the public routes cannot.
 * `system_starts` makes starting a conversation idempotent on the caller's key.
 */
const SCHEMA_V8 = `
CREATE TABLE message_meta (
  message_id TEXT PRIMARY KEY,
  external INTEGER NOT NULL,
  run TEXT
);
CREATE TRIGGER message_meta_no_update BEFORE UPDATE ON message_meta
BEGIN SELECT RAISE(ABORT, 'message_meta is append-only'); END;
CREATE TRIGGER message_meta_no_delete BEFORE DELETE ON message_meta
BEGIN SELECT RAISE(ABORT, 'message_meta is append-only'); END;
CREATE TABLE system_starts (
  start_key TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL
);
`;

/**
 * v9 (T24): the pages a task actually opened, written only by trusted in-process code. The preview
 * proxy fetches nothing that is not a row here. `label` is one of a fixed set of words.
 */
const SCHEMA_V9 = `
CREATE TABLE opened_pages (
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  url TEXT NOT NULL,
  label TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, seq),
  UNIQUE (task_id, url)
);
`;

/**
 * v10 (T28): the epoch of the attempt that drives a task. A task starts at 1 (its creation is the
 * first attempt, which is also what every task already in the log is), and each `task_attempt`
 * event raises it by one. The log append checks it in its own transaction, so a writer from an
 * older attempt is refused and never reaches the log.
 */
const SCHEMA_V10 = `
ALTER TABLE task_index ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1;
`;

/**
 * v11 (T25): the mode the user picked for a message, kept with it like the rest of its meta so a
 * delivery retried after a crash still starts its run in that mode. Public routes may set it
 * (nothing else in the meta); the column is null for every message before this.
 */
const SCHEMA_V11 = `
ALTER TABLE message_meta ADD COLUMN mode TEXT;
`;

/**
 * v12 (T28, Hark pattern 4): what the server keeps of an owner's Home. The visit is when the owner
 * last left Home (what finished since is new); a card's seen time and the owner's own order are per
 * owner and per card; notes are the employee's one-fact cards, kept as a template and typed
 * parameters, never as text.
 */
const SCHEMA_V12 = `
CREATE TABLE home_visits (
  owner TEXT PRIMARY KEY,
  visited_at INTEGER NOT NULL
);

CREATE TABLE home_seen (
  owner TEXT NOT NULL,
  card_id TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (owner, card_id)
);

CREATE TABLE home_order (
  owner TEXT NOT NULL,
  card_id TEXT NOT NULL,
  pos INTEGER NOT NULL,
  PRIMARY KEY (owner, card_id)
);

CREATE TABLE home_notes (
  note_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  dedupe TEXT NOT NULL,
  template TEXT NOT NULL,
  params TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (owner, dedupe)
);
CREATE INDEX home_notes_owner ON home_notes (owner, created_at);
`;

export const MIGRATIONS: readonly string[] = [
  SCHEMA_V1,
  SCHEMA_V2,
  SCHEMA_V3,
  SCHEMA_V4,
  SCHEMA_V5,
  SCHEMA_V6,
  SCHEMA_V7,
  SCHEMA_V8,
  SCHEMA_V9,
  SCHEMA_V10,
  SCHEMA_V11,
  SCHEMA_V12,
  `CREATE TABLE home_setup (owner TEXT NOT NULL, step TEXT NOT NULL, until_at INTEGER NOT NULL,
     PRIMARY KEY (owner, step));
   CREATE TABLE home_permissions (owner TEXT PRIMARY KEY, notifications_allowed INTEGER NOT NULL);`,
  'ALTER TABLE home_seen ADD COLUMN content_version TEXT;',
];

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
