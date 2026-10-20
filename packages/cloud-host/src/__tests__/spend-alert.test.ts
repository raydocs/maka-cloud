import assert from 'node:assert/strict';
import { test } from 'node:test';
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
        return new Promise<void>((resolve) => {
          release = resolve;
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
        return new Promise<void>((resolve) => {
          release = () => {
            finished = true;
            resolve();
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
        return new Promise<void>(() => undefined);
      },
    },
  );
  void hung.made.tick();
  await hungStarted;
  await hung.made.close();
  assert.deepEqual(hung.warnings, ['A spend alert was still being sent when the stack closed']);
});
