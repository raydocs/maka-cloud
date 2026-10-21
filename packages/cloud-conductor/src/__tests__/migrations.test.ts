import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { CONDUCTOR_MIGRATIONS, ConductorState } from '../state.js';

/** The schema #27 shipped (packages/cloud-conductor/src/state.ts at 375f31d), copied as it was. */
const SCHEMA_27 = `
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  maka_session_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS maka_sessions (
  maka_session_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  run_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  n INTEGER NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  state TEXT NOT NULL,
  playbook TEXT,
  budget_usd REAL NOT NULL,
  notices INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT
);
CREATE INDEX IF NOT EXISTS runs_by_conversation ON runs (conversation_id, n);
CREATE TABLE IF NOT EXISTS inputs (
  input_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  n INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  usd REAL NOT NULL,
  ref TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_by_run ON ledger (run_id);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_model_once ON ledger (ref) WHERE kind = 'model';
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger
  BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger
  BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TABLE IF NOT EXISTS external_charges (
  key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  task_id TEXT,
  max_usd REAL NOT NULL,
  reservation INTEGER NOT NULL,
  actual_usd REAL
);
CREATE TABLE IF NOT EXISTS run_tasks (
  task_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  reservation INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  question_id TEXT PRIMARY KEY,
  n INTEGER NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  question TEXT NOT NULL,
  options TEXT NOT NULL,
  recommended TEXT NOT NULL,
  raise_to_usd REAL,
  action_ref TEXT,
  state TEXT NOT NULL,
  answer TEXT,
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE TABLE IF NOT EXISTS held_actions (
  action_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

/** #36's tables as its code created them on a #27 database: new tables, but no new columns. */
const TABLES_36 = `
CREATE TABLE IF NOT EXISTS delegations (
  key TEXT PRIMARY KEY,
  task_id TEXT UNIQUE,
  run_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  reservation INTEGER NOT NULL,
  state TEXT NOT NULL,
  actual_usd REAL,
  cancel_pending INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  n INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  completes_run TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  acked_at INTEGER
);
`;

async function tempDb(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-migrate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'conductor.db');
}

/** A #27 database with one run that delegated a task and asked a question. */
function write27(path: string, extra = ''): void {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA_27);
  db.exec(`
INSERT INTO conversations VALUES ('cnv_1', 'mks_1', 1000);
INSERT INTO runs (run_id, n, conversation_id, state, playbook, budget_usd, notices, created_at)
  VALUES ('run_1', 1, 'cnv_1', 'waiting', 'research', 5, 0, 1000);
INSERT INTO ledger (n, run_id, kind, usd, ref, at) VALUES (1, 'run_1', 'reserve', 2, 'tsk_1', 1100);
INSERT INTO run_tasks VALUES ('tsk_1', 'run_1', 1);
INSERT INTO questions (question_id, n, run_id, conversation_id, reason, question, options, recommended, state, created_at)
  VALUES ('qst_1', 1, 'run_1', 'cnv_1', 'taste', 'A or B?', '[{"id":"a","label":"A"},{"id":"b","label":"B"}]', 'a', 'open', 1200);
${extra}`);
  db.close();
}

function userVersion(path: string): number {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}

function tables(path: string): string[] {
  const db = new DatabaseSync(path);
  try {
    return (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
  } finally {
    db.close();
  }
}

function assertUpgraded(state: ConductorState): void {
  // The column #36 added is there: reading the budget reads blocked_reason.
  assert.equal(state.budget('run_1').blockedReason, null);
  // The #27 task is a bound delegation that still holds its whole reservation.
  assert.deepEqual(state.tasksOf('run_1'), ['tsk_1']);
  assert.deepEqual(
    state.unsettledDelegations().map((delegation) => ({
      key: delegation.key,
      taskId: delegation.taskId,
      state: delegation.state,
      reservedUsd: delegation.reservedUsd,
      conversationId: delegation.conversationId,
    })),
    [
      {
        key: 'legacy_tsk_1',
        taskId: 'tsk_1',
        state: 'bound',
        reservedUsd: 2,
        conversationId: 'cnv_1',
      },
    ],
  );
  assert.equal(state.budget('run_1').reservedUsd, 2);
  // A run from before modes has none picked (T25).
  assert.equal(state.run('run_1')?.mode, null);
  // The question survived, and the columns it gained read as empty.
  assert.equal(state.question('qst_1')?.state, 'open');
  // The outbox works.
  state.enqueueNotice({ conversationId: 'cnv_1' }, 'Back up.');
  assert.equal(state.nextOutbox('cnv_1')?.kind, 'notice');
}

test('a #27 database is upgraded in place: new columns, its tasks become delegations, versioned', async (t) => {
  const path = await tempDb(t);
  write27(path);
  const state = new ConductorState(path);
  t.after(() => state.close());
  assertUpgraded(state);
  state.close();
  assert.equal(userVersion(path), CONDUCTOR_MIGRATIONS.length);
  assert.ok(!tables(path).includes('run_tasks'), 'run_tasks is folded into delegations');
  // Opening it again is a no-op.
  const again = new ConductorState(path);
  assertUpgraded(again);
  again.close();
});

test('a #27 database that #36 opened before migrations existed is completed too', async (t) => {
  const path = await tempDb(t);
  write27(path, TABLES_36);
  const state = new ConductorState(path);
  t.after(() => state.close());
  assertUpgraded(state);
});

test('a fresh database gets the same schema as an upgraded one', async (t) => {
  const fresh = await tempDb(t);
  const upgraded = await tempDb(t);
  write27(upgraded);
  new ConductorState(fresh).close();
  new ConductorState(upgraded).close();
  const shape = (path: string) => {
    const db = new DatabaseSync(path);
    try {
      return (
        db
          .prepare(
            "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all() as Array<{ type: string; name: string }>
      ).map((row) => {
        const columns =
          row.type === 'table'
            ? (db.prepare(`PRAGMA table_info(${row.name})`).all() as Array<{ name: string }>)
                .map((info) => info.name)
                .sort()
                .join(',')
            : '';
        return `${row.type} ${row.name} ${columns}`;
      });
    } finally {
      db.close();
    }
  };
  assert.deepEqual(shape(fresh), shape(upgraded));
  assert.equal(userVersion(fresh), CONDUCTOR_MIGRATIONS.length);
});

test('a step that fails rolls the whole upgrade back', async (t) => {
  const path = await tempDb(t);
  // A task whose run is gone cannot become a delegation (it has no conversation):
  // the upgrade must stop rather than drop the reservation.
  write27(
    path,
    "INSERT INTO ledger (n, run_id, kind, usd, ref, at) VALUES (2, 'run_gone', 'reserve', 1, 'tsk_2', 1300);\nINSERT INTO run_tasks VALUES ('tsk_2', 'run_gone', 2);",
  );
  assert.throws(() => new ConductorState(path), /NOT NULL/);
  assert.equal(userVersion(path), 0);
  const left = tables(path);
  assert.ok(left.includes('run_tasks'), 'nothing was dropped');
  assert.ok(!left.includes('delegations'), 'nothing was created');
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  const columns = (db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>).map(
    (info) => info.name,
  );
  assert.ok(!columns.includes('blocked_reason'), 'no column was added');
});

test('a database from a newer version is refused and left alone', async (t) => {
  const path = await tempDb(t);
  new ConductorState(path).close();
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA user_version = ${CONDUCTOR_MIGRATIONS.length + 1}`);
  db.close();
  assert.throws(() => new ConductorState(path), /Unsupported conductor database schema version/);
  assert.equal(userVersion(path), CONDUCTOR_MIGRATIONS.length + 1);
});
