import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { conductorSession, recordingHandler } from './conductor.js';
import { eventually, type Harness, newConversation, openStream, startHarness } from './harness.js';

async function setup(t: TestContext, steerable = true) {
  const { handler, seen } = recordingHandler();
  const h = await startHarness(t, { handler, fake: { steerable } });
  const conversationId = await newConversation(h);
  const { session } = await conductorSession(h, seen, conversationId);
  const task = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: 'work' });
  await eventually(() => h.fake.runs.length === 1, 'run');
  await eventually(
    () => h.server.orchestrator.status(session, task.taskId).state === 'running',
    'running',
  );
  const listed = await h.api(`/v1/conversations/${conversationId}/tasks`);
  const views = (await listed.json()) as { tasks: { taskId: string; steerable: boolean }[] };
  assert.equal(views.tasks.find((view) => view.taskId === task.taskId)?.steerable, steerable);
  return { h, session, conversationId, taskId: task.taskId, run: h.fake.runFor(task.taskId) };
}

const send = (h: Harness, taskId: string, body: unknown, token?: string | null) =>
  h.api(`/v1/tasks/${taskId}/messages`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    ...(token === undefined ? {} : { token }),
  });

test('the owner’s message reaches the running task once, and the answer says when the agent has read it', async (t) => {
  const { h, taskId, run } = await setup(t);
  const sent = await send(h, taskId, { messageId: 'm1', text: 'Use the v2 API.' });
  assert.equal(sent.status, 200);
  assert.deepEqual(await sent.json(), { message: { messageId: 'm1', state: 'pending' } });
  assert.deepEqual(run.waiting, [{ steerId: 'm1', text: 'Use the v2 API.' }]);

  // A resend (a phone that did not hear the answer) applies once.
  const again = await send(h, taskId, { messageId: 'm1', text: 'Use the v2 API.' });
  assert.deepEqual(await again.json(), { message: { messageId: 'm1', state: 'pending' } });
  assert.equal(run.offers.length, 1);

  run.readWaiting();
  // A resend reports where the message stands, so asking again is how a client finds out.
  let state = 'pending';
  for (let tries = 0; tries < 200 && state !== 'delivered'; tries++) {
    const asked = await send(h, taskId, { messageId: 'm1', text: 'Use the v2 API.' });
    state = ((await asked.json()) as { message: { state: string } }).message.state;
    if (state !== 'delivered') await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(state, 'delivered');
  assert.equal(run.offers.length, 1, 'and it was not handed over again');
});

test('a message not yet read is withdrawn with DELETE; one the agent read is refused', async (t) => {
  const { h, taskId, run } = await setup(t);
  await send(h, taskId, { messageId: 'a', text: 'first' });
  await send(h, taskId, { messageId: 'b', text: 'second' });
  const withdrawn = await h.api(`/v1/tasks/${taskId}/messages/a`, { method: 'DELETE' });
  assert.equal(withdrawn.status, 200);
  assert.deepEqual(await withdrawn.json(), { message: { messageId: 'a', state: 'withdrawn' } });
  assert.deepEqual(
    run.readWaiting().map((message) => message.steerId),
    ['b'],
  );
  const read = await h.api(`/v1/tasks/${taskId}/messages/b`, { method: 'DELETE' });
  assert.equal(read.status, 409);
  assert.deepEqual(await read.json(), { error: 'invalid_state' });
  assert.equal((await h.api(`/v1/tasks/${taskId}/messages/zzz`, { method: 'DELETE' })).status, 404);
});

test('what the owner told the agent does not come back as a task event on the stream', async (t) => {
  const { h, conversationId, taskId } = await setup(t);
  const stream = await openStream(t, h, `?conversation=${conversationId}`);
  await send(h, taskId, { messageId: 'm1', text: 'a private instruction' });
  await eventually(() => stream.events.length >= 3, 'history');
  assert.ok(!JSON.stringify(stream.events).includes('private instruction'));
  assert.ok(!JSON.stringify(stream.events).includes('task_steer'));
});

test('a task whose runner cannot take messages answers 409 steer_unsupported; bad requests are refused', async (t) => {
  const plain = await setup(t, false);
  const refused = await send(plain.h, plain.taskId, { text: 'hello' });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: 'steer_unsupported' });

  const { h, taskId } = await setup(t);
  for (const body of [
    {},
    { text: '' },
    { text: 'x'.repeat(4001) },
    { text: 'x', extra: 1 },
    { text: 'x', messageId: 'a b' },
  ]) {
    assert.equal((await send(h, taskId, body)).status, 400, JSON.stringify(body).slice(0, 40));
  }
  assert.equal((await h.api(`/v1/tasks/${taskId}/messages`)).status, 405);
  assert.equal((await h.api(`/v1/tasks/${taskId}/messages/m1`, { method: 'POST' })).status, 405);
});

test('only the owner can send: a wrong token is 401 and another owner’s task is 404', async (t) => {
  const { h, taskId, run } = await setup(t);
  for (const token of [null, 'inv_x.y', 'garbage']) {
    assert.equal((await send(h, taskId, { text: 'hi' }, token)).status, 401);
  }
  const other = h.server.invites.create('other');
  assert.equal((await send(h, taskId, { text: 'hi' }, other.token)).status, 404);
  assert.equal(run.offers.length, 0);
  const inviteId = h.server.invites.list().find((invite) => invite.label === 'other')?.inviteId;
  assert.ok(inviteId);
  h.server.invites.revoke(inviteId);
  assert.equal((await send(h, taskId, { text: 'hi' }, other.token)).status, 401);
  assert.equal(run.offers.length, 0);
});

test('an unread message can still be checked after the task ends', async (t) => {
  const { h, session, taskId, run } = await setup(t);
  await send(h, taskId, { messageId: 'late', text: 'Use v2' });
  await run.complete();
  await eventually(
    () => h.server.orchestrator.status(session, taskId).state === 'succeeded',
    'ended',
  );
  const receipt = await send(h, taskId, { messageId: 'late', text: 'Use v2' });
  assert.equal(receipt.status, 200);
  assert.deepEqual(await receipt.json(), { message: { messageId: 'late', state: 'unseen' } });
});

test('control responses preserve runner steering capability', async (t) => {
  for (const steerable of [true, false]) {
    const { h, taskId } = await setup(t, steerable);
    const response = await h.api(`/v1/tasks/${taskId}/cancel`, {
      method: 'POST',
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { task: { steerable: boolean } };
    assert.equal(body.task.steerable, steerable);
  }
});
