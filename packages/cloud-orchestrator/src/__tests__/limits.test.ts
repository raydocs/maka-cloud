import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OperatorAccess } from '../orchestrator.js';
import { reduce, runTimeMs } from '../reducer.js';
import { MemoryTaskStore } from '../store.js';
import type { StoredEvent, TaskEvent } from '../types.js';
import { eventually, type Harness, makeHarness } from './harness.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;

async function started(
  h: Harness,
  input: { budgetUsd?: number } = {},
  conductor: ReturnType<Harness['session']> = h.session(),
) {
  const { taskId } = await h.orchestrator.delegate(conductor, {
    runner: 'fake',
    brief: 'work',
    ...input,
  });
  await eventually(() => h.orchestrator.status(conductor, taskId).state === 'running', 'running');
  return { conductor, taskId, run: h.fake.runFor(taskId) };
}

const progress = (h: Harness, conductor: ReturnType<Harness['session']>, taskId: string) =>
  h.orchestrator.status(conductor, taskId).progress;

test('the run time of a task counts from its start, leaves out time paused and stops at its end', () => {
  const log: TaskEvent[] = [
    { type: 'task_created', taskId: 't', sessionId: 's', runner: 'fake', mode: 'async' },
    { type: 'task_started', taskId: 't' },
    { type: 'task_pause_requested', taskId: 't', by: 's' },
    { type: 'task_paused', taskId: 't' },
    { type: 'task_resume_requested', taskId: 't', by: 's' },
    { type: 'task_resumed', taskId: 't' },
    {
      type: 'task_succeeded',
      taskId: 't',
      manifest: { summary: 'x', done: [], notDone: [], confidence: 'high', knownIssues: [] },
    },
  ];
  // created 0, started 10, paused 40, resumed 100, ended 130, in minutes.
  const at = [0, 10, 20, 40, 50, 100, 130];
  const stored: StoredEvent[] = log.map((event, index) => ({
    seq: index + 1,
    at: (at[index] as number) * MINUTE,
    event,
  }));
  const states = (count: number) => reduce(stored.slice(0, count)).get('t');
  assert.equal(states(1)?.runMs, 0);
  assert.equal(
    runTimeMs(states(2) as never, 25 * MINUTE),
    15 * MINUTE,
    'the interval under way counts',
  );
  assert.equal(states(4)?.runMs, 30 * MINUTE);
  assert.equal(states(4)?.runSince, undefined, 'a paused task is not running');
  assert.equal(runTimeMs(states(4) as never, 10 * HOUR), 30 * MINUTE, 'time paused does not count');
  assert.equal(runTimeMs(states(6) as never, 110 * MINUTE), 40 * MINUTE);
  assert.equal(states(7)?.runMs, 60 * MINUTE, 'the end closes the interval');
  assert.equal(runTimeMs(states(7) as never, 500 * HOUR), 60 * MINUTE);
});

test('a task stops with a note when it has used its run time, and its timer is gone', async (t) => {
  const h = await makeHarness(t, { orchestrator: { limits: { runMs: 40 } } });
  const { conductor, taskId, run } = await started(h);
  assert.equal(h.orchestrator.stats().runClocks, 1);
  await eventually(
    () => h.orchestrator.status(conductor, taskId).state === 'cancelled',
    'the run-time stop',
  );
  await h.orchestrator.settled();
  assert.equal(run.cancelled, true);
  assert.ok(
    progress(h, conductor, taskId).some((note) =>
      /^stopped: the task used its 1 minute of run time$/u.test(note),
    ),
    progress(h, conductor, taskId).join(' | '),
  );
  assert.equal(h.orchestrator.stats().runClocks, 0);
});

test('a task that ends, is cancelled or is paused holds no timer, and a resume sets it again', async (t) => {
  const store = new MemoryTaskStore();
  const clock = { now: 1_000 };
  const h = await makeHarness(t, {
    store,
    orchestrator: { limits: { runMs: 10 * MINUTE }, now: () => clock.now },
  });
  const conductor = h.session();
  const access: OperatorAccess = { sessionId: conductor.sessionId, authorize: () => undefined };
  const a = await started(h, {}, conductor);
  const b = await started(h, {}, conductor);
  const c = await started(h, {}, conductor);
  assert.equal(h.orchestrator.stats().runClocks, 3);

  await a.run.complete();
  await eventually(() => h.orchestrator.taskStateOf(a.taskId) === 'succeeded', 'a ended');
  assert.equal(h.orchestrator.stats().runClocks, 2, 'an end disarms');

  await h.orchestrator.cancel(conductor, b.taskId);
  await h.orchestrator.settled();
  assert.equal(h.orchestrator.stats().runClocks, 1, 'a cancel disarms');

  // 9 of the 10 minutes are used before the pause; the 100 hours paused do not count.
  clock.now += 9 * MINUTE;
  await h.orchestrator.pauseAs(access, c.taskId);
  assert.equal(h.orchestrator.stats().runClocks, 0, 'a pause disarms');
  clock.now += 100 * HOUR;
  await h.orchestrator.resumeAs(access, c.taskId);
  assert.equal(h.orchestrator.stats().runClocks, 1, 'a resume sets the timer again');
  // The timer is for the minute left, so the task is still running a moment after the resume.
  await new Promise((resolve) => setTimeout(resolve, 30));
  await h.orchestrator.settled();
  assert.equal(h.orchestrator.taskStateOf(c.taskId), 'running');

  h.orchestrator.close();
  assert.equal(h.orchestrator.stats().runClocks, 0, 'closing clears the timers');
});

test('a restart does not give a task a new run time: one over its limit is not resumed, one within it is, with its timer set', async (t) => {
  const store = new MemoryTaskStore();
  const clock = { now: 1_000_000 };
  const first = await makeHarness(t, { store, orchestrator: { now: () => clock.now } });
  const conductor = first.session();
  const over = await first.orchestrator.delegate(conductor, { runner: 'fake', brief: 'a' });
  await eventually(
    () => first.orchestrator.status(conductor, over.taskId).state === 'running',
    'a',
  );
  clock.now += 2 * HOUR;
  const within = await first.orchestrator.delegate(conductor, { runner: 'fake', brief: 'b' });
  await eventually(
    () => first.orchestrator.status(conductor, within.taskId).state === 'running',
    'b',
  );
  // The server is down for 90 minutes: `over` has run 3 h 30 min, `within` 1 h 30 min.
  clock.now += 90 * MINUTE;
  const limit = 3 * HOUR;
  const second = await makeHarness(t, {
    store,
    dir: first.dir,
    fake: { recover: true },
    orchestrator: { now: () => clock.now, limits: { runMs: limit } },
  });

  assert.deepEqual(second.orchestrator.resumedTaskIds, [within.taskId]);
  const gone = reduce(await store.read()).get(over.taskId);
  assert.equal(gone?.state, 'failed');
  assert.match(gone?.failureReason ?? '', /used its 3 hours of run time/u);
  await eventually(() => second.fake.recoveries.length === 1, 'the resume');
  assert.equal(second.fake.recoveries[0]?.taskId, within.taskId);
  await eventually(
    () => second.orchestrator.stats().runClocks === 1,
    'the timer of the resumed task',
  );
});

test('a run is told the most it may spend in a turn when there is a limit, and a task with no budget has none', async (t) => {
  const none = await makeHarness(t);
  const plain = await started(none, { budgetUsd: 2 });
  assert.equal(plain.run.spec.turnBudgetUsd, undefined);

  const h = await makeHarness(t, { orchestrator: { limits: { turnUsd: 0.5 } } });
  const { run } = await started(h, { budgetUsd: 2 });
  assert.equal(run.spec.budgetUsd, 2);
  assert.equal(run.spec.turnBudgetUsd, 0.5);
});

test('limits that are not positive numbers are refused', async (t) => {
  for (const limits of [{ runMs: 0 }, { runMs: Number.NaN }, { turnUsd: 0 }, { turnUsd: -1 }]) {
    await assert.rejects(makeHarness(t, { orchestrator: { limits } }), /positive numbers/u);
  }
});
