import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteSpendJournal } from '../index.js';

async function path(t: import('node:test').TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'spend.db');
}

test('the caps the server wrote down are what another connection to the file reads, and the latest write wins', async (t) => {
  const file = await path(t);
  const server = new SqliteSpendJournal(file);
  t.after(() => server.close());
  const other = new SqliteSpendJournal(file);
  t.after(() => other.close());
  assert.equal(other.spendPolicy(), undefined, 'nothing was written yet');
  server.setSpendPolicy({ inviteDailyUsd: 5, inviteMonthlyUsd: 50, serverDailyUsd: 1 });
  assert.deepEqual(other.spendPolicy(), {
    inviteDailyUsd: 5,
    inviteMonthlyUsd: 50,
    serverDailyUsd: 1,
  });
  server.setSpendPolicy({ inviteDailyUsd: 2, inviteMonthlyUsd: 20, serverDailyUsd: 3 });
  assert.deepEqual(other.spendPolicy(), {
    inviteDailyUsd: 2,
    inviteMonthlyUsd: 20,
    serverDailyUsd: 3,
  });
});

test('a cap that is not a number of dollars, 0 or more, is refused and changes nothing', async (t) => {
  const j = new SqliteSpendJournal(await path(t));
  t.after(() => j.close());
  j.setSpendPolicy({ inviteDailyUsd: 5, inviteMonthlyUsd: 50, serverDailyUsd: 25 });
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => j.setSpendPolicy({ inviteDailyUsd: 5, inviteMonthlyUsd: 50, serverDailyUsd: bad }),
      RangeError,
    );
  }
  assert.equal(j.spendPolicy()?.serverDailyUsd, 25);
});
