import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import {
  Allowance,
  accountPort,
  type BudgetPort,
  clearRunBudget,
  journalEnforcesRunBudgets,
  RUN_LEASE_MS,
  RunBudgetHeld,
  renewRunBudget,
  LimitPort,
  type ReserveResult,
  type SpendAccounts,
  SqliteSpendJournal,
  setRunBudget,
} from '../index.js';

const INVITE = { inviteId: 'inv_0123456789ab' };
const OTHER = { inviteId: 'inv_ba9876543210' };
const RUN = 'run_0123456789ab';
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

/** A credential issued now: a grant's port, stamped with the invite's generation at this moment. */
const issue = (ledger: SpendAccounts, usd = 1_000): BudgetPort =>
  accountPort(new LimitPort([new Allowance(usd)]), ledger, INVITE);

/** The invite as a credential issued at this moment names it: with the generation its runs are on. */
const at = (ledger: SpendAccounts, who = INVITE) => ({
  ...who,
  generation: ledger.generationOf?.(who.inviteId),
});

const refused = (result: ReserveResult) => (result.ok ? undefined : result.cap?.scope);

test('a run budget holds across UTC midnight, where the daily cap starts over', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  let clock = Date.parse('2026-10-20T23:00:00Z');
  const ledger = ledgerOn(journal, () => clock);
  setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: clock }, RUN);

  clock = Date.parse('2026-10-20T23:50:00Z');
  assert.deepEqual(ledger.reserve(at(ledger), 'a', 4), { ok: true });
  ledger.settle('a', 4);
  // The next UTC day: the daily cap has all of its room, the run has $1 left.
  clock = Date.parse('2026-10-21T00:10:00Z');
  const over = ledger.reserve(at(ledger), 'b', 4);
  assert.equal(refused(over), 'invite_run');
  assert.deepEqual(over.ok ? undefined : over.cap, {
    scope: 'invite_run',
    inviteId: INVITE.inviteId,
    limitUsd: 5,
  });
  assert.equal(over.ok ? undefined : over.budget, true);
  assert.deepEqual(ledger.reserve(at(ledger), 'c', 1), { ok: true });
  assert.equal(refused(ledger.reserve(at(ledger), 'd', 0.01)), 'invite_run');
});

test('a run budget counts what is held as well as what settled, and a settle below the hold frees the difference', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  const ledger = ledgerOn(journal, () => Date.parse('2026-10-20T12:00:00Z'));
  setRunBudget(
    path,
    INVITE.inviteId,
    { limitUsd: 5, sinceMs: Date.parse('2026-10-20T11:00:00Z') },
    RUN,
  );

  assert.deepEqual(ledger.reserve(at(ledger), 'a', 3), { ok: true });
  assert.equal(refused(ledger.reserve(at(ledger), 'b', 2.5)), 'invite_run', 'the hold counts');
  ledger.settle('a', 1);
  assert.deepEqual(ledger.reserve(at(ledger), 'b', 2.5), { ok: true });
  // A settle above its hold counts in full.
  ledger.settle('b', 4);
  assert.equal(refused(ledger.reserve(at(ledger), 'c', 0.01)), 'invite_run');
});

test('a run budget survives a restart of the process that books', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const clock = Date.parse('2026-10-20T12:00:00Z');
  const first = new SqliteSpendJournal(path);
  setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: clock - 1_000 }, RUN);
  const firstLedger = ledgerOn(first, () => clock);
  assert.deepEqual(firstLedger.reserve(at(firstLedger), 'a', 4), { ok: true });
  first.close();

  const second = new SqliteSpendJournal(path);
  t.after(() => second.close());
  const ledger = ledgerOn(second, () => clock + 60_000);
  assert.equal(refused(ledger.reserve(at(ledger), 'b', 2)), 'invite_run');
  assert.deepEqual(ledger.reserve(at(ledger), 'b', 1), { ok: true });
});

test('a run budget counts only what the invite booked since the run began, and only that invite', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  let clock = Date.parse('2026-10-20T10:00:00Z');
  const ledger = ledgerOn(journal, () => clock);
  assert.deepEqual(ledger.reserve(at(ledger), 'before', 3), { ok: true });
  clock = Date.parse('2026-10-20T11:00:00Z');
  setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: clock }, RUN);

  assert.deepEqual(
    ledger.reserve(at(ledger), 'run', 5),
    { ok: true },
    'earlier spend is not the run’s',
  );
  assert.equal(refused(ledger.reserve(at(ledger), 'more', 0.01)), 'invite_run');
  assert.deepEqual(ledger.reserve(OTHER, 'other', 50), { ok: true }, 'another invite has none');
  assert.deepEqual(ledger.reserve('server', 'digest', 50), { ok: true }, 'nor has the server');
});

test('the run that holds a budget may set it again, but that never gives it a fresh start; clearing leaves the daily and monthly caps alone', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  let clock = Date.parse('2026-10-20T10:00:00Z');
  const ledger = ledgerOn(journal, () => clock);
  setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: clock }, RUN);
  const credential = issue(ledger);
  assert.deepEqual(credential.reserve('a', 3), { ok: true });

  // A retry, or a changed limit: the $3 still counts, and the credential still books.
  clock += 1_000;
  assert.deepEqual(
    setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: clock }, RUN, clock),
    { fenced: false },
  );
  assert.deepEqual(credential.reserve('c', 2), { ok: true }, 'the $2 left is all there is');
  assert.equal(refused(credential.reserve('b', 3)), 'invite_run', 'the window did not start over');

  assert.equal(clearRunBudget(path, INVITE.inviteId, RUN), true);
  assert.deepEqual(issue(ledger).reserve('d', 100), { ok: true });
  assert.equal(clearRunBudget(path, INVITE.inviteId, RUN), false);
});

test('an invalid run budget or a journal that does not exist is refused, and nothing is created', async (t) => {
  const root = await dir(t);
  const missing = join(root, 'never-ran.db');
  assert.throws(
    () => setRunBudget(missing, INVITE.inviteId, { limitUsd: 5, sinceMs: 1 }, RUN),
    /has not run here/u,
  );
  assert.throws(() => clearRunBudget(missing, INVITE.inviteId, RUN), /has not run here/u);
  assert.equal(existsSync(missing), false);

  const path = join(root, 'spend.db');
  new SqliteSpendJournal(path).close();
  for (const budget of [
    { limitUsd: -1, sinceMs: 1 },
    { limitUsd: Number.NaN, sinceMs: 1 },
    { limitUsd: Number.POSITIVE_INFINITY, sinceMs: 1 },
    { limitUsd: 5, sinceMs: Number.NaN },
  ]) {
    assert.throws(() => setRunBudget(path, INVITE.inviteId, budget, RUN), RangeError);
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
  const result = ledger.reserve(at(ledger), 'a', 0.01);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.budget, true);
});

test('a journal carries its run budget guard from the first time new code opens it', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE account_spend (
      key TEXT PRIMARY KEY, account TEXT NOT NULL, day TEXT NOT NULL, month TEXT NOT NULL,
      usd REAL NOT NULL, settled INTEGER NOT NULL DEFAULT 0
    );
  `);
  old.close();
  assert.equal(journalEnforcesRunBudgets(path), false, 'a file only an older server has opened');
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  assert.equal(journalEnforcesRunBudgets(path), true);
});

test('a server that does not know run budgets or generations books nothing once the invite has had a run, and one that only lacks the time is counted', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  // The server that is running already, on code from before run budgets: it inserts without a time
  // and without a generation.
  const olderServer = new DatabaseSync(path);
  t.after(() => olderServer.close());
  const book = (key: string, usd: number, generation: number | null = null): void => {
    olderServer
      .prepare(
        'INSERT INTO account_spend (key, account, day, month, usd, generation) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(key, INVITE.inviteId, '2026-10-20', '2026-10', usd, generation);
  };
  book('before', 100);
  // Booked long before the run, as an earlier day's spend is.
  olderServer.exec("UPDATE account_spend SET booked_at = 1 WHERE key = 'before'");

  setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: Date.now() - 1000 }, RUN);
  // From the first run on, code that stamps no generation books nothing on this invite, however little.
  assert.throws(() => book('first', 0.01), /no run generation/u);
  // A server that stamps the generation but not the time (the previous version) is counted: its row
  // gets the time of the insert, and the guard holds it to the run's $5.
  book('stamped-first', 4, 1);
  assert.throws(
    () => book('stamped-second', 2, 1),
    /run budget/u,
    'the $2 would take the run past $5',
  );
  book('stamped-third', 1, 1);
  const rows = olderServer.prepare('SELECT key FROM account_spend ORDER BY key').all() as Array<{
    key: string;
  }>;
  assert.deepEqual(
    rows.map((row) => row.key),
    ['before', 'stamped-first', 'stamped-third'],
  );
  const stamped = olderServer
    .prepare("SELECT booked_at FROM account_spend WHERE key = 'stamped-first'")
    .get() as { booked_at: number };
  assert.ok(Math.abs(stamped.booked_at - Date.now()) < 60_000, 'a row without a time gets its own');

  // Once the run ends the invite is held to its daily and monthly caps alone, for code that stamps
  // the generation it is on; code that stamps none stays out (the invite has had a run).
  assert.equal(clearRunBudget(path, INVITE.inviteId, RUN), true);
  assert.throws(() => book('after-null', 50), /no run generation/u);
  assert.throws(() => book('after-stale', 50, 1), /earlier run/u);
  book('after', 50, 2);
});

test('a booking right after the budget is set counts, even when its timestamp falls before the start of the window', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  // The window starts a minute ahead of the clock, as a truncated stamp or a clock that stepped
  // back leaves it: nothing booked from here carries a time inside the window.
  setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: Date.now() + 60_000 }, RUN);

  const ledger = ledgerOn(journal, Date.now);
  assert.deepEqual(ledger.reserve(at(ledger), 'first', 4), { ok: true });
  assert.equal(
    refused(ledger.reserve(at(ledger), 'second', 4)),
    'invite_run',
    'the ledger counts it',
  );

  // A server that does not know run budgets stamps its rows with the time of the insert.
  const olderServer = new DatabaseSync(path);
  t.after(() => olderServer.close());
  const book = (key: string, usd: number): void => {
    olderServer
      .prepare(
        'INSERT INTO account_spend (key, account, day, month, usd, generation) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        key,
        INVITE.inviteId,
        '2026-10-20',
        '2026-10',
        usd,
        ledger.generationOf?.(INVITE.inviteId) ?? null,
      );
  };
  assert.throws(() => book('older', 2), /run budget/u, 'and so does the guard');
  book('small', 1);
});

test('the guard is the journal’s own: a process that only opened the file and failed to start changes nothing about who is bound', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  setRunBudget(path, INVITE.inviteId, { limitUsd: 1, sinceMs: Date.now() - 1000 }, RUN);
  // A server on new code opens the file and then fails to start; an older server keeps running.
  const failedStart = new SqliteSpendJournal(path);
  failedStart.close();
  const olderServer = new DatabaseSync(path);
  t.after(() => olderServer.close());
  assert.throws(
    () =>
      olderServer
        .prepare(
          'INSERT INTO account_spend (key, account, day, month, usd, generation) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('x', INVITE.inviteId, '2026-10-20', '2026-10', 2, 1),
    /run budget/u,
  );
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
  setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: clock - 1_000 }, RUN);
  assert.deepEqual(ledger.reserve(at(ledger), 'new', 5), { ok: true });
  assert.equal(refused(ledger.reserve(at(ledger), 'more', 0.01)), 'invite_run');
  // The reopened file does not add the column twice.
  new SqliteSpendJournal(path).close();
});

test('one run holds an invite’s run budget at a time: a second run is refused while the first renews it, and takes it over once nobody does', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  const t0 = Date.parse('2026-10-20T12:00:00Z');
  setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: t0 }, 'run_a', t0);

  // A second run is refused and changes nothing, however often it asks.
  const other = () =>
    setRunBudget(path, INVITE.inviteId, { limitUsd: 50, sinceMs: t0 + 1 }, 'run_b', t0 + 1_000);
  assert.throws(other, RunBudgetHeld);
  // The first run keeps it by renewing.
  assert.equal(renewRunBudget(path, INVITE.inviteId, 'run_a', t0 + RUN_LEASE_MS - 1), true);
  assert.throws(
    () =>
      setRunBudget(
        path,
        INVITE.inviteId,
        { limitUsd: 50, sinceMs: t0 },
        'run_b',
        t0 + RUN_LEASE_MS + 5_000,
      ),
    RunBudgetHeld,
  );
  const ledger = ledgerOn(journal, () => t0 + 10);
  assert.deepEqual(ledger.reserve(at(ledger), 'a', 5), { ok: true });
  assert.equal(
    refused(ledger.reserve(at(ledger), 'b', 1)),
    'invite_run',
    'still the first run’s $5',
  );

  // The same run may set it again (a retry), and a run nobody renews is taken over from scratch.
  setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: t0 }, 'run_a', t0 + 10);
  const later = t0 + 10 + RUN_LEASE_MS + 1;
  setRunBudget(path, INVITE.inviteId, { limitUsd: 3, sinceMs: later }, 'run_b', later);
  assert.equal(
    renewRunBudget(path, INVITE.inviteId, 'run_a', later),
    false,
    'the first run lost it',
  );
  assert.equal(renewRunBudget(path, INVITE.inviteId, 'run_b', later), true);
});

test('a takeover fences the run it takes over from, and only then opens a window of its own', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  let clock = Date.parse('2026-10-20T23:00:00Z');
  const ledger = ledgerOn(journal, () => clock);
  setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: clock }, 'run_a', clock);
  const a = issue(ledger);
  clock = Date.parse('2026-10-20T23:50:00Z');
  assert.deepEqual(a.reserve('a1', 4), { ok: true });

  // Run A's command dies. After midnight run B takes over; run A's task is still on the server
  // with its credential.
  clock = Date.parse('2026-10-21T00:10:00Z');
  assert.deepEqual(
    setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: clock }, 'run_b', clock),
    { fenced: true },
  );
  const refusal = a.reserve('a2', 0.01);
  assert.equal(refusal.ok, false, 'the earlier run books nothing, however little');
  assert.match(refusal.ok ? '' : refusal.reason, /earlier run/u);

  // The new run has the whole of its own budget, and no more: A's $4 is not in its window.
  const b = issue(ledger);
  assert.deepEqual(b.reserve('b1', 5), { ok: true });
  assert.equal(refused(b.reserve('b2', 0.01)), 'invite_run');
  assert.equal(a.reserve('a3', 0.01).ok, false);

  // The file itself says the same to a process that books with a stale generation, and counts the
  // bookings of one that knows nothing of generations.
  const raw = new DatabaseSync(path);
  t.after(() => raw.close());
  const book = (key: string, usd: number, generation: number | null): void => {
    raw
      .prepare(
        'INSERT INTO account_spend (key, account, day, month, usd, generation) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(key, INVITE.inviteId, '2026-10-21', '2026-10', usd, generation);
  };
  assert.throws(() => book('stale', 0, 1), /earlier run/u);
  assert.throws(() => book('older', 0.5, null), /run generation/u);
});

test('the new run ending its budget does not lift the cap off a task of the run it took over from', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  let clock = Date.parse('2026-10-20T23:00:00Z');
  const ledger = ledgerOn(journal, () => clock);
  setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: clock }, 'run_a', clock);
  const a = issue(ledger);
  clock = Date.parse('2026-10-20T23:50:00Z');
  assert.deepEqual(a.reserve('a1', 4), { ok: true });

  clock = Date.parse('2026-10-21T00:10:00Z');
  setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: clock }, 'run_b', clock);
  assert.equal(a.reserve('a2', 4).ok, false, 'refused while run B holds the budget');
  const b = issue(ledger);
  assert.deepEqual(b.reserve('b1', 1), { ok: true });
  // Run B finishes and clears its budget; run A's task is still going.
  assert.equal(clearRunBudget(path, INVITE.inviteId, 'run_b'), true);
  assert.equal(a.reserve('a3', 4).ok, false, 'still refused: run A is over');
  assert.equal(b.reserve('b2', 1).ok, false, 'so is run B, which has ended');
  // Credentials issued after the run are held to the daily and monthly caps alone.
  assert.deepEqual(issue(ledger).reserve('after', 50), { ok: true });
});

test('a budget an earlier version left without a row sequence books nothing until a new run reopens it', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  const t0 = Date.parse('2026-10-20T12:00:00Z');
  const ledger = ledgerOn(journal, () => t0 + RUN_LEASE_MS * 10);
  const raw = new DatabaseSync(path);
  t.after(() => raw.close());
  // As #158 left it: a run id and a window by time only. The stamp that time rests on can fall short.
  raw
    .prepare(
      'INSERT INTO run_budget (account, limit_usd, since_ms, run_id, heartbeat_at, since_seq) VALUES (?, 5, ?, ?, ?, NULL)',
    )
    .run(INVITE.inviteId, t0, RUN, t0);

  const refusal = issue(ledger).reserve('a', 0.01);
  assert.equal(refusal.ok, false);
  assert.match(refusal.ok ? '' : refusal.reason, /reopened/u);
  assert.throws(
    () =>
      raw
        .prepare('INSERT INTO account_spend (key, account, day, month, usd) VALUES (?, ?, ?, ?, ?)')
        .run('older', INVITE.inviteId, '2026-10-20', '2026-10', 0.01),
    /run budget/u,
    'nor can a server that knows nothing of it',
  );

  // The run that set it is not trusted with it either: setting it again is a new run.
  assert.deepEqual(
    setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: t0 }, RUN, t0 + 10 * RUN_LEASE_MS),
    { fenced: true },
  );
  const reopened = issue(ledger);
  assert.deepEqual(reopened.reserve('b', 5), { ok: true });
  assert.equal(refused(reopened.reserve('c', 0.01)), 'invite_run');
});

test('the guards are swapped in one transaction, the new one first', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const first = new SqliteSpendJournal(path);
  first.close();
  // A file as the previous version leaves it: its guard, and not the new ones.
  const raw = new DatabaseSync(path);
  raw.exec(`
    DROP TRIGGER run_budget_guard_v3;
    DROP TRIGGER run_generation_fence_v2;
    CREATE TRIGGER run_generation_fence_v1 BEFORE INSERT ON account_spend
    WHEN NEW.generation IS NOT NULL AND NEW.generation <> 0
    BEGIN SELECT RAISE(ABORT, 'the credential belongs to an earlier run of this account'); END;
    CREATE TRIGGER run_budget_guard_v2 BEFORE INSERT ON account_spend
    BEGIN SELECT RAISE(ABORT, 'the run budget of this account is used up'); END;
  `);
  raw.close();

  // What the next open executes, in order, as another process would see the file change.
  const statements: string[] = [];
  const original = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
    statements.push(sql.trim().split(/\s+/u).slice(0, 4).join(' '));
    return original.call(this, sql);
  };
  try {
    const journal = new SqliteSpendJournal(path);
    journal.close();
  } finally {
    DatabaseSync.prototype.exec = original;
  }

  const guards = statements.flatMap((sql, index) =>
    /^(CREATE TRIGGER|DROP TRIGGER)/u.test(sql) ? [index] : [],
  );
  assert.ok(guards.length > 0, JSON.stringify(statements));
  const begin = statements.lastIndexOf('BEGIN IMMEDIATE', guards[0]);
  const commit = statements.indexOf('COMMIT', guards.at(-1));
  assert.ok(begin >= 0 && commit > guards.at(-1)!, 'inside one transaction');
  assert.ok(
    !statements
      .slice(begin + 1, commit)
      .some((sql) => sql === 'COMMIT' || sql === 'BEGIN IMMEDIATE'),
    'and only one',
  );
  const created = statements.findIndex((sql) => sql.startsWith('CREATE TRIGGER'));
  const dropped = statements.findIndex((sql) => sql.startsWith('DROP TRIGGER'));
  assert.ok(created >= 0 && dropped > created, 'the new guard is in before the old one goes');
});

test('a run clears only its own run budget, and a budget nobody renews keeps limiting until a run takes it over', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  const t0 = Date.parse('2026-10-20T12:00:00Z');
  const ledger = ledgerOn(journal, () => t0 + 10);
  setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: t0 }, 'run_b', t0);

  // A run that lost its hold (or never had it) deletes nothing.
  assert.equal(clearRunBudget(path, INVITE.inviteId, 'run_a'), false);
  assert.deepEqual(ledger.reserve(at(ledger), 'a', 5), { ok: true });
  assert.equal(refused(ledger.reserve(at(ledger), 'b', 1)), 'invite_run');
  // Nobody renews it for a long time: it still limits, so a killed run cannot lift its own cap.
  assert.equal(
    refused(ledgerOn(journal, () => t0 + 10 * RUN_LEASE_MS).reserve(at(ledger), 'c', 1)),
    'invite_run',
  );
  assert.equal(clearRunBudget(path, INVITE.inviteId, 'run_b'), true);
  assert.deepEqual(ledger.reserve(at(ledger), 'd', 1), { ok: true });
});

test('a run budget left by an earlier version, with no run id, can be taken over at once', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  const raw = new DatabaseSync(path);
  t.after(() => raw.close());
  raw
    .prepare('INSERT INTO run_budget (account, limit_usd, since_ms) VALUES (?, 5, 0)')
    .run(INVITE.inviteId);
  setRunBudget(path, INVITE.inviteId, { limitUsd: 2, sinceMs: 1 }, RUN);
  assert.equal(clearRunBudget(path, INVITE.inviteId, RUN), true);
});

test('a server on code that stamps no generation books nothing on an invite that has had a run, from any point of its life', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  let clock = Date.parse('2026-10-21T10:00:00Z');
  const ledger = ledgerOn(journal, () => clock);
  const raw = new DatabaseSync(path);
  t.after(() => raw.close());
  const oldWriter = (key: string, usd: number, account = INVITE.inviteId): void => {
    raw
      .prepare('INSERT INTO account_spend (key, account, day, month, usd) VALUES (?, ?, ?, ?, ?)')
      .run(key, account, '2026-10-21', '2026-10', usd);
  };

  // An invite that never had a run is not fenced: code that stamps nothing may book on it, and the
  // new server's own credentials for it are stamped 0.
  oldWriter('before-any-run', 0.5);
  assert.deepEqual(issue(ledger).reserve('stamped-zero', 1), { ok: true });

  // Run A takes the budget; a task of A is going on the old code, which stamps nothing.
  setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: clock }, 'run_a', clock);
  assert.throws(() => oldWriter('a1', 4), /earlier run|no run generation/u);

  // A is taken over by B, which ends and clears its budget: no budget row is left to count against,
  // and the old writer still books nothing ($8 under a $5 run was the result before).
  clock += 10 * 60_000;
  setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: clock }, 'run_b', clock);
  assert.equal(clearRunBudget(path, INVITE.inviteId, 'run_b'), true);
  assert.throws(() => oldWriter('a2', 4), /earlier run|no run generation/u);

  // It keeps booking nothing after run C starts.
  clock += 10 * 60_000;
  setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: clock }, 'run_c', clock);
  assert.throws(() => oldWriter('a3', 4), /earlier run|no run generation/u);
  const spent = raw
    .prepare('SELECT COALESCE(SUM(usd), 0) AS usd FROM account_spend WHERE key LIKE ?')
    .get('a%') as { usd: number };
  assert.equal(spent.usd, 0, 'nothing of the old writer got in');

  // Another invite with no run is untouched.
  oldWriter('other', 1, OTHER.inviteId);
});

test('the ledger refuses a credential that carries no generation once the invite has had a run, and says why', async (t) => {
  const path = join(await dir(t), 'spend.db');
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  const clock = Date.parse('2026-10-21T10:00:00Z');
  const ledger = ledgerOn(journal, () => clock);
  // No run yet: an unstamped credential is allowed (nothing to fence).
  assert.deepEqual(ledger.reserve(INVITE, 'unstamped-1', 1), { ok: true });
  setRunBudget(path, INVITE.inviteId, { limitUsd: 5, sinceMs: clock }, 'run_a', clock);
  clearRunBudget(path, INVITE.inviteId, 'run_a');
  const refusal = ledger.reserve(INVITE, 'unstamped-2', 1);
  assert.equal(refusal.ok, false);
  assert.match(refusal.ok ? '' : refusal.reason, /no run generation/u);
  // A credential issued now, which the server stamps, books.
  assert.deepEqual(issue(ledger).reserve('stamped', 1), { ok: true });
});

test('a journal as the previous version left it gets the fence that refuses unstamped bookings, and loses the one it replaces', async (t) => {
  const path = join(await dir(t), 'spend.db');
  new SqliteSpendJournal(path).close();
  const raw = new DatabaseSync(path);
  raw.exec(`
    DROP TRIGGER run_generation_fence_v2;
    CREATE TRIGGER run_generation_fence_v1 BEFORE INSERT ON account_spend
    WHEN NEW.generation IS NOT NULL AND NEW.generation <> 0
    BEGIN SELECT RAISE(ABORT, 'the credential belongs to an earlier run of this account'); END;
  `);
  raw.close();
  assert.equal(journalEnforcesRunBudgets(path), false, 'the file is not yet enforcing');
  new SqliteSpendJournal(path).close();
  assert.equal(journalEnforcesRunBudgets(path), true);
  const check = new DatabaseSync(path, { readOnly: true });
  t.after(() => check.close());
  const names = (
    check.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
  assert.ok(names.includes('run_generation_fence_v2'));
  assert.ok(!names.includes('run_generation_fence_v1'));
});
