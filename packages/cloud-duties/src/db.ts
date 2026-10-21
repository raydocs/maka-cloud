import { DatabaseSync } from 'node:sqlite';

/** Another process (or another open in this one) already holds the duties database. */
export class DutiesDatabaseInUseError extends Error {
  constructor(readonly path: string) {
    super(`The duties database is already open: ${path}`);
    this.name = 'DutiesDatabaseInUseError';
  }
}

/**
 * The version this build writes. Version 2 is the current CI ordering ((run number, attempt)
 * folded into one number) and chains that remember their newest failure. A database of any other
 * version was written by a build that ordered runs differently, and mixing the two encodings
 * would compare unlike numbers, so it is refused rather than migrated. No deployment holds one;
 * the file is left exactly as it was. Version 3 adds the cards of T30 to version 2, and a version 2
 * database is opened by adding them.
 */
const SCHEMA_VERSION = 3;
/** Version 2 had no cards; opening it adds them (T30) and changes nothing else. */
const CARDS_FROM_VERSION = 2;

/** The duties database was written by a build this one cannot read. It is not touched. */
export class DutiesDatabaseVersionError extends Error {
  constructor(
    readonly path: string,
    readonly version: number,
  ) {
    super(
      `The duties database ${path} is schema version ${version}, written by a different build; this build reads version ${SCHEMA_VERSION}. It was left as it is: move it aside to start a new one.`,
    );
    this.name = 'DutiesDatabaseVersionError';
  }
}

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
  started_at INTEGER NOT NULL,
  -- The newest failure (in run order) the chain counted: only a later pass ends it.
  last_failure_seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX chains_by_project ON chains (project_id);

-- Review and comment events seen, so a replay of one is not a person acting again.
CREATE TABLE person_events (
  event_key TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);
CREATE INDEX person_events_by_time ON person_events (seen_at);

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
 * T30: the cards a project's scan proposes. A card is the proposal of one task; accepting it starts
 * one conversation and nothing else. `day` is the UTC day it was made (the daily cap counts it);
 * a card that refreshed another has `replaces` set and does not count as new. `card_kinds`
 * keeps the counts that back a kind off and the owner's switch per kind and project.
 */
const CARDS_SCHEMA = `
CREATE TABLE cards (
  card_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  brief TEXT NOT NULL,
  estimate_micro INTEGER NOT NULL CHECK (estimate_micro > 0),
  precondition TEXT NOT NULL,
  external INTEGER NOT NULL CHECK (external IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('open', 'accepted', 'dismissed', 'stale', 'expired')),
  day TEXT NOT NULL,
  replaces TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  conversation_id TEXT
);
CREATE UNIQUE INDEX cards_one_open ON cards (project_id, kind, subject_key) WHERE state = 'open';
CREATE INDEX cards_by_project ON cards (project_id, day);
CREATE INDEX cards_by_subject ON cards (project_id, kind, subject_key);
CREATE INDEX cards_by_owner ON cards (owner);

CREATE TABLE card_kinds (
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 0,
  dismissed INTEGER NOT NULL DEFAULT 0,
  ignored INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  offer TEXT NOT NULL DEFAULT 'none' CHECK (offer IN ('none', 'due', 'offered', 'off')),
  PRIMARY KEY (project_id, kind)
);
`;

/**
 * Opens the duties database for this process alone: claims check the day's cap and write in one
 * transaction and assume nobody else writes, so a second opener fails at once.
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    // Before anything is changed in the file, not even its journal mode.
    const version = userVersion(db);
    if (version !== 0 && version !== SCHEMA_VERSION && version !== CARDS_FROM_VERSION) {
      throw new DutiesDatabaseVersionError(path, version);
    }
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

function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

/** Makes the tables of a new database, or adds the cards to a version 2 one. Any other version was refused on open. */
function migrate(db: DatabaseSync): void {
  const version = userVersion(db);
  if (version === SCHEMA_VERSION) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (version === 0) db.exec(SCHEMA);
    db.exec(CARDS_SCHEMA);
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
