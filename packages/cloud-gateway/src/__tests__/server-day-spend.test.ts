import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteSpendJournal } from '../index.js';

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
