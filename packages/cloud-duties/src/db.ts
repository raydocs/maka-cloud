import { DatabaseSync } from 'node:sqlite';

/** Another process (or another open in this one) already holds the duties database. */
export class DutiesDatabaseInUseError extends Error {
  constructor(readonly path: string) {
    super(`The duties database is already open: ${path}`);
    this.name = 'DutiesDatabaseInUseError';
  }
}

const SCHEMA_VERSION = 1;

/**
 * Money columns are whole micro-dollars. `run_requests` is the ledger of a duty's runs: its
 * reservation (`reserved_micro`) counts against the day's cap until the request ends, and then the
 * amount actually spent (`spent_micro`) takes its place. A request in a terminal state always has
 * `spent_micro` set, so no reservation is left behind.
 */
const SCHEMA = `
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL UNIQUE,
  installation_id INTEGER NOT NULL,
  default_branch TEXT NOT NULL,
  self_logins TEXT NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX projects_by_owner ON projects (owner);

CREATE TABLE duties (
  duty_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  proposal_id TEXT,
  name TEXT NOT NULL,
  trigger TEXT NOT NULL,
  instruction TEXT NOT NULL,
  authority TEXT NOT NULL CHECK (authority IN ('read-only', 'open-pr', 'merge-when-green')),
  run_budget_micro INTEGER NOT NULL CHECK (run_budget_micro > 0),
  daily_cap_micro INTEGER NOT NULL CHECK (daily_cap_micro >= run_budget_micro),
  state TEXT NOT NULL CHECK (state IN ('proposed', 'active', 'off')),
  activated_at INTEGER,
  last_slot INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  off_reason TEXT CHECK (off_reason IS NULL OR off_reason IN ('failures')),
  created_at INTEGER NOT NULL
);
CREATE INDEX duties_by_project ON duties (project_id, state);

CREATE TABLE proposals (
  proposal_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  sets TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'decided')),
  decided_set TEXT,
  decided_by TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE UNIQUE INDEX proposals_one_open ON proposals (project_id) WHERE state = 'open';

CREATE TABLE deliveries (
  delivery_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  repo TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX deliveries_by_time ON deliveries (received_at);

CREATE TABLE ci_state (
  scope TEXT PRIMARY KEY,
  last_success_seq INTEGER NOT NULL
);

-- How many runs in a row an own branch's CI failures have woken, so a duty's own output cannot wake
-- duties forever. The row goes when the branch's workflow passes or a person acts on the project.
CREATE TABLE chains (
  chain_key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  depth INTEGER NOT NULL,
  started_at INTEGER NOT NULL
);
CREATE INDEX chains_by_project ON chains (project_id);

-- Things the owner must be told that no run says: delivered at least once by the host.
CREATE TABLE notices (
  notice_key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  project_id TEXT NOT NULL,
  duty_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);

CREATE TABLE run_requests (
  request_id TEXT PRIMARY KEY,
  duty_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  trigger_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'launching', 'started', 'done', 'skipped', 'cancelled')),
  reason TEXT,
  brief TEXT NOT NULL,
  external INTEGER NOT NULL,
  authority TEXT NOT NULL,
  run_budget_micro INTEGER NOT NULL,
  day TEXT NOT NULL,
  reserved_micro INTEGER NOT NULL,
  spent_micro INTEGER,
  supersede_scope TEXT,
  supersede_seq INTEGER,
  conversation_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  UNIQUE (duty_id, trigger_key),
  CHECK (state NOT IN ('done', 'skipped', 'cancelled') OR spent_micro IS NOT NULL)
);
CREATE INDEX run_requests_due ON run_requests (state, next_attempt_at);
CREATE INDEX run_requests_day ON run_requests (duty_id, day);
`;

/**
 * Opens the duties database for this process alone: claims check the day's cap and write in one
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
    if (isBusy(error)) throw new DutiesDatabaseInUseError(path);
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
    throw new Error(`Unsupported duties database schema version ${row.user_version}`);
  }
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
