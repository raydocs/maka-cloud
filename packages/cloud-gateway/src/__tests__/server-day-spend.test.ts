import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readJournalTotals, SqliteSpendJournal } from '../index.js';

const NOON = Date.UTC(2026, 9, 20, 12, 0, 0);
const DAY = 86_400_000;

async function journal(): Promise<{ journal: SqliteSpendJournal; clean: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-day-spend-'));
  return {
    journal: new SqliteSpendJournal(join(dir, 'spend.db')),
    clean: () => rm(dir, { recursive: true, force: true }),
  };
}

test('the server’s day spend is what settled plus what is still held, of that UTC day only', async (t) => {
  const { journal: j, clean } = await journal();
  t.after(clean);
  let clock = NOON;
  const ledger = j.accountLedger({
    limitsOf: () => ({ dailyUsd: 100, monthlyUsd: 1000 }),
    serverDailyUsd: () => 1000,
    now: () => clock,
  });
  assert.equal(j.serverDaySpendUsd(NOON), 0);

  assert.deepEqual(ledger.reserve({ inviteId: 'inv_a' }, 'k1', 2), { ok: true });
  assert.equal(j.serverDaySpendUsd(NOON), 2, 'a hold counts at its reserved amount');
  ledger.settle('k1', 0.5);
  assert.equal(j.serverDaySpendUsd(NOON), 0.5, 'a settled request counts what it cost');
  assert.deepEqual(ledger.reserve({ inviteId: 'inv_b' }, 'k2', 3), { ok: true });
  assert.deepEqual(ledger.reserve('server', 'k3', 1), { ok: true });
  assert.equal(j.serverDaySpendUsd(NOON), 4.5, 'every account counts, the server’s own too');

  clock = NOON + DAY;
  assert.deepEqual(ledger.reserve({ inviteId: 'inv_a' }, 'k4', 7), { ok: true });
  assert.equal(j.serverDaySpendUsd(clock), 7, 'the next day starts again');
  assert.equal(j.serverDaySpendUsd(NOON), 4.5, 'and the day before keeps its own');
});

test('the day spend is the number the server cap counts', async (t) => {
  const { journal: j, clean } = await journal();
  t.after(clean);
  const ledger = j.accountLedger({
    limitsOf: () => ({ dailyUsd: 100, monthlyUsd: 1000 }),
    serverDailyUsd: () => 5,
    now: () => NOON,
  });
  assert.deepEqual(ledger.reserve({ inviteId: 'inv_a' }, 'k1', 4), { ok: true });
  assert.equal(j.serverDaySpendUsd(NOON), 4);
  const refusal = ledger.reserve({ inviteId: 'inv_b' }, 'k2', 1.5);
  assert.equal(refusal.ok, false, '4 + 1.5 passes the cap of 5');
  assert.equal(j.serverDaySpendUsd(NOON), 4, 'a refused request adds nothing');
});

test('a journal can be read from outside while a process writes it, and reading changes nothing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-read-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'spend.db');
  const writer = new SqliteSpendJournal(path);
  t.after(() => writer.close());
  const ledger = writer.accountLedger({
    limitsOf: () => ({ dailyUsd: 100, monthlyUsd: 1000 }),
    serverDailyUsd: () => 1000,
    now: () => NOON,
  });
  writer.hold('tsk_1', 'k1', 1.5);
  writer.hold('tsk_2', 'k2', 0.25);
  writer.settle('tsk_1', 'k1', 1);
  writer.hold('tsk_1', 'k3', 0.5);
  assert.deepEqual(ledger.reserve({ inviteId: 'inv_a' }, 'a1', 2), { ok: true });
  assert.deepEqual(ledger.reserve({ inviteId: 'inv_b' }, 'a2', 3), { ok: true });
  ledger.settle('a2', 2.5);

  const totals = readJournalTotals(path, NOON);
  assert.deepEqual([...totals.taskUsd].sort(), [
    ['tsk_1', 1.5],
    ['tsk_2', 0.25],
  ]);
  assert.deepEqual([...totals.accountDayUsd].sort(), [
    ['inv_a', 2],
    ['inv_b', 2.5],
  ]);
  assert.equal(totals.serverDayUsd, 4.5);
  assert.equal(readJournalTotals(path, NOON + DAY).serverDayUsd, 0, 'another day');
  // Reading forgot nothing and the writer goes on.
  assert.deepEqual(readJournalTotals(path, NOON).taskUsd, totals.taskUsd);
  writer.settle('tsk_2', 'k2', 0.2);
  assert.equal(readJournalTotals(path, NOON).taskUsd.get('tsk_2'), 0.2);
});
