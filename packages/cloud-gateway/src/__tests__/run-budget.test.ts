import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import {
  clearRunBudget,
  journalEnforcesRunBudgets,
  type ReserveResult,
  type SpendAccounts,
  SqliteSpendJournal,
  setRunBudget,
} from '../index.js';

const INVITE = { inviteId: 'inv_0123456789ab' };
const OTHER = { inviteId: 'inv_ba9876543210' };
const BIG = { dailyUsd: 1_000, monthlyUsd: 10_000 };

async function dir(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'gateway-run-budget-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function ledgerOn(journal: SqliteSpendJournal, now: () => number): SpendAccounts {
  return journal.accountLedger({
    limitsOf: () => BIG,
    serverDailyUsd: () => 10_000,
    now,
  });
}

const refused = (result: ReserveResult) => (result.ok ? undefined : result.cap?.scope);

test('a run budget holds across UTC midnight, where the daily cap starts over', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  let clock = Date.parse('2026-10-20T23:00:00Z');
  const ledger = ledgerOn(journal, () => clock);
  setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: clock });

  clock = Date.parse('2026-10-20T23:50:00Z');
  assert.deepEqual(ledger.reserve(INVITE, 'a', 4), { ok: true });
  ledger.settle('a', 4);
  // The next UTC day: the daily cap has all of its room, the run has $1 left.
  clock = Date.parse('2026-10-21T00:10:00Z');
  const over = ledger.reserve(INVITE, 'b', 4);
  assert.equal(refused(over), 'invite_run');
  assert.deepEqual(over.ok ? undefined : over.cap, {
    scope: 'invite_run',
    inviteId: INVITE.inviteId,
    limitUsd: 5,
  });
  assert.equal(over.ok ? undefined : over.budget, true);
  assert.deepEqual(ledger.reserve(INVITE, 'c', 1), { ok: true });
  assert.equal(refused(ledger.reserve(INVITE, 'd', 0.01)), 'invite_run');
});

test('a run budget counts what is held as well as what settled, and a settle below the hold frees the difference', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  const ledger = ledgerOn(journal, () => Date.parse('2026-10-20T12:00:00Z'));
  setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: Date.parse('2026-10-20T11:00:00Z') });

  assert.deepEqual(ledger.reserve(INVITE, 'a', 3), { ok: true });
  assert.equal(refused(ledger.reserve(INVITE, 'b', 2.5)), 'invite_run', 'the hold counts');
  ledger.settle('a', 1);
  assert.deepEqual(ledger.reserve(INVITE, 'b', 2.5), { ok: true });
  // A settle above its hold counts in full.
  ledger.settle('b', 4);
  assert.equal(refused(ledger.reserve(INVITE, 'c', 0.01)), 'invite_run');
});

test('a run budget survives a restart of the process that books', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const clock = Date.parse('2026-10-20T12:00:00Z');
  const first = new SqliteSpendJournal(path);
  setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: clock - 1_000 });
  assert.deepEqual(ledgerOn(first, () => clock).reserve(INVITE, 'a', 4), { ok: true });
  first.close();

  const second = new SqliteSpendJournal(path);
  t.after(() => second.close());
  const ledger = ledgerOn(second, () => clock + 60_000);
  assert.equal(refused(ledger.reserve(INVITE, 'b', 2)), 'invite_run');
  assert.deepEqual(ledger.reserve(INVITE, 'b', 1), { ok: true });
});

test('a run budget counts only what the invite booked since the run began, and only that invite', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  let clock = Date.parse('2026-10-20T10:00:00Z');
  const ledger = ledgerOn(journal, () => clock);
  assert.deepEqual(ledger.reserve(INVITE, 'before', 3), { ok: true });
  clock = Date.parse('2026-10-20T11:00:00Z');
  setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: clock });

  assert.deepEqual(
    ledger.reserve(INVITE, 'run', 5),
    { ok: true },
    'earlier spend is not the run’s',
  );
  assert.equal(refused(ledger.reserve(INVITE, 'more', 0.01)), 'invite_run');
  assert.deepEqual(ledger.reserve(OTHER, 'other', 50), { ok: true }, 'another invite has none');
  assert.deepEqual(ledger.reserve('server', 'digest', 50), { ok: true }, 'nor has the server');
});

test('replacing a run budget starts it over, and clearing it leaves the daily and monthly caps alone', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  let clock = Date.parse('2026-10-20T10:00:00Z');
  const ledger = ledgerOn(journal, () => clock);
  setRunBudget(path, INVITE.inviteId, { limitUsd: 2, sinceMs: clock });
  assert.deepEqual(ledger.reserve(INVITE, 'a', 2), { ok: true });
  assert.equal(refused(ledger.reserve(INVITE, 'b', 1)), 'invite_run');

  clock += 1_000;
  setRunBudget(path, INVITE.inviteId, { limitUsd: 2, sinceMs: clock });
  assert.deepEqual(ledger.reserve(INVITE, 'b', 2), { ok: true }, 'a new run');
  clearRunBudget(path, INVITE.inviteId);
  assert.deepEqual(ledger.reserve(INVITE, 'c', 100), { ok: true });
  clearRunBudget(path, INVITE.inviteId);
});

test('an invalid run budget or a journal that does not exist is refused, and nothing is created', async (t) => {
  const root = await dir(t);
  const missing = join(root, 'never-ran.db');
  assert.throws(
    () => setRunBudget(missing, INVITE.inviteId, { limitUsd: 5, sinceMs: 1 }),
    /has not run here/u,
  );
  assert.throws(() => clearRunBudget(missing, INVITE.inviteId), /has not run here/u);
  assert.equal(existsSync(missing), false);

  const path = join(root, 'spend.db');
  new SqliteSpendJournal(path).close();
  for (const budget of [
    { limitUsd: -1, sinceMs: 1 },
    { limitUsd: Number.NaN, sinceMs: 1 },
    { limitUsd: Number.POSITIVE_INFINITY, sinceMs: 1 },
    { limitUsd: 5, sinceMs: Number.NaN },
  ]) {
    assert.throws(() => setRunBudget(path, INVITE.inviteId, budget), RangeError);
  }
});

test('a run budget that cannot be read as a number refuses every reservation of the invite', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  const ledger = ledgerOn(journal, () => Date.parse('2026-10-20T12:00:00Z'));
  const raw = new DatabaseSync(path);
  t.after(() => raw.close());
  raw
    .prepare("INSERT INTO run_budget (account, limit_usd, since_ms) VALUES (?, 'x', 0)")
    .run(INVITE.inviteId);
  const result = ledger.reserve(INVITE, 'a', 0.01);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.budget, true);
});

test('a journal says it enforces run budgets only once a ledger that does has been opened on it', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  assert.equal(journalEnforcesRunBudgets(path), false, 'an older server never sets the marker');
  ledgerOn(journal, Date.now);
  assert.equal(journalEnforcesRunBudgets(path), true);
});

test('a journal made before spend was timed gets the column, and its old rows count for no run', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE account_spend (
      key TEXT PRIMARY KEY, account TEXT NOT NULL, day TEXT NOT NULL, month TEXT NOT NULL,
      usd REAL NOT NULL, settled INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO account_spend (key, account, day, month, usd, settled)
      VALUES ('old', '${INVITE.inviteId}', '2026-10-20', '2026-10', 4, 1);
  `);
  old.close();

  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  const clock = Date.parse('2026-10-20T12:00:00Z');
  const ledger = ledgerOn(journal, () => clock);
  setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: clock - 1_000 });
  assert.deepEqual(ledger.reserve(INVITE, 'new', 5), { ok: true });
  assert.equal(refused(ledger.reserve(INVITE, 'more', 0.01)), 'invite_run');
  // The reopened file does not add the column twice.
  new SqliteSpendJournal(path).close();
});
