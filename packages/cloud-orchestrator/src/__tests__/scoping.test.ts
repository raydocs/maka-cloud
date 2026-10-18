import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OrchestratorError } from '../types.js';
import { makeHarness } from './harness.js';

function isNotFound(error: unknown): boolean {
  return error instanceof OrchestratorError && error.code === 'not_found';
}

test('a session cannot see, wait on or cancel another session’s task', async (t) => {
  const h = await makeHarness(t);
  const alice = h.session();
  const bob = h.session();
  const { taskId } = await h.orchestrator.delegate(alice, { runner: 'fake', brief: 'private' });
  assert.throws(() => h.orchestrator.status(bob, taskId), isNotFound);
  await assert.rejects(h.orchestrator.wait(bob, taskId, 10), isNotFound);
  await assert.rejects(h.orchestrator.cancel(bob, taskId), isNotFound);
  assert.equal(h.orchestrator.status(alice, taskId).cancelRequested, false);
});

test('unknown and out-of-scope ids are indistinguishable', async (t) => {
  const h = await makeHarness(t);
  const alice = h.session();
  const bob = h.session();
  const { taskId } = await h.orchestrator.delegate(alice, { runner: 'fake', brief: 'x' });
  const messages = [
    capture(() => h.orchestrator.status(bob, taskId)),
    capture(() => h.orchestrator.status(bob, 'tsk_missing')),
  ].map((message) => message.replace(taskId, 'ID').replace('tsk_missing', 'ID'));
  assert.equal(messages[0], messages[1]);
});

function capture(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return `${(error as OrchestratorError).code}: ${(error as Error).message}`;
  }
  throw new Error('expected a failure');
}

test('a parent sees its children and their descendants; a child sees only its own subtree', async (t) => {
  const h = await makeHarness(t);
  const conductor = h.session();
  const a = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'a' });
  const b = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'b' });
  const aSession = h.executorSession(a.taskId);
  const bSession = h.executorSession(b.taskId);
  const a1 = await h.orchestrator.delegate(aSession, { runner: 'fake', brief: 'a1' });
  const a1Session = h.executorSession(a1.taskId);
  const a11 = await h.orchestrator.delegate(a1Session, { runner: 'fake', brief: 'a11' });

  for (const id of [a.taskId, b.taskId, a1.taskId, a11.taskId]) {
    assert.equal(h.orchestrator.status(conductor, id).taskId, id);
  }
  assert.equal(h.orchestrator.status(aSession, a1.taskId).parentTaskId, a.taskId);
  assert.equal(h.orchestrator.status(aSession, a11.taskId).taskId, a11.taskId);

  // A child never sees its parent, siblings, or a sibling's subtree.
  assert.throws(() => h.orchestrator.status(aSession, a.taskId), isNotFound);
  assert.throws(() => h.orchestrator.status(aSession, b.taskId), isNotFound);
  assert.throws(() => h.orchestrator.status(bSession, a1.taskId), isNotFound);
  assert.throws(() => h.orchestrator.status(a1Session, a1.taskId), isNotFound);
  assert.equal(h.orchestrator.status(a1Session, a11.taskId).taskId, a11.taskId);
  await assert.rejects(h.orchestrator.cancel(bSession, a1.taskId), isNotFound);
});

test('revoked and unknown tokens do not authenticate', async (t) => {
  const h = await makeHarness(t);
  const issued = h.orchestrator.issueSession();
  assert.equal(h.orchestrator.authenticate(issued.token)?.sessionId, issued.sessionId);
  h.orchestrator.revokeSession(issued.sessionId);
  assert.equal(h.orchestrator.authenticate(issued.token), undefined);
  assert.equal(h.orchestrator.authenticate('mko_guess'), undefined);
});

test('tokens never reach the event log', async (t) => {
  const h = await makeHarness(t);
  h.orchestrator.setEndpoint('http://127.0.0.1:1/mcp');
  const issued = h.orchestrator.issueSession();
  const session = h.orchestrator.authenticate(issued.token);
  assert.ok(session);
  const { taskId } = await h.orchestrator.delegate(session, { runner: 'fake', brief: 'x' });
  await h.orchestrator.cancel(session, taskId);
  const log = JSON.stringify(await h.store.read());
  assert.ok(!log.includes(issued.token));
  for (const run of h.fake.runs) assert.ok(!log.includes(run.spec.mcp?.token ?? 'unreachable'));
});
