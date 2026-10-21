import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteSpendJournal } from '../journal.js';

const ALERT = {
  inviteId: 'inv_0123456789ab',
  key: 'spend:2026-10-20',
  firstAt: 1000,
  failures: 0,
  retryAt: 0,
};

test('an owed alert is kept across a reopen, keeps its first time as its wait grows, and ends when cleared', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pending-alerts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'spend.db');
  const first = new SqliteSpendJournal(path);
  assert.deepEqual(first.pendingAlerts(), []);
  first.savePendingAlert(ALERT);
  first.savePendingAlert({ ...ALERT, firstAt: 5000, failures: 2, retryAt: 9000 });
  first.savePendingAlert({ ...ALERT, key: 'spend:2026-10-21', firstAt: 2000 });
  first.close();

  const second = new SqliteSpendJournal(path);
  t.after(() => second.close());
  assert.deepEqual(second.pendingAlerts(), [
    { ...ALERT, failures: 2, retryAt: 9000 },
    { ...ALERT, key: 'spend:2026-10-21', firstAt: 2000 },
  ]);
  second.clearPendingAlert(ALERT.inviteId, ALERT.key);
  second.clearPendingAlert(ALERT.inviteId, 'spend:never-asked');
  assert.deepEqual(
    second.pendingAlerts().map((alert) => alert.key),
    ['spend:2026-10-21'],
  );
});

test('a raised alert is remembered per invite and key across a reopen, and clearing the owed alert does not forget it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'raised-alerts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'spend.db');
  const first = new SqliteSpendJournal(path);
  assert.equal(first.alertRaised(ALERT.inviteId, ALERT.key), false);
  first.savePendingAlert(ALERT);
  first.markAlertRaised(ALERT.inviteId, ALERT.key, 5);
  first.markAlertRaised(ALERT.inviteId, ALERT.key, 9);
  first.clearPendingAlert(ALERT.inviteId, ALERT.key);
  first.close();

  const second = new SqliteSpendJournal(path);
  t.after(() => second.close());
  assert.equal(second.alertRaised(ALERT.inviteId, ALERT.key), true);
  assert.equal(second.alertRaised(ALERT.inviteId, 'spend:2026-10-21'), false, 'per key');
  assert.equal(second.alertRaised('inv_ffffffffffff', ALERT.key), false, 'per invite');
});
