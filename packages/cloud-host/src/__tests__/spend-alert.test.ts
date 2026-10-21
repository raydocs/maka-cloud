import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteSpendJournal } from '@maka-cloud/gateway';
import { SpendAlertWatcher } from '../spend-alert.js';

const NOON = Date.UTC(2026, 9, 20, 12, 0, 0);
const DAY = 86_400_000;
const OWNER = 'inv_0123456789ab';

function watcher(
  spent: { usd: number },
  over: Partial<ConstructorParameters<typeof SpendAlertWatcher>[0]> = {},
) {
  const asked: Array<[string, string]> = [];
  const warnings: string[] = [];
  const days: string[] = [];
  let clock = NOON;
  const made = new SpendAlertWatcher({
    thresholdUsd: 10,
    ownerInvite: OWNER,
    spentToday: () => spent.usd,
    alert: async (inviteId, key) => {
      asked.push([inviteId, key]);
      return true;
    },
    now: () => clock,
    onAlert: (day) => days.push(day),
    onWarning: (message) => warnings.push(message),
    ...over,
  });
  return { made, asked, warnings, days, advance: (ms: number) => (clock += ms) };
}

test('nothing is asked below the threshold, and the owner is asked at it and above, under the day’s key', async () => {
  const spent = { usd: 9.99 };
  const w = watcher(spent);
  await w.made.tick();
  assert.deepEqual(w.asked, []);
  spent.usd = 10;
  await w.made.tick();
  assert.deepEqual(w.asked, [[OWNER, 'spend:2026-10-20']]);
  assert.deepEqual(w.days, ['2026-10-20']);
});

test('while the spend stays past the threshold each tick asks again, and only the first is reported', async () => {
  const w = watcher({ usd: 50 });
  await w.made.tick();
  await w.made.tick();
  await w.made.tick();
  assert.equal(w.asked.length, 3, 'asking is idempotent: a device already told is not told again');
  assert.ok(w.asked.every(([, key]) => key === 'spend:2026-10-20'));
  assert.deepEqual(w.days, ['2026-10-20']);
});

test('the next UTC day is a new alert with its own key', async () => {
  const spent = { usd: 50 };
  const w = watcher(spent);
  await w.made.tick();
  w.advance(DAY);
  spent.usd = 3;
  await w.made.tick();
  assert.equal(w.asked.length, 1, 'the new day starts below the threshold');
  spent.usd = 11;
  await w.made.tick();
  assert.deepEqual(
    w.asked.map(([, key]) => key),
    ['spend:2026-10-20', 'spend:2026-10-21'],
  );
  assert.deepEqual(w.days, ['2026-10-20', '2026-10-21']);
});

test('a spend that cannot be read does not alert, and a failing alert is reported and asked again', async () => {
  const spent = { usd: Number.NaN };
  let fail = true;
  const w = watcher(spent, {
    alert: async () => {
      if (fail) throw new Error('push is down');
      return true;
    },
  });
  await w.made.tick();
  assert.deepEqual(w.warnings, []);
  spent.usd = 20;
  await w.made.tick();
  assert.deepEqual(w.warnings, ['The spend alert failed; trying again']);
  assert.deepEqual(w.days, [], 'not reported as sent');
  fail = false;
  await w.made.tick();
  assert.deepEqual(w.days, ['2026-10-20']);
  const broken = watcher(spent, {
    spentToday: () => {
      throw new Error('journal closed');
    },
  });
  await broken.made.tick();
  assert.deepEqual(broken.warnings, ['The spend alert failed; trying again']);
});

test('a tick during a tick joins it, and close stops the timer for good', async () => {
  let release = (): void => undefined;
  let begun = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    begun = resolve;
  });
  let calls = 0;
  const w = watcher(
    { usd: 99 },
    {
      pollMs: 5,
      alert: () => {
        calls += 1;
        begun();
        return new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        });
      },
    },
  );
  w.made.start();
  await started;
  const joined = w.made.tick();
  release();
  await joined;
  assert.equal(calls, 1);
  await w.made.close();
  const after = calls;
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, after, 'nothing is asked after close');
  await w.made.tick();
  assert.equal(calls, after);
});

test('close waits for the alert being sent and gives up on one that hangs', async () => {
  let release = (): void => undefined;
  let begun = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    begun = resolve;
  });
  let finished = false;
  const waiting = watcher(
    { usd: 99 },
    {
      alert: () => {
        begun();
        return new Promise<boolean>((resolve) => {
          release = () => {
            finished = true;
            resolve(true);
          };
        });
      },
    },
  );
  void waiting.made.tick();
  await started;
  let closed = false;
  const closing = waiting.made.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  await closing;
  assert.equal(finished, true);
  assert.deepEqual(waiting.warnings, []);

  let hungBegun = (): void => undefined;
  const hungStarted = new Promise<void>((resolve) => {
    hungBegun = resolve;
  });
  const hung = watcher(
    { usd: 99 },
    {
      closeWaitMs: 20,
      alert: () => {
        hungBegun();
        return new Promise<boolean>(() => undefined);
      },
    },
  );
  void hung.made.tick();
  await hungStarted;
  await hung.made.close();
  assert.deepEqual(hung.warnings, ['A spend alert was still being sent when the stack closed']);
});

test('an alert that did not reach every device is reported, not counted as sent, and asked again later with growing waits', async () => {
  const spent = { usd: 20 };
  let complete = false;
  const w = watcher(spent, {
    alert: async (inviteId, key) => {
      w.asked.push([inviteId, key]);
      return complete;
    },
    pollMs: 60_000,
  });
  await w.made.tick(true);
  assert.equal(w.asked.length, 1);
  assert.deepEqual(w.warnings, ['The spend alert did not reach every device; trying again later']);
  assert.deepEqual(w.days, [], 'not reported as sent');
  // The timer's own ticks wait out the backoff...
  w.advance(60_000);
  await w.made.tick(true);
  assert.equal(w.asked.length, 1, 'one poll later is still inside the wait');
  w.advance(60_000);
  await w.made.tick(true);
  assert.equal(w.asked.length, 2, 'two polls later it asks again');
  assert.equal(w.warnings.length, 2);
  // ...and the second wait is longer than the first.
  w.advance(120_000);
  await w.made.tick(true);
  assert.equal(w.asked.length, 2, 'the wait grew');
  w.advance(120_000);
  complete = true;
  await w.made.tick(true);
  assert.equal(w.asked.length, 3);
  assert.deepEqual(w.days, ['2026-10-20'], 'reported once every device was told');
  // Done for the day: later ticks ask again as before (a device that subscribed since is told).
  await w.made.tick(true);
  assert.equal(w.asked.length, 4);
  assert.deepEqual(w.days, ['2026-10-20']);
});

test('the wait between attempts is capped, and a check made by hand does not wait', async () => {
  const spent = { usd: 20 };
  const w = watcher(spent, {
    alert: async (inviteId, key) => {
      w.asked.push([inviteId, key]);
      return false;
    },
    pollMs: 60_000,
  });
  for (let i = 0; i < 12; i += 1) {
    await w.made.tick(true);
    w.advance(15 * 60_000);
  }
  assert.equal(w.asked.length, 12, 'every 15 minutes is always past the wait');
  await w.made.tick();
  await w.made.tick();
  assert.equal(w.asked.length, 14, 'a hand-made check asks at once');
});

/** A watcher whose push service fails until `push.up` is set. */
function flaky(
  spent: { usd: number },
  over: Partial<ConstructorParameters<typeof SpendAlertWatcher>[0]> = {},
) {
  const push = { up: false };
  const w: ReturnType<typeof watcher> = watcher(spent, {
    alert: async (inviteId, key) => {
      w.asked.push([inviteId, key]);
      return push.up;
    },
    pollMs: 60_000,
    ...over,
  });
  return { w, push };
}

const MINUTE = 60_000;

test('an undelivered alert is asked again after the spend drops back under the threshold', async () => {
  const spent = { usd: 20 };
  const { w, push } = flaky(spent);
  await w.made.tick(true);
  assert.equal(w.asked.length, 1);
  // The reservation that took the day over the threshold settles lower.
  spent.usd = 4;
  w.advance(2 * MINUTE);
  push.up = true;
  await w.made.tick(true);
  assert.deepEqual(
    w.asked.map(([, key]) => key),
    ['spend:2026-10-20', 'spend:2026-10-20'],
    'the owner is asked again though today’s spend is under the threshold',
  );
  assert.deepEqual(w.days, ['2026-10-20']);
  // Delivered: nothing is owed, so a spend under the threshold asks nothing more.
  w.advance(5 * MINUTE);
  await w.made.tick(true);
  assert.equal(w.asked.length, 2);
});

test('an alert that failed before midnight UTC is still asked for after it, under its own day', async () => {
  const spent = { usd: 20 };
  const { w, push } = flaky(spent);
  w.advance(11 * 60 * MINUTE + 59 * MINUTE); // 23:59
  await w.made.tick(true);
  assert.deepEqual(w.asked, [[OWNER, 'spend:2026-10-20']]);
  // The new day starts with no spend; the push service comes back.
  w.advance(3 * MINUTE);
  spent.usd = 0;
  push.up = true;
  await w.made.tick(true);
  assert.deepEqual(w.asked, [
    [OWNER, 'spend:2026-10-20'],
    [OWNER, 'spend:2026-10-20'],
  ]);
  assert.deepEqual(w.days, ['2026-10-20'], 'reported for the day it was about');
});

test('an alert that keeps failing is given up a day after it was first asked for, with a warning', async () => {
  const spent = { usd: 20 };
  const { w } = flaky(spent);
  await w.made.tick(true);
  spent.usd = 0;
  w.advance(DAY - MINUTE);
  await w.made.tick(true);
  const before = w.asked.length;
  assert.ok(before > 1, 'still being tried just under a day on');
  w.advance(2 * MINUTE);
  await w.made.tick(true);
  assert.equal(w.asked.length, before, 'a day on it is not asked again');
  assert.ok(w.warnings.some((message) => /giving up/u.test(message)));
  w.advance(30 * MINUTE);
  await w.made.tick(true);
  assert.equal(w.asked.length, before, 'and stays given up');
});

test('an owed alert survives a restart: a new watcher over the same journal asks for it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'spend-alert-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'spend.db');
  const owedBy = (journal: SqliteSpendJournal) => ({
    save: (alert: Parameters<SqliteSpendJournal['savePendingAlert']>[0]) =>
      journal.savePendingAlert(alert),
    list: () => journal.pendingAlerts(),
    clear: (inviteId: string, key: string) => journal.clearPendingAlert(inviteId, key),
  });
  const spent = { usd: 20 };
  const first = new SqliteSpendJournal(path);
  const before = flaky(spent, { owed: owedBy(first) });
  await before.w.made.tick(true);
  assert.equal(before.w.asked.length, 1);
  first.close();

  // The process restarts, and the spend of the day is under the threshold now.
  spent.usd = 1;
  const second = new SqliteSpendJournal(path);
  t.after(() => second.close());
  const after = flaky(spent, { owed: owedBy(second) });
  after.push.up = true;
  after.w.advance(3 * MINUTE);
  await after.w.made.tick(true);
  assert.deepEqual(after.w.asked, [[OWNER, 'spend:2026-10-20']]);
  assert.deepEqual(second.pendingAlerts(), [], 'delivered, so no longer owed');
  assert.deepEqual(after.w.days, ['2026-10-20']);
});

test('what is owed waits out its backoff after a restart, as before it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'spend-alert-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const journal = new SqliteSpendJournal(join(dir, 'spend.db'));
  t.after(() => journal.close());
  const owed = {
    save: (alert: Parameters<SqliteSpendJournal['savePendingAlert']>[0]) =>
      journal.savePendingAlert(alert),
    list: () => journal.pendingAlerts(),
    clear: (inviteId: string, key: string) => journal.clearPendingAlert(inviteId, key),
  };
  const spent = { usd: 20 };
  const { w } = flaky(spent, { owed });
  await w.made.tick(true);
  const [stored] = journal.pendingAlerts();
  assert.equal(stored?.failures, 1);
  assert.equal(stored?.retryAt, NOON + 2 * MINUTE);
  spent.usd = 0;
  await w.made.tick(true);
  assert.equal(w.asked.length, 1, 'inside the wait nothing is asked');
});

test('an alert dropped unsent after a day is told: a warning naming its day, and onDropped once', async () => {
  const spent = { usd: 20 };
  const dropped: string[] = [];
  const { w } = flaky(spent, { onDropped: (alert) => void dropped.push(alert.key) });
  await w.made.tick(true);
  spent.usd = 0;
  w.advance(DAY - MINUTE);
  await w.made.tick(true);
  assert.deepEqual(dropped, [], 'still being tried just under a day on');
  w.advance(2 * MINUTE);
  await w.made.tick(true);
  assert.deepEqual(dropped, ['spend:2026-10-20']);
  assert.ok(
    w.warnings.some((message) => message.includes('2026-10-20') && /giving up/u.test(message)),
    'the warning names the day',
  );
  const asked = w.asked.length;
  w.advance(30 * MINUTE);
  await w.made.tick(true);
  assert.deepEqual(dropped, ['spend:2026-10-20'], 'told once');
  assert.equal(w.asked.length, asked, 'and not asked for again');
});

test('an alert that was delivered is never reported as dropped', async () => {
  const dropped: string[] = [];
  const { w, push } = flaky({ usd: 20 }, { onDropped: (alert) => void dropped.push(alert.key) });
  await w.made.tick(true);
  push.up = true;
  w.advance(2 * MINUTE);
  await w.made.tick(true);
  w.advance(2 * DAY);
  await w.made.tick(true);
  assert.deepEqual(dropped, []);
});

test('a drop that cannot be told stays owed, and is told at a later tick', async () => {
  const spent = { usd: 20 };
  const dropped: string[] = [];
  let inboxUp = false;
  const { w } = flaky(spent, {
    onDropped: (alert) => {
      if (!inboxUp) throw new Error('The inbox is not running');
      dropped.push(alert.key);
    },
  });
  await w.made.tick(true);
  spent.usd = 0;
  w.advance(DAY + MINUTE);
  await w.made.tick(true);
  assert.deepEqual(dropped, []);
  assert.ok(w.warnings.some((message) => /could not be raised/u.test(message)));
  inboxUp = true;
  w.advance(MINUTE);
  await w.made.tick(true);
  assert.deepEqual(dropped, ['spend:2026-10-20'], 'told once the inbox is back');
  w.advance(MINUTE);
  await w.made.tick(true);
  assert.deepEqual(dropped, ['spend:2026-10-20']);
});
