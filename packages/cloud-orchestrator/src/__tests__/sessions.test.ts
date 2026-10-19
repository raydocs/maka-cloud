import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySessionStore, SessionAuth, type SessionStore } from '../auth.js';
import { MemoryTaskStore } from '../store.js';
import { eventually, makeHarness } from './harness.js';

test('digests, not tokens, are what a session store receives', () => {
  const store = new MemorySessionStore();
  const auth = new SessionAuth(store);
  const issued = auth.issue();
  const entry = store.get(issued.sessionId);
  assert.ok(entry);
  assert.equal(entry.digest.length, 32);
  assert.ok(!JSON.stringify(entry).includes(issued.token));
  assert.ok(!entry.digest.toString('utf8').includes(issued.token));
});

test('a token issued before a restart still works after it, over the same durable store', async (t) => {
  const store = new MemoryTaskStore();
  const sessions = new MemorySessionStore();
  const first = await makeHarness(t, { store, orchestrator: { sessions } });
  const issued = first.orchestrator.issueSession();
  const conductor = first.orchestrator.authenticate(issued.token);
  assert.ok(conductor);
  const { taskId } = await first.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => first.fake.runs.length === 1, 'run');
  await first.fake.runFor(taskId).complete();
  await first.orchestrator.wait(conductor, taskId, 2000);

  const second = await makeHarness(t, { store, dir: first.dir, orchestrator: { sessions } });
  const again = second.orchestrator.authenticate(issued.token);
  assert.equal(again?.sessionId, issued.sessionId);
  assert.equal(second.orchestrator.status(again ?? second.session(), taskId).state, 'succeeded');
});

test('restore ends orphans and revokes the executor sessions a durable store still holds', async (t) => {
  const store = new MemoryTaskStore();
  const sessions = new MemorySessionStore();
  const first = await makeHarness(t, { store, orchestrator: { sessions } });
  const conductor = first.session();
  const { taskId } = await first.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => first.fake.runs.length === 1, 'run');
  const executor = first.orchestrator.issueSession({ parentTaskId: taskId });
  assert.ok(first.orchestrator.authenticate(executor.token));

  const second = await makeHarness(t, { store, dir: first.dir, orchestrator: { sessions } });
  assert.deepEqual(second.orchestrator.orphanedTaskIds, [taskId]);
  assert.equal(second.orchestrator.authenticate(executor.token), undefined);
  assert.ok(second.orchestrator.authenticate(first.orchestrator.issueSession().token));
});

test('rotating keeps the session and its tasks, and the old token stops working at once', async (t) => {
  const h = await makeHarness(t);
  const issued = h.orchestrator.issueSession();
  const conductor = h.orchestrator.authenticate(issued.token);
  assert.ok(conductor);
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });

  const rotated = h.orchestrator.rotateSession(issued.sessionId);
  assert.ok(rotated);
  assert.equal(rotated.sessionId, issued.sessionId);
  assert.notEqual(rotated.token, issued.token);
  assert.ok(rotated.token.startsWith(`mko_${issued.sessionId}.`));
  assert.equal(h.orchestrator.authenticate(issued.token), undefined);
  const again = h.orchestrator.authenticate(rotated.token);
  assert.equal(h.orchestrator.status(again ?? conductor, taskId).taskId, taskId);
  assert.equal(h.orchestrator.rotateSession('ses_unknown'), undefined);
});

test('a cached session cannot outlive a revoke, a rotate or the end of its task', async (t) => {
  const h = await makeHarness(t);
  const a = h.orchestrator.issueSession();
  assert.ok(h.orchestrator.authenticate(a.token));
  h.orchestrator.revokeSession(a.sessionId);
  assert.equal(h.orchestrator.authenticate(a.token), undefined);

  const b = h.orchestrator.issueSession();
  assert.ok(h.orchestrator.authenticate(b.token));
  const rotated = h.orchestrator.rotateSession(b.sessionId);
  assert.equal(h.orchestrator.authenticate(b.token), undefined);
  assert.ok(rotated && h.orchestrator.authenticate(rotated.token));

  h.orchestrator.setEndpoint('http://127.0.0.1:1/mcp');
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run');
  const token = h.fake.runFor(taskId).spec.mcp?.token ?? '';
  assert.ok(h.orchestrator.authenticate(token));
  await h.fake.runFor(taskId).complete();
  await h.orchestrator.wait(conductor, taskId, 2000);
  assert.equal(h.orchestrator.authenticate(token), undefined);
});

test('the session cache holds no more than its limit', () => {
  const store: SessionStore = new MemorySessionStore();
  const auth = new SessionAuth(store, { maxEntries: 3 });
  const tokens = Array.from({ length: 10 }, () => auth.issue().token);
  for (const token of tokens) assert.ok(auth.resolve(token));
  assert.equal(auth.cached, 3);
  for (const token of tokens) assert.ok(auth.resolve(token));
  assert.equal(auth.cached, 3);
});

test('revokeForTask removes the sessions of one task only', () => {
  const store = new MemorySessionStore();
  const auth = new SessionAuth(store);
  const a1 = auth.issue({ parentTaskId: 'tsk_a' });
  const a2 = auth.issue({ parentTaskId: 'tsk_a' });
  const b = auth.issue({ parentTaskId: 'tsk_b' });
  assert.ok(auth.resolve(a1.token) && auth.resolve(a2.token) && auth.resolve(b.token));
  auth.revokeForTask('tsk_a');
  assert.equal(auth.resolve(a1.token), undefined);
  assert.equal(auth.resolve(a2.token), undefined);
  assert.ok(auth.resolve(b.token));
  assert.deepEqual(store.deleteForTask('tsk_a'), []);
});
