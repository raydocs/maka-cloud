import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySessionStore } from '../auth.js';
import { MAX_PENDING_STEERS, type OperatorAccess } from '../orchestrator.js';
import type { StepLog } from '../steps.js';
import { MemoryTaskStore } from '../store.js';
import { OrchestratorError } from '../types.js';
import type { TaskId } from '../types.js';
import { eventually, makeHarness } from './harness.js';

type Test = Parameters<typeof makeHarness>[0];

/** The operator of a conversation, as the public API holds one. */
const operator = (session: { sessionId: string }): OperatorAccess => ({
  sessionId: session.sessionId,
  authorize: () => undefined,
});

async function running(t: Test, store = new MemoryTaskStore()) {
  const sessions = new MemorySessionStore();
  const h = await makeHarness(t, {
    store,
    fake: { steerable: true },
    orchestrator: { sessions },
  });
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run');
  await eventually(() => h.orchestrator.status(conductor, taskId).state === 'running', 'running');
  return { store, sessions, h, conductor, taskId, run: h.fake.runFor(taskId) };
}

const kinds = (store: MemoryTaskStore, taskId: TaskId) =>
  store.readTask(taskId).map(({ event }) => event.type);

const stateOf = (store: MemoryTaskStore, taskId: TaskId, steerId: string) => {
  let state = 'none';
  for (const { event } of store.readTask(taskId)) {
    if (event.type === 'task_steer' && event.steerId === steerId) state = 'pending';
    if (event.type === 'task_steer_delivered' && event.steerId === steerId) state = 'delivered';
    if (event.type === 'task_steer_withdrawn' && event.steerId === steerId) state = 'withdrawn';
    if (event.type === 'task_steer_unseen' && event.steerId === steerId) state = 'unseen';
  }
  return state;
};

test('a message sent to a running task reaches the run, and the task says when the agent read it', async (t) => {
  const { store, h, conductor, taskId, run } = await running(t);
  assert.deepEqual(
    await h.orchestrator.steerAs(operator(conductor), taskId, {
      steerId: 'm1',
      text: ' Use the v2 API. ',
    }),
    {
      steerId: 'm1',
      state: 'pending',
    },
  );
  assert.deepEqual(run.waiting, [{ steerId: 'm1', text: 'Use the v2 API.' }]);

  run.readWaiting();
  await eventually(() => stateOf(store, taskId, 'm1') === 'delivered', 'delivered');
  const delivered = store
    .readTask(taskId)
    .find(({ event }) => event.type === 'task_steer_delivered');
  assert.equal(delivered?.event.type === 'task_steer_delivered' && delivered.event.epoch, 1);
});

test('a message sent again with the same key applies once; the same key with other text is refused', async (t) => {
  const { store, h, conductor, taskId, run } = await running(t);
  await h.orchestrator.steerAs(operator(conductor), taskId, {
    steerId: 'm1',
    text: 'Stop using lodash.',
  });
  const again = await h.orchestrator.steerAs(operator(conductor), taskId, {
    steerId: 'm1',
    text: 'Stop using lodash.',
  });
  assert.equal(again.state, 'pending');
  assert.equal(kinds(store, taskId).filter((kind) => kind === 'task_steer').length, 1);
  assert.equal(run.offers.length, 1, 'the run was handed it once');

  run.readWaiting();
  await eventually(() => stateOf(store, taskId, 'm1') === 'delivered', 'delivered');
  const late = await h.orchestrator.steerAs(operator(conductor), taskId, {
    steerId: 'm1',
    text: 'Stop using lodash.',
  });
  assert.equal(
    late.state,
    'delivered',
    'a resend after it was read reports that, and sends nothing',
  );
  assert.equal(run.offers.length, 1);
  await assert.rejects(
    h.orchestrator.steerAs(operator(conductor), taskId, { steerId: 'm1', text: 'Something else.' }),
    /other text/u,
  );
});

test('a message is refused when its runner cannot take one, when it is empty or too long, or too many wait', async (t) => {
  const plain = await makeHarness(t);
  const conductor = plain.session();
  const { taskId } = await plain.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(
    () => plain.orchestrator.status(conductor, taskId).state === 'running',
    'running',
  );
  await assert.rejects(
    plain.orchestrator.steerAs(operator(conductor), taskId, { steerId: 'm1', text: 'hi' }),
    /cannot be sent messages/u,
  );

  const { h, conductor: c, taskId: id } = await running(t);
  await assert.rejects(
    h.orchestrator.steerAs(operator(c), id, { steerId: 'm1', text: '   ' }),
    /characters/u,
  );
  await assert.rejects(
    h.orchestrator.steerAs(operator(c), id, { steerId: 'm1', text: 'x'.repeat(4001) }),
    /characters/u,
  );
  await assert.rejects(
    h.orchestrator.steerAs(operator(c), id, { steerId: 'a b', text: 'x' }),
    /key/u,
  );
  for (let n = 0; n < MAX_PENDING_STEERS; n++) {
    await h.orchestrator.steerAs(operator(c), id, { steerId: `m${n}`, text: 'x' });
  }
  await assert.rejects(
    h.orchestrator.steerAs(operator(c), id, { steerId: 'extra', text: 'x' }),
    /too many unread/u,
  );
});

test('another conductor cannot steer a task, and neither can anyone once the task ended', async (t) => {
  const { h, conductor, taskId, run } = await running(t);
  await assert.rejects(
    h.orchestrator.steerAs(operator(h.session()), taskId, { steerId: 'm1', text: 'hi' }),
    /not_found|No such task|not found/iu,
  );
  await run.complete();
  await eventually(() => h.orchestrator.status(conductor, taskId).state === 'succeeded', 'ended');
  await assert.rejects(
    h.orchestrator.steerAs(operator(conductor), taskId, { steerId: 'm1', text: 'hi' }),
    /has ended/u,
  );
});

test('a message not yet read can be withdrawn and the agent never sees it; one already read cannot', async (t) => {
  const { store, h, conductor, taskId, run } = await running(t);
  await h.orchestrator.steerAs(operator(conductor), taskId, { steerId: 'm1', text: 'first' });
  await h.orchestrator.steerAs(operator(conductor), taskId, { steerId: 'm2', text: 'second' });
  assert.equal(
    (await h.orchestrator.withdrawSteerAs(operator(conductor), taskId, 'm1')).state,
    'withdrawn',
  );
  assert.deepEqual(
    run.readWaiting().map((message) => message.steerId),
    ['m2'],
    'only the message left is read',
  );
  await eventually(() => stateOf(store, taskId, 'm2') === 'delivered', 'delivered');
  assert.equal(stateOf(store, taskId, 'm1'), 'withdrawn');
  await assert.rejects(
    h.orchestrator.withdrawSteerAs(operator(conductor), taskId, 'm2'),
    /already read/u,
  );
  // Withdrawing again changes nothing.
  assert.equal(
    (await h.orchestrator.withdrawSteerAs(operator(conductor), taskId, 'm1')).state,
    'withdrawn',
  );
  await assert.rejects(
    h.orchestrator.withdrawSteerAs(operator(conductor), taskId, 'nope'),
    /No such message/u,
  );
});

test('a task that ends with a message unread says so, and marks it', async (t) => {
  const { store, h, conductor, taskId, run } = await running(t);
  await h.orchestrator.steerAs(operator(conductor), taskId, { steerId: 'm1', text: 'too late' });
  await run.complete();
  await eventually(() => h.orchestrator.status(conductor, taskId).state === 'succeeded', 'ended');
  assert.equal(stateOf(store, taskId, 'm1'), 'unseen');
  assert.deepEqual(
    h.orchestrator
      .status(conductor, taskId)
      .progress.filter((note) => /too late to be read/u.test(note)),
    ['a message sent to the agent came too late to be read: it ended without another step'],
  );
});

test('after a restart, a message waits until the resumed turn has finished a step, and one already read is not sent again', async (t) => {
  const { store, sessions, h, conductor, taskId, run } = await running(t);
  await h.orchestrator.steerAs(operator(conductor), taskId, {
    steerId: 'read',
    text: 'already read',
  });
  run.readWaiting();
  await eventually(() => stateOf(store, taskId, 'read') === 'delivered', 'delivered');
  await h.orchestrator.steerAs(operator(conductor), taskId, {
    steerId: 'waiting',
    text: 'still waiting',
  });

  const second = await makeHarness(t, {
    store,
    dir: h.dir,
    fake: { recover: true, steerable: true },
    orchestrator: { sessions },
  });
  await eventually(() => second.fake.runs.length === 1, 'the resumed run');
  const resumed = second.fake.runFor(taskId);
  await eventually(
    () =>
      store
        .readTask(taskId)
        .some(({ event }) => event.type === 'task_progress' && event.note === 'the run is back'),
    'the run is back',
  );
  assert.equal(resumed.offers.length, 0, 'nothing is offered while the resumed turn replays');

  // A message sent now waits with the other: the resumed turn has done nothing yet.
  await second.orchestrator.steerAs(operator(conductor), taskId, {
    steerId: 'new',
    text: 'sent during replay',
  });
  assert.equal(resumed.offers.length, 0);

  const steps = resumed.spec.steps as StepLog;
  await steps.intent({ stepId: 'toolu_1', kind: 'tool', replay: 'safe', label: 'ls' });
  assert.equal(resumed.offers.length, 0, 'a step under way does not release them');
  await steps.outcome('toolu_1', { status: 'done' });
  await eventually(() => resumed.offers.length === 2, 'the held messages');
  assert.deepEqual(
    resumed.offers.map((offer) => offer.steerId),
    ['waiting', 'new'],
    'in the order they were sent, and the one the agent read before the restart is not among them',
  );

  // Past its first step the turn takes a message at once.
  await second.orchestrator.steerAs(operator(conductor), taskId, { steerId: 'next', text: 'x' });
  assert.equal(resumed.offers.length, 3);
  resumed.readWaiting();
  await eventually(() => stateOf(store, taskId, 'next') === 'delivered', 'delivered');
  const epochs = store
    .readTask(taskId)
    .flatMap(({ event }) => (event.type === 'task_steer_delivered' ? [event.epoch] : []));
  assert.deepEqual(epochs, [1, 2, 2, 2], 'each is recorded under the attempt that gave it');
});

test('a revoked credential records nothing and hands the run nothing', async (t) => {
  const { store, h, conductor, taskId, run } = await running(t);
  const revoked: OperatorAccess = {
    sessionId: conductor.sessionId,
    authorize: () => {
      throw new OrchestratorError('unauthorized', 'The credential was revoked');
    },
  };
  await assert.rejects(
    h.orchestrator.steerAs(revoked, taskId, { steerId: 'm1', text: 'hi' }),
    /revoked/u,
  );
  assert.equal(kinds(store, taskId).includes('task_steer'), false);
  assert.equal(run.offers.length, 0);
  await h.orchestrator.steerAs(operator(conductor), taskId, { steerId: 'm2', text: 'hi' });
  await assert.rejects(h.orchestrator.withdrawSteerAs(revoked, taskId, 'm2'), /revoked/u);
  assert.equal(stateOf(store, taskId, 'm2'), 'pending');
});

test('a driver that lost the task cannot mark a message read', async (t) => {
  const { store, sessions, h, conductor, taskId, run } = await running(t);
  await h.orchestrator.steerAs(operator(conductor), taskId, { steerId: 'm1', text: 'hello' });
  assert.equal(run.waiting.length, 1);

  // A restart over the same store takes the task over: the first process is fenced.
  await makeHarness(t, {
    store,
    dir: h.dir,
    fake: { recover: true, steerable: true },
    orchestrator: { sessions },
  });
  // The old process's agent reads the message afterwards and says so: the log does not take it.
  run.readWaiting();
  // The refused write is how the old process learns it lost the task: it stops its run.
  await eventually(() => run.cancelCalls === 1, 'the old process to be fenced out');
  assert.equal(
    stateOf(store, taskId, 'm1'),
    'pending',
    'still waiting for the attempt that owns the task',
  );
  assert.equal(kinds(store, taskId).includes('task_steer_delivered'), false);
});
