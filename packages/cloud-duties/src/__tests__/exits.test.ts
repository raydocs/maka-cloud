import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Dispatcher, LaunchRefused, type RunLauncher } from '../dispatcher.js';
import { MAX_LAUNCH_ATTEMPTS } from '../engine.js';
import { proposeDuties } from '../propose.js';
import { CI_DEFAULT, issueOpened, rig, spec, workflowRun } from './harness.js';

/** One duty with a $2 run and a $6 day; `open` starts a run for a new issue and returns its request id. */
async function setup() {
  const r = await rig({ file: true });
  const [duty] = (await r.activate(
    spec({ trigger: { kind: 'issue_opened' }, runBudgetUsd: 2, dailyCapUsd: 6 }),
  )) as [string];
  let n = 0;
  const open = () => {
    n += 1;
    r.deliver('issues', issueOpened({ number: n }));
    return r.engine.requestsOf(duty)[0]?.requestId as string;
  };
  const start = (id: string) => {
    assert.ok(r.engine.beginLaunch(id));
    assert.ok(r.engine.launched(id, `cnv_${id}`));
  };
  return { r, duty, open, start, usage: () => r.engine.dayUsage(duty) };
}

// One test per way a request leaves the reserved state. Each ends with the reservation gone: either
// replaced by what was spent, or released at zero, and the day's cap sees exactly that.

test('exit: the run completed, so its reservation becomes what it spent', async () => {
  const { r, open, start, usage } = await setup();
  const id = open();
  assert.deepEqual(usage(), { reservedUsd: 2, spentUsd: 0 });
  start(id);
  assert.equal(r.engine.finish(id, 'completed', 0.75), true);
  assert.deepEqual(usage(), { reservedUsd: 0, spentUsd: 0.75 });
  assert.equal(r.engine.request(id)?.state, 'done');
  assert.equal(r.engine.finish(id, 'completed', 99), false, 'ending twice changes nothing');
  assert.deepEqual(usage(), { reservedUsd: 0, spentUsd: 0.75 });
  r.cleanup();
});

test('exit: the run failed after spending past its reservation, and the full amount counts', async () => {
  const { r, open, start, usage } = await setup();
  const id = open();
  start(id);
  r.engine.finish(id, 'failed', 2.5);
  assert.deepEqual(usage(), { reservedUsd: 0, spentUsd: 2.5 });
  r.cleanup();
});

test('exit: the user stopped the run, so it counts what it spent so far', async () => {
  const { r, open, start, usage } = await setup();
  const id = open();
  start(id);
  r.engine.finish(id, 'stopped', 0.1);
  assert.deepEqual(usage(), { reservedUsd: 0, spentUsd: 0.1 });
  assert.equal(r.engine.request(id)?.reason, 'stopped');
  r.cleanup();
});

test('exit: a run nobody can account for is settled at its whole reservation, never left open', async () => {
  const { r, open, start, usage } = await setup();
  const id = open();
  start(id);
  r.engine.finish(id, 'abandoned');
  assert.deepEqual(usage(), { reservedUsd: 0, spentUsd: 2 });
  // A measurement that is not a usable number is treated the same way.
  const second = open();
  start(second);
  r.engine.finish(second, 'completed', Number.NaN);
  assert.deepEqual(usage(), { reservedUsd: 0, spentUsd: 4 });
  r.cleanup();
});

test('exit: the request is stopped before it started, so nothing is spent', async () => {
  const { r, open, usage } = await setup();
  const id = open();
  assert.equal(r.engine.finish(id, 'stopped'), true);
  assert.deepEqual(usage(), { reservedUsd: 0, spentUsd: 0 });
  assert.equal(r.engine.request(id)?.state, 'cancelled');
  r.cleanup();
});

test('exit: the duty is turned off while the request waits', async () => {
  const { r, duty, open, usage } = await setup();
  open();
  assert.equal(usage().reservedUsd, 2);
  r.engine.setDutyState('inv_owner', duty, 'off');
  assert.deepEqual(usage(), { reservedUsd: 0, spentUsd: 0 });
  assert.equal(r.engine.requestsOf(duty)[0]?.reason, 'duty_off');
  r.cleanup();
});

test('exit: the project is removed while requests wait, and a started run is left to finish', async () => {
  const { r, duty, open, start, usage } = await setup();
  const running = open();
  start(running);
  open();
  assert.equal(usage().reservedUsd, 4);
  assert.equal(r.engine.removeProject('inv_owner', r.projectId), true);
  assert.deepEqual(
    usage(),
    { reservedUsd: 2, spentUsd: 0 },
    'only the started run still holds its reservation',
  );
  assert.equal(r.engine.request(running)?.state, 'started');
  r.engine.finish(running, 'completed', 1);
  assert.deepEqual(usage(), { reservedUsd: 0, spentUsd: 1 });
  assert.equal(
    r.engine.requestsOf(duty).filter((request) => request.reason === 'project_removed').length,
    1,
  );
  r.cleanup();
});

test('exit: a later success makes a waiting CI failure stale (see delivery tests); the cap sees zero', async () => {
  const r = await rig();
  const [duty] = (await r.activate(CI_DEFAULT)) as [string];
  r.deliver('workflow_run', workflowRun({ id: 1, number: 1 }));
  r.deliver('workflow_run', workflowRun({ id: 2, number: 2, conclusion: 'success' }));
  assert.deepEqual(r.engine.dayUsage(duty), { reservedUsd: 0, spentUsd: 0 });
  r.cleanup();
});

test('exit: the launcher refuses the request for good, so it is cancelled and released at once', async () => {
  const { r, duty, open, usage } = await setup();
  const id = open();
  const dispatcher = new Dispatcher({
    engine: r.engine,
    launcher: {
      start: async () => {
        throw new LaunchRefused('the owner is gone');
      },
    },
    now: r.clock.now,
  });
  dispatcher.kick();
  await dispatcher.settled();
  assert.equal(r.engine.request(id)?.state, 'cancelled');
  assert.equal(r.engine.request(id)?.reason, 'launch_refused');
  assert.deepEqual(usage(), { reservedUsd: 0, spentUsd: 0 });
  assert.equal(r.engine.requestsOf(duty).length, 1);
  await dispatcher.close();
  r.cleanup();
});

test('exit: a launch that keeps failing is retried with a delay, then cancelled and released', async () => {
  const { r, open, usage } = await setup();
  const id = open();
  let calls = 0;
  const warnings: string[] = [];
  const dispatcher = new Dispatcher({
    engine: r.engine,
    launcher: {
      start: async () => {
        calls += 1;
        throw new Error('sandbox unavailable');
      },
    },
    now: r.clock.now,
    retryBaseMs: 1000,
    setTimer: () => () => undefined,
    onWarning: (message) => warnings.push(message),
  });
  for (let attempt = 1; attempt <= MAX_LAUNCH_ATTEMPTS; attempt += 1) {
    dispatcher.kick();
    await dispatcher.settled();
    if (attempt < MAX_LAUNCH_ATTEMPTS) {
      assert.equal(r.engine.request(id)?.state, 'pending', `attempt ${attempt} leaves it waiting`);
      assert.equal(usage().reservedUsd, 2, 'still reserved while it can retry');
      dispatcher.kick();
      await dispatcher.settled();
      assert.equal(calls, attempt, 'not due yet, so not tried again');
      r.clock.advance(1000 * 2 ** attempt);
    }
  }
  assert.equal(calls, MAX_LAUNCH_ATTEMPTS);
  assert.equal(r.engine.request(id)?.reason, 'launch_failed');
  assert.deepEqual(usage(), { reservedUsd: 0, spentUsd: 0 });
  assert.ok(warnings.length > 0);
  await dispatcher.close();
  r.cleanup();
});

test("exit: the day's cap refuses the event, so nothing was ever reserved", async () => {
  const { r, duty, open, usage } = await setup();
  open();
  open();
  open();
  const refused = open();
  assert.equal(usage().reservedUsd, 6);
  assert.equal(
    r.engine.requestsOf(duty).filter((request) => request.state === 'skipped').length,
    1,
  );
  assert.ok(refused);
  r.cleanup();
});

test('shutdown mid-launch keeps the request reserved and unfinished; the next start launches it once and settles it', async () => {
  const { r, open, usage } = await setup();
  const id = open();
  // The launcher is stuck when the process stops: the handshake releases it only after close began.
  let enteredLaunch!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredLaunch = resolve;
  });
  const stuck: RunLauncher = {
    start: (_request, signal) =>
      new Promise((_resolve, reject) => {
        enteredLaunch();
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  };
  const first = new Dispatcher({ engine: r.engine, launcher: stuck, now: r.clock.now });
  first.kick();
  await entered;
  await first.close();
  assert.equal(first.stats().timers, 0);
  assert.equal(first.stats().running, false);
  assert.equal(r.engine.request(id)?.state, 'launching', 'interrupted, not failed');
  assert.equal(usage().reservedUsd, 2, 'the reservation is neither lost nor released');

  const engine = r.reopen();
  assert.equal(engine.request(id)?.state, 'pending', 'a crash or shutdown mid-launch is retried');
  const starts: string[] = [];
  const second = new Dispatcher({
    engine,
    launcher: {
      start: async (request) => {
        starts.push(request.requestId);
        return { conversationId: 'cnv_1' };
      },
    },
    now: r.clock.now,
  });
  second.kick();
  await second.settled();
  assert.deepEqual(starts, [id]);
  assert.equal(engine.request(id)?.state, 'started');
  engine.finish(id, 'completed', 0.5);
  assert.deepEqual(engine.dayUsage(engine.request(id)?.dutyId as string), {
    reservedUsd: 0,
    spentUsd: 0.5,
  });
  await second.close();
  r.cleanup();
});

test('a duty that was never approved reserves nothing: its events and slots start no run', async () => {
  const r = await rig({ proposer: proposeDuties });
  const proposed = await r.engine.propose('inv_owner', r.projectId, {
    inspect: async () => ({
      defaultBranch: 'main',
      workflows: ['CI'],
      openIssues: 1,
      failedRunsLast30Days: 1,
    }),
  });
  assert.equal(proposed.ok, true);
  r.deliver('issues', issueOpened({ number: 1 }));
  r.deliver('workflow_run', workflowRun());
  r.clock.advance(30 * 24 * 3_600_000);
  r.engine.tick();
  assert.deepEqual(r.engine.due(), []);
  r.cleanup();
});
