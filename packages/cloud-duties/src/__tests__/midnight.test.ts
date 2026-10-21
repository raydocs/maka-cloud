import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Dispatcher } from '../dispatcher.js';
import { DAY, HOUR, issueOpened, rig, spec } from './harness.js';

/** A $2 run under a $2 day: one run fits a day, and a second does not. */
async function setup() {
  const r = await rig({ file: true });
  const [duty] = (await r.activate(
    spec({ trigger: { kind: 'issue_opened' }, runBudgetUsd: 2, dailyCapUsd: 2 }),
  )) as [string];
  let n = 0;
  const open = () => {
    n += 1;
    r.deliver('issues', issueOpened({ number: n }));
    return r.engine.requestsOf(duty)[0]?.requestId as string;
  };
  const usage = (offsetMs = 0) =>
    r.engine.dayUsage(duty, new Date(r.clock.t + offsetMs).toISOString().slice(0, 10));
  return { r, duty, open, usage };
}

test('a request claimed yesterday and launched today is booked to today, beside what today already holds', async () => {
  const { r, open, usage } = await setup();
  const first = open();
  assert.deepEqual(usage(), { reservedUsd: 2, spentUsd: 0 });
  r.clock.advance(13 * HOUR); // past UTC midnight, the first was never launched
  const second = open();
  assert.deepEqual(usage(), { reservedUsd: 2, spentUsd: 0 }, 'today holds the second only');

  // The first would be the second $2 of today: it is ended on the cap, not launched.
  assert.equal(r.engine.beginLaunch(first), undefined);
  assert.equal(r.engine.request(first)?.state, 'cancelled');
  assert.equal(r.engine.request(first)?.reason, 'daily_cap');
  assert.deepEqual(usage(-DAY), { reservedUsd: 0, spentUsd: 0 }, 'and yesterday holds nothing');

  assert.ok(r.engine.beginLaunch(second));
  assert.ok(r.engine.launched(second, 'cnv_2'));
  assert.equal(r.engine.finish(second, 'completed', 2), true);
  assert.deepEqual(usage(), { reservedUsd: 0, spentUsd: 2 }, 'the day never saw more than its cap');
  r.cleanup();
});

test('a request that fits today moves its reservation to today when it launches', async () => {
  const { r, open, usage } = await setup();
  const id = open();
  r.clock.advance(13 * HOUR);
  assert.deepEqual(usage(-DAY), { reservedUsd: 2, spentUsd: 0 });
  assert.ok(r.engine.beginLaunch(id));
  assert.deepEqual(usage(-DAY), { reservedUsd: 0, spentUsd: 0 });
  assert.deepEqual(usage(), { reservedUsd: 2, spentUsd: 0 });
  assert.ok(r.engine.launched(id, 'cnv_1'));
  r.clock.advance(DAY); // a run that is settled a day later stays on the day it started
  assert.equal(r.engine.finish(id, 'completed', 1.5), true);
  assert.deepEqual(usage(-DAY), { reservedUsd: 0, spentUsd: 1.5 });
  r.cleanup();
});

test('a launch resumed after a restart is checked against the day it resumes on', async () => {
  const { r, open, usage } = await setup();
  const first = open();
  assert.ok(r.engine.beginLaunch(first)); // launching when the process dies
  r.clock.advance(13 * HOUR);
  const engine = r.reopen();
  const second = open();
  assert.deepEqual(usage(), { reservedUsd: 2, spentUsd: 0 });
  assert.equal(engine.beginLaunch(first), undefined, 'the resumed launch no longer fits today');
  assert.equal(engine.request(first)?.reason, 'daily_cap');
  assert.ok(engine.beginLaunch(second));
  r.cleanup();
});

test('a run an earlier attempt already created keeps the day it was booked on and settles, however full today is', async () => {
  const { r, duty, open, usage } = await setup();
  const first = open();
  // The launch got as far as making the run, then the process died before `launched`.
  assert.ok(r.engine.beginLaunch(first));
  r.reopen();
  r.clock.advance(13 * HOUR); // past UTC midnight
  const second = open();
  assert.deepEqual(usage(), { reservedUsd: 2, spentUsd: 0 }, 'today is full with the second');

  const starts: string[] = [];
  const dispatcher = new Dispatcher({
    engine: r.engine,
    now: r.clock.now,
    launcher: {
      begun: (request) => request.requestId === first,
      start: async (request) => {
        starts.push(request.requestId);
        return { conversationId: `cnv_${starts.length}` };
      },
    },
  });
  dispatcher.kick();
  await dispatcher.settled();
  assert.equal(r.engine.request(first)?.state, 'started', 'the existing run is not turned away');
  assert.equal(r.engine.request(second)?.state, 'started');
  assert.deepEqual(usage(-DAY), { reservedUsd: 2, spentUsd: 0 }, 'it still holds its own day');

  assert.equal(r.engine.finish(first, 'completed', 2), true, 'and it can settle');
  assert.deepEqual(usage(-DAY), { reservedUsd: 0, spentUsd: 2 });
  assert.equal(r.engine.requestsOf(duty).length, 2);
  await dispatcher.close();
  r.cleanup();
});

test('a retried request whose earlier attempt made no run is still checked against today', async () => {
  const { r, open, usage } = await setup();
  const first = open();
  assert.ok(r.engine.beginLaunch(first));
  r.reopen();
  r.clock.advance(13 * HOUR);
  const second = open();
  const dispatcher = new Dispatcher({
    engine: r.engine,
    now: r.clock.now,
    launcher: {
      begun: () => false,
      start: async (request) => ({ conversationId: `cnv_${request.requestId}` }),
    },
  });
  dispatcher.kick();
  await dispatcher.settled();
  assert.equal(r.engine.request(first)?.reason, 'daily_cap');
  assert.equal(r.engine.request(second)?.state, 'started');
  assert.deepEqual(usage(-DAY), { reservedUsd: 0, spentUsd: 0 });
  await dispatcher.close();
  r.cleanup();
});
