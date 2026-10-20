import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOUR, MINUTE, rig, spec } from './harness.js';

const hourly = spec({
  name: 'hourly',
  trigger: { kind: 'schedule', everyMinutes: 60 },
  runBudgetUsd: 1,
  dailyCapUsd: 100,
});

test('nothing runs before the first slot, then one run at it, and ticking again adds none', async () => {
  const r = await rig();
  const [duty] = (await r.activate(hourly)) as [string];
  assert.deepEqual(r.engine.tick(), { started: 0, missedSlots: 0 });
  r.clock.advance(59 * MINUTE);
  assert.equal(r.engine.tick().started, 0);
  r.clock.advance(MINUTE);
  assert.equal(r.engine.tick().started, 1);
  assert.equal(r.engine.tick().started, 0, 'the same slot is not run twice');
  r.clock.advance(30 * MINUTE);
  assert.equal(r.engine.tick().started, 0);
  r.clock.advance(30 * MINUTE);
  assert.equal(r.engine.tick().started, 1);
  assert.equal(r.engine.requestsOf(duty).length, 2);
  r.cleanup();
});

test('after downtime across many slots the duty runs once, and says how many it missed', async () => {
  const r = await rig({ file: true });
  const [duty] = (await r.activate(hourly)) as [string];
  r.clock.advance(HOUR);
  r.engine.tick();
  // The server is down for five slots, then comes back.
  r.engine.close();
  r.clock.advance(5 * HOUR + 10 * MINUTE);
  const engine = r.reopen();
  const result = engine.tick();
  assert.deepEqual(result, { started: 1, missedSlots: 4 });
  assert.equal(engine.requestsOf(duty).length, 2, 'one for the first slot, one catch-up');
  const catchUp = engine.request(engine.due().at(-1) as string);
  assert.match(catchUp?.brief ?? '', /4 earlier scheduled run\(s\) were missed/);
  assert.equal(catchUp?.external, false, 'a schedule carries no outside text');
  assert.equal(engine.tick().started, 0);
  r.cleanup();
});

test('a duty counts slots from its approval: nothing is owed for time before it', async () => {
  const r = await rig();
  r.clock.advance(10 * HOUR);
  const [duty] = (await r.activate(hourly)) as [string];
  assert.equal(r.engine.tick().started, 0, 'ten hours passed before approval');
  r.clock.advance(HOUR);
  assert.equal(r.engine.tick().started, 1);
  assert.equal(r.engine.requestsOf(duty).length, 1);
  r.cleanup();
});

test('turning a scheduled duty off stops its runs, and turning it on again starts counting from then', async () => {
  const r = await rig();
  const [duty] = (await r.activate(hourly)) as [string];
  r.engine.setDutyState('inv_owner', duty, 'off');
  r.clock.advance(5 * HOUR);
  assert.equal(r.engine.tick().started, 0);
  r.engine.setDutyState('inv_owner', duty, 'active');
  assert.equal(r.engine.tick().started, 0, 'not owed for the hours it was off');
  r.clock.advance(HOUR);
  assert.equal(r.engine.tick().started, 1);
  r.cleanup();
});

test('a scheduled run the daily cap refuses is skipped, not retried, and the slot is spent', async () => {
  const r = await rig();
  const [duty] = (await r.activate(
    spec({ trigger: { kind: 'schedule', everyMinutes: 60 }, runBudgetUsd: 2, dailyCapUsd: 2 }),
  )) as [string];
  r.clock.advance(HOUR);
  assert.equal(r.engine.tick().started, 1);
  r.clock.advance(HOUR);
  assert.equal(r.engine.tick().started, 0);
  assert.deepEqual(
    r.engine
      .requestsOf(duty)
      .map((request) => request.state)
      .sort(),
    ['pending', 'skipped'],
  );
  assert.equal(r.engine.tick().started, 0);
  r.cleanup();
});
