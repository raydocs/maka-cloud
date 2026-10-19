import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OperatorAccess } from '../orchestrator.js';
import { reduce } from '../reducer.js';
import { MemoryTaskStore } from '../store.js';
import { OrchestratorError, type TaskEvent } from '../types.js';
import { eventQueued, eventually, GatedStore, type Harness, makeHarness } from './harness.js';

/** A conversation's session plus the operator that acts for it, with a credential tests can revoke. */
async function setup(
  t: Parameters<typeof makeHarness>[0],
  options: Parameters<typeof makeHarness>[1] = {},
) {
  const h = await makeHarness(t, options);
  const conductor = h.session();
  const state = { revoked: false };
  const access: OperatorAccess = {
    sessionId: conductor.sessionId,
    authorize: () => {
      if (state.revoked) throw new OrchestratorError('unauthorized', 'The credential was revoked');
    },
  };
  return { h, conductor, access, state };
}

async function start(h: Harness, conductor: ReturnType<Harness['session']>) {
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'work' });
  await eventually(() => h.orchestrator.status(conductor, taskId).state === 'running', 'running');
  return { taskId, run: h.fake.runFor(taskId) };
}

async function logTypes(h: Harness, taskId: string): Promise<string[]> {
  return (await h.store.read())
    .filter((stored) => stored.event.taskId === taskId)
    .map((stored) => stored.event.type);
}

async function rejection(work: Promise<unknown>): Promise<OrchestratorError> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof OrchestratorError, String(error));
    return error;
  }
  throw new Error('expected a rejection');
}

test('pause holds the run, resume continues it, and the log says so in order', async (t) => {
  const { h, conductor, access } = await setup(t);
  const { taskId, run } = await start(h, conductor);

  const paused = await h.orchestrator.pauseAs(access, taskId);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.pauseRequested, true);
  assert.equal(run.paused, true);

  const resumed = await h.orchestrator.resumeAs(access, taskId);
  assert.equal(resumed.state, 'running');
  assert.equal(resumed.pauseRequested, false);
  assert.equal(run.paused, false);

  assert.deepEqual(await logTypes(h, taskId), [
    'task_created',
    'task_started',
    'task_pause_requested',
    'task_paused',
    'task_resume_requested',
    'task_resumed',
  ]);
  // Replay computes the same state as the live run did.
  const replayed = reduce(await h.store.read()).get(taskId);
  assert.equal(replayed?.state, 'running');
  assert.equal(replayed?.pauseRequested, undefined);

  // The run goes on after a resume and ends normally.
  await run.complete();
  const done = await h.orchestrator.wait(conductor, taskId, 2000);
  assert.equal(done.state, 'succeeded');
});

test('asking to pause again changes nothing, while it is in progress and once it holds', async (t) => {
  const { h, conductor, access } = await setup(t);
  const { taskId, run } = await start(h, conductor);
  const hold = run.holdPause();

  const first = h.orchestrator.pauseAs(access, taskId);
  await eventually(() => run.pauseCalls === 1, 'the runner was asked');
  // Two more requests while the runner is still answering. Each is decided in the
  // write chain, so both see the request that is already recorded.
  const again = h.orchestrator.pauseAs(access, taskId);
  const third = h.orchestrator.pauseAs(access, taskId);
  assert.equal((await again).state, 'running', 'still being paused');
  assert.equal((await third).pauseRequested, true);
  hold.release();
  assert.equal((await first).state, 'paused');
  assert.equal((await h.orchestrator.pauseAs(access, taskId)).state, 'paused');

  assert.equal(run.pauseCalls, 1);
  const requests = (await logTypes(h, taskId)).filter((type) => type === 'task_pause_requested');
  assert.equal(requests.length, 1);
});

test('a runner without pause refuses and nothing is recorded', async (t) => {
  const { h, conductor, access } = await setup(t, { fake: { pausable: false } });
  const { taskId } = await start(h, conductor);
  const error = await rejection(h.orchestrator.pauseAs(access, taskId));
  assert.equal(error.code, 'unsupported');
  assert.deepEqual(await logTypes(h, taskId), ['task_created', 'task_started']);
  assert.equal(h.orchestrator.status(conductor, taskId).state, 'running');
});

test('a task that has not started cannot be paused, and a finished one takes neither request', async (t) => {
  let release!: () => void;
  const starting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { h, conductor, access } = await setup(t, {
    fake: { onStart: () => starting },
  });
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'slow' });
  await eventually(() => h.fake.runs.length === 1, 'the runner is starting');
  assert.equal(h.orchestrator.status(conductor, taskId).state, 'queued');
  assert.equal((await rejection(h.orchestrator.pauseAs(access, taskId))).code, 'invalid_state');
  release();
  await eventually(() => h.orchestrator.status(conductor, taskId).state === 'running', 'running');

  await h.fake.runFor(taskId).complete();
  await h.orchestrator.wait(conductor, taskId, 2000);
  assert.equal((await rejection(h.orchestrator.pauseAs(access, taskId))).code, 'invalid_state');
  assert.equal((await rejection(h.orchestrator.resumeAs(access, taskId))).code, 'invalid_state');
  // Cancelling a finished task is a no-op that returns it, so a retry is safe.
  assert.equal((await h.orchestrator.cancelAs(access, taskId)).state, 'succeeded');
});

test('resume needs a paused task and refuses while the pause is still under way', async (t) => {
  const { h, conductor, access } = await setup(t);
  const { taskId, run } = await start(h, conductor);
  assert.equal((await rejection(h.orchestrator.resumeAs(access, taskId))).code, 'invalid_state');

  const hold = run.holdPause();
  const pausing = h.orchestrator.pauseAs(access, taskId);
  await eventually(() => run.pauseCalls === 1, 'the runner was asked');
  assert.equal((await rejection(h.orchestrator.resumeAs(access, taskId))).code, 'invalid_state');
  hold.release();
  await pausing;
  assert.equal(run.resumeCalls, 0);
});

test('cancel while the runner is still pausing ends the task cancelled and records no pause', async (t) => {
  const { h, conductor, access } = await setup(t);
  const { taskId, run } = await start(h, conductor);
  const hold = run.holdPause();
  const pausing = h.orchestrator.pauseAs(access, taskId);
  await eventually(() => run.pauseCalls === 1, 'the runner was asked');

  const cancelled = await h.orchestrator.cancelAs(access, taskId);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(run.cancelCalls, 1);
  hold.release();
  assert.equal((await pausing).state, 'cancelled');
  assert.ok(!(await logTypes(h, taskId)).includes('task_paused'));
});

test('cancel reaches a paused task and the run is cancelled, not resumed', async (t) => {
  const { h, conductor, access } = await setup(t);
  const { taskId, run } = await start(h, conductor);
  await h.orchestrator.pauseAs(access, taskId);
  const cancelled = await h.orchestrator.cancelAs(access, taskId);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(run.cancelCalls, 1);
  assert.equal(run.resumeCalls, 0);
  // Nothing about the pause can change a task that ended.
  assert.equal((await rejection(h.orchestrator.resumeAs(access, taskId))).code, 'invalid_state');
});

test('a cancel that is already recorded wins over a later pause', async (t) => {
  const store = new GatedStore();
  const { h, conductor, access } = await setup(t, { store });
  const { taskId, run } = await start(h, conductor);
  const release = store.holdNext('task_cancel_requested');
  const cancelling = h.orchestrator.cancelAs(access, taskId);
  await eventually(() => store.held, 'cancel request held at the store');
  // The pause is queued behind the cancel in the write chain.
  const queued = eventQueued(h, 'task_pause_requested');
  const pausing = h.orchestrator.pauseAs(access, taskId);
  await queued;
  release();
  assert.equal((await rejection(pausing)).code, 'invalid_state');
  assert.equal((await cancelling).state, 'cancelled');
  assert.equal(run.pauseCalls, 0);
});

test('a pause that is recorded first still ends cancelled when the cancel follows', async (t) => {
  const store = new GatedStore();
  const { h, conductor, access } = await setup(t, { store });
  const { taskId, run } = await start(h, conductor);
  const hold = run.holdPause();
  const release = store.holdNext('task_pause_requested');
  const pausing = h.orchestrator.pauseAs(access, taskId);
  await eventually(() => store.held, 'pause request held at the store');
  const queued = eventQueued(h, 'task_cancel_requested');
  const cancelling = h.orchestrator.cancelAs(access, taskId);
  await queued;
  release();
  await eventually(() => run.pauseCalls === 1, 'the runner was asked');
  assert.equal((await cancelling).state, 'cancelled');
  hold.release();
  assert.equal((await pausing).state, 'cancelled');
  const types = await logTypes(h, taskId);
  assert.ok(!types.includes('task_paused'));
  assert.equal(types.filter((type) => type.startsWith('task_cancel')).length, 2);
});

test('a runner that fails to pause leaves the task running, can be asked again, and is told to resume', async (t) => {
  const { h, conductor, access } = await setup(t);
  const { taskId, run } = await start(h, conductor);
  const hold = run.holdPause();
  const pausing = h.orchestrator.pauseAs(access, taskId);
  const refused = rejection(pausing);
  await eventually(() => run.pauseCalls === 1, 'the runner was asked');
  hold.fail(new Error('sandbox unreachable'));
  assert.equal((await refused).code, 'invalid_state');
  await h.orchestrator.settled();

  const view = h.orchestrator.status(conductor, taskId);
  assert.equal(view.state, 'running');
  assert.equal(view.pauseRequested, false);
  assert.equal(run.resumeCalls, 1, 'a late pause is undone');
  assert.ok((await logTypes(h, taskId)).includes('task_pause_failed'));

  assert.equal((await h.orchestrator.pauseAs(access, taskId)).state, 'paused');
});

test('a runner that never answers a pause times out, and an answer that comes late is undone', async (t) => {
  const { h, conductor, access } = await setup(t, { orchestrator: { controlTimeoutMs: 20 } });
  const { taskId, run } = await start(h, conductor);
  const hold = run.holdPause();
  assert.equal((await rejection(h.orchestrator.pauseAs(access, taskId))).code, 'invalid_state');
  assert.equal(h.orchestrator.status(conductor, taskId).state, 'running');
  hold.release();
  await h.orchestrator.settled();
  await eventually(() => run.resumeCalls === 1, 'the late pause was undone');
  assert.equal(run.paused, false);
});

test('a runner that fails to resume leaves the task paused and can be asked again', async (t) => {
  const { h, conductor, access } = await setup(t);
  const { taskId, run } = await start(h, conductor);
  await h.orchestrator.pauseAs(access, taskId);
  const hold = run.holdResume();
  const resuming = h.orchestrator.resumeAs(access, taskId);
  const refused = rejection(resuming);
  await eventually(() => run.resumeCalls === 1, 'the runner was asked');
  hold.fail(new Error('exec failed'));
  assert.equal((await refused).code, 'invalid_state');
  assert.equal(h.orchestrator.status(conductor, taskId).state, 'paused');
  assert.ok((await logTypes(h, taskId)).includes('task_resume_failed'));

  assert.equal((await h.orchestrator.resumeAs(access, taskId)).state, 'running');
});

test('a runner that never answers a resume times out and the task stays paused', async (t) => {
  const { h, conductor, access } = await setup(t, { orchestrator: { controlTimeoutMs: 20 } });
  const { taskId, run } = await start(h, conductor);
  await h.orchestrator.pauseAs(access, taskId);
  const hold = run.holdResume();
  assert.equal((await rejection(h.orchestrator.resumeAs(access, taskId))).code, 'invalid_state');
  assert.equal(h.orchestrator.status(conductor, taskId).state, 'paused');
  hold.release();
  // A later request works: the failed one left nothing behind.
  assert.equal((await h.orchestrator.resumeAs(access, taskId)).state, 'running');
});

test('the credential is checked in the write chain: one revoked while a request waits is refused', async (t) => {
  const store = new GatedStore();
  const { h, conductor, access, state } = await setup(t, { store });
  const { taskId, run } = await start(h, conductor);
  // An unrelated append holds the chain, so the pause waits behind it.
  const release = store.holdNext('task_progress');
  run.progress('working');
  await eventually(() => store.held, 'progress held at the store');
  const queued = eventQueued(h, 'task_pause_requested');
  const pausing = h.orchestrator.pauseAs(access, taskId);
  await queued;
  state.revoked = true;
  release();
  assert.equal((await rejection(pausing)).code, 'unauthorized');
  assert.equal(run.pauseCalls, 0);
  assert.ok(!(await logTypes(h, taskId)).includes('task_pause_requested'));

  // The same holds for cancel and resume.
  state.revoked = false;
  await h.orchestrator.pauseAs(access, taskId);
  state.revoked = true;
  assert.equal((await rejection(h.orchestrator.resumeAs(access, taskId))).code, 'unauthorized');
  assert.equal((await rejection(h.orchestrator.cancelAs(access, taskId))).code, 'unauthorized');
  assert.equal(h.orchestrator.status(conductor, taskId).state, 'paused');
  assert.equal(run.cancelCalls, 0);
});

test('an operator reaches its own conversation tree, including nested tasks, and nothing else', async (t) => {
  const { h, conductor, access } = await setup(t);
  const { taskId: parentId } = await start(h, conductor);
  const child = await h.orchestrator.delegate(h.executorSession(parentId), {
    runner: 'fake',
    brief: 'nested',
  });
  await eventually(
    () => h.orchestrator.status(conductor, child.taskId).state === 'running',
    'child',
  );

  const otherConversation = await setup(t);
  const stranger: OperatorAccess = {
    sessionId: h.session().sessionId,
    authorize: () => undefined,
  };
  for (const act of [
    () => h.orchestrator.pauseAs(stranger, child.taskId),
    () => h.orchestrator.resumeAs(stranger, child.taskId),
    () => h.orchestrator.cancelAs(stranger, child.taskId),
    () => h.orchestrator.pauseAs(otherConversation.access, child.taskId),
    () => h.orchestrator.pauseAs(access, 'tsk_unknown'),
  ]) {
    assert.equal((await rejection(act())).code, 'not_found');
  }

  assert.equal((await h.orchestrator.pauseAs(access, child.taskId)).state, 'paused');
  // Cancelling the parent takes the paused child with it.
  await h.orchestrator.cancelAs(access, parentId);
  assert.equal(h.orchestrator.status(conductor, child.taskId).state, 'cancelled');
  assert.equal(h.fake.runFor(child.taskId).cancelCalls, 1);
});

test('a paused task still counts against the conversation, so it cannot be used to dodge the quota', async (t) => {
  const { h, conductor, access } = await setup(t, {
    orchestrator: { quotas: { maxActiveTasks: 1 } },
  });
  const { taskId } = await start(h, conductor);
  await h.orchestrator.pauseAs(access, taskId);
  const error = await rejection(h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' }));
  assert.equal(error.code, 'quota_exceeded');
  await h.orchestrator.cancelAs(access, taskId);
  await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
});

test('a task that was paused when the process stopped is ended as an orphan on restart', async (t) => {
  const store = new MemoryTaskStore();
  const first = await makeHarness(t, { store });
  const conductor = first.session();
  const access: OperatorAccess = { sessionId: conductor.sessionId, authorize: () => undefined };
  const { taskId } = await start(first, conductor);
  await first.orchestrator.pauseAs(access, taskId);

  const second = await makeHarness(t, { store, dir: first.dir });
  assert.deepEqual(second.orchestrator.orphanedTaskIds, [taskId]);
  const types = (await store.read())
    .filter((stored) => stored.event.taskId === taskId)
    .map((stored) => stored.event.type);
  assert.equal(types.at(-1), 'task_failed');
  assert.equal(second.orchestrator.status(conductor, taskId).state, 'failed');
});

test('the reducer ignores pause events that do not apply', () => {
  const at = 1;
  const events: TaskEvent[] = [
    { type: 'task_created', taskId: 't', sessionId: 's', runner: 'fake', mode: 'async' },
    // Before the task started: nothing to pause.
    { type: 'task_pause_requested', taskId: 't', by: 's' },
    { type: 'task_paused', taskId: 't' },
    { type: 'task_started', taskId: 't' },
    // `task_paused` without a recorded request does nothing.
    { type: 'task_paused', taskId: 't' },
    { type: 'task_resumed', taskId: 't' },
  ];
  const task = reduce(events.map((event, index) => ({ seq: index + 1, at, event }))).get('t');
  assert.equal(task?.state, 'running');
  assert.equal(task?.pauseRequested, undefined);
});
