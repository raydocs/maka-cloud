import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteSpendJournal, setRunBudget } from '@maka-cloud/gateway';
import { quotaSource } from '../quota.js';

test('quota counts held and settled spend, honors invite limits and resets in UTC', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-quota-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'spend.sqlite');
  const journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  let now = Date.UTC(2026, 9, 31, 23);
  const ledger = journal.accountLedger({
    limitsOf: () => ({ dailyUsd: 20, monthlyUsd: 50 }),
    serverDailyUsd: () => 100,
    now: () => now,
  });
  ledger.reserve({ inviteId: 'a' }, 'settled', 3);
  ledger.settle('settled', 1);
  ledger.reserve({ inviteId: 'a' }, 'held', 4);
  ledger.reserve({ inviteId: 'b' }, 'other', 2);
  const source = quotaSource(
    journal,
    { limits: (owner) => (owner === 'a' ? { dailyUsd: 5, monthlyUsd: 15 } : undefined) },
    { inviteDailyUsd: 10, inviteMonthlyUsd: 30, serverDailyUsd: 100 },
    () => now,
  );
  const usage = source.usage('a');
  assert.deepEqual(
    usage.limits.map((q) => [q.scope, q.usedUsd, q.limitUsd]),
    [
      ['day', 5, 5],
      ['month', 5, 15],
    ],
  );
  assert.equal(usage.refusal?.scope, 'day');
  assert.equal(usage.refusal?.nextStep, 'wait');
  assert.equal(usage.refusal?.resetsAt, Date.UTC(2026, 10, 1));
  assert.equal(source.usage('b').limits[0]?.usedUsd, 2);
  assert.equal(source.usage('b').refusal, undefined);
  journal.recordCap('task', 'a', { scope: 'invite_daily', inviteId: 'a', limitUsd: 5 }, now);
  assert.equal(source.refusal?.('task')?.usedUsd, 5);
  now += 86_400_000;
  assert.equal(source.usage('a').limits[0]?.usedUsd, 0);
  assert.equal(source.usage('a').refusal, undefined);
  assert.equal(
    source.refusal?.('task')?.resetsAt,
    Date.UTC(2026, 10, 1),
    'historical explanation keeps the original reset',
  );
});

test('run refusal snapshots run spend rather than the whole day and survives reopening', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-run-quota-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'spend.sqlite');
  let journal = new SqliteSpendJournal(path);
  let now = Date.UTC(2026, 9, 23);
  const ledger = journal.accountLedger({
    limitsOf: () => ({ dailyUsd: 100, monthlyUsd: 500 }),
    serverDailyUsd: () => 1000,
    now: () => now,
  });
  assert.deepEqual(ledger.reserve({ inviteId: 'a' }, 'before', 10), { ok: true });
  now += 1000;
  setRunBudget(path, 'a', { sinceMs: now, limitUsd: 3 }, 'run', now);
  assert.deepEqual(
    ledger.reserve({ inviteId: 'a', generation: ledger.generationOf?.('a') }, 'run-hold', 2),
    { ok: true },
  );
  journal.recordCap('task', 'a', { scope: 'invite_run', inviteId: 'a', limitUsd: 3 }, now);
  journal.close();
  journal = new SqliteSpendJournal(path);
  t.after(() => journal.close());
  const source = quotaSource(
    journal,
    { limits: () => undefined },
    { inviteDailyUsd: 100, inviteMonthlyUsd: 500, serverDailyUsd: 1000 },
    () => now,
  );
  assert.deepEqual(source.refusal?.('task'), {
    scope: 'task',
    usedUsd: 2,
    limitUsd: 3,
    resetsAt: null,
    nextStep: 'ask_owner',
  });
});
