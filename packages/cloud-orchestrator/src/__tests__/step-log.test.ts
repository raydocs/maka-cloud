import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reduce } from '../reducer.js';
import { MAX_STEPS_PER_TASK, type StepLog } from '../steps.js';
import type { TaskEvent, TaskId } from '../types.js';
import { eventually, GatedStore, makeHarness } from './harness.js';

const push = { stepId: 'toolu_push', kind: 'push', replay: 'never', label: 'git push' } as const;
const build = { stepId: 'toolu_build', kind: 'tool', replay: 'safe', label: 'npm test' } as const;

async function started(t: Parameters<typeof makeHarness>[0], options = {}) {
  const h = await makeHarness(t, options);
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run');
  await eventually(() => h.orchestrator.status(conductor, taskId).state !== 'queued', 'started');
  const steps = h.fake.runFor(taskId).spec.steps as StepLog;
  return { h, conductor, taskId, steps };
}

async function typesOf(h: { store: { readTask(id: TaskId): { event: TaskEvent }[] } }, id: TaskId) {
  return h.store.readTask(id).map((entry) => entry.event.type);
}

test('an intent is logged before the step, an outcome after it, both under the attempt epoch', async (t) => {
  const { h, taskId, steps } = await started(t);
  assert.deepEqual(await steps.intent(build), { status: 'recorded' });
  assert.equal(
    reduce(h.store.readTask(taskId)).get(taskId)?.steps.get('toolu_build')?.state,
    'running',
  );
  assert.equal(await steps.outcome('toolu_build', { status: 'done', output: 'ok' }), 'recorded');
  const events = h.store.readTask(taskId).map((entry) => entry.event);
  const intent = events.find((event) => event.type === 'step_intent');
  const outcome = events.find((event) => event.type === 'step_outcome');
  assert.deepEqual(
    [
      intent?.type === 'step_intent' && intent.epoch,
      outcome?.type === 'step_outcome' && outcome.epoch,
    ],
    [1, 1],
  );
  assert.deepEqual(
    events.map((event) => event.type).filter((type) => type.startsWith('step_')),
    ['step_intent', 'step_outcome'],
  );
  assert.equal(
    reduce(h.store.readTask(taskId)).get(taskId)?.steps.get('toolu_build')?.state,
    'done',
  );
});

test('the first intent per memo key wins: a repeat is not logged, a finished step is reused', async (t) => {
  const { h, taskId, steps } = await started(t);
  assert.deepEqual(await steps.intent(build), { status: 'recorded' });
  assert.deepEqual(await steps.intent(build), { status: 'running' });
  // A different label or class under the same key does not replace the first intent.
  assert.deepEqual(await steps.intent({ ...build, replay: 'never', label: 'other' }), {
    status: 'running',
  });
  await steps.outcome('toolu_build', { status: 'done', output: 'all 12 passed' });
  assert.deepEqual(await steps.intent(build), {
    status: 'completed',
    ok: true,
    output: 'all 12 passed',
  });
  const intents = (await typesOf(h, taskId)).filter((type) => type === 'step_intent');
  assert.equal(intents.length, 1);
  const record = reduce(h.store.readTask(taskId)).get(taskId)?.steps.get('toolu_build');
  assert.equal(record?.replay, 'safe');
  assert.equal(record?.label, 'npm test');
});

test('an outcome applies only to a step still running, once', async (t) => {
  const { h, taskId, steps } = await started(t);
  assert.equal(await steps.outcome('never_started', { status: 'done' }), 'ignored');
  await steps.intent(build);
  assert.equal(await steps.outcome('toolu_build', { status: 'failed' }), 'recorded');
  assert.equal(await steps.outcome('toolu_build', { status: 'done', output: 'late' }), 'ignored');
  const state = reduce(h.store.readTask(taskId)).get(taskId)?.steps.get('toolu_build')?.state;
  assert.equal(state, 'failed');
  assert.deepEqual(await steps.intent(build), { status: 'completed', ok: false });
});

test('the intent is durable before intent() answers: a held append holds the answer', async (t) => {
  const store = new GatedStore();
  const { h, taskId, steps } = await started(t, { store });
  const release = store.holdNext('step_intent');
  let answered = false;
  const pending = steps.intent(push).then((result) => {
    answered = true;
    return result;
  });
  await eventually(() => store.held, 'the append to reach the store');
  assert.equal(answered, false);
  assert.ok(!(await typesOf(h, taskId)).includes('step_intent'));
  release();
  assert.deepEqual(await pending, { status: 'recorded' });
  assert.ok((await typesOf(h, taskId)).includes('step_intent'));
});

test('no step starts on a task that is being cancelled or has ended, and its outcome is dropped after the end', async (t) => {
  const { h, conductor, taskId, steps } = await started(t);
  await steps.intent(build);
  await h.orchestrator.cancel(conductor, taskId);
  await h.orchestrator.settled();
  const refused = await steps.intent({ ...build, stepId: 'after' });
  assert.equal(refused.status, 'refused');
  assert.equal(await steps.outcome('toolu_build', { status: 'done' }), 'ignored');
  assert.ok(!(await typesOf(h, taskId)).includes('step_outcome'));
});

test('an unusable step is refused and a long label is cut to one printable line', async (t) => {
  const { h, taskId, steps } = await started(t);
  for (const bad of [
    { ...build, stepId: '' },
    { ...build, stepId: 'x'.repeat(201) },
    { ...build, kind: '  ' },
    { ...build, replay: 'sometimes' as 'safe' },
  ]) {
    assert.equal((await steps.intent(bad)).status, 'refused');
  }
  await steps.intent({ ...build, label: `a\nb‮${'c'.repeat(500)}` });
  const label = reduce(h.store.readTask(taskId)).get(taskId)?.steps.get('toolu_build')?.label ?? '';
  assert.ok(label.length <= 200);
  assert.ok(!/[\n‮]/u.test(label));
});

test('a task may log at most MAX_STEPS_PER_TASK steps', async (t) => {
  const { steps } = await started(t);
  for (let i = 0; i < MAX_STEPS_PER_TASK; i += 1) {
    const result = await steps.intent({ ...build, stepId: `s${i}` });
    assert.equal(result.status, 'recorded');
  }
  assert.equal((await steps.intent({ ...build, stepId: 'one-more' })).status, 'refused');
  // A step already in the log is still answered.
  assert.deepEqual(await steps.intent({ ...build, stepId: 's0' }), { status: 'running' });
});

test('a step the run left open is marked interrupted, in the log, by the attempt that takes the task over', async (t) => {
  const { h, taskId, steps } = await started(t);
  await steps.intent(build);
  await steps.intent(push);
  const second = await makeHarness(t, { store: h.store, dir: h.dir });
  const events = h.store.readTask(taskId).map((entry) => entry.event);
  const attempt = events.findIndex((event) => event.type === 'task_attempt');
  assert.deepEqual(
    events.slice(attempt).map((event) => event.type),
    ['task_attempt', 'step_interrupted', 'step_interrupted', 'task_failed'],
  );
  const task = reduce(h.store.readTask(taskId)).get(taskId);
  assert.equal(task?.epoch, 2);
  assert.deepEqual(
    [...(task?.steps.values() ?? [])].map((step) => [step.stepId, step.state]),
    [
      ['toolu_build', 'interrupted'],
      ['toolu_push', 'interrupted'],
    ],
  );
  assert.equal(second.fake.runs.length, 0);
});
