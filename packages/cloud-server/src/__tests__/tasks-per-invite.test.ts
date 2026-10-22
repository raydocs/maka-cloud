import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TASKS_PER_INVITE } from '../cloud-server.js';
import { conductorSession, recordingHandler } from './conductor.js';
import { eventually, type Harness, newConversation, postJson, startHarness } from './harness.js';

const started = (h: Harness, taskId: string) => h.fake.runs.some((r) => r.spec.taskId === taskId);

async function conversationOf(h: Harness, token: string): Promise<string> {
  const res = await postJson(h, '/v1/conversations', {}, token);
  return ((await res.json()) as { conversationId: string }).conversationId;
}

test('one task tree runs at a time per invite by default', () => {
  assert.equal(DEFAULT_TASKS_PER_INVITE, 1);
});

test("an invite's second task waits for its first, across conversations, and another invite's does not", async (t) => {
  const { handler, seen } = recordingHandler();
  const h = await startHarness(t, { handler });
  const first = await conductorSession(h, seen, await newConversation(h));
  const second = await conductorSession(h, seen, await newConversation(h));
  const other = h.server.invites.create('other');
  const otherConversation = await conversationOf(h, other.token);
  await postJson(h, `/v1/conversations/${otherConversation}/messages`, { text: 'go' }, other.token);
  await eventually(() => seen.has(otherConversation), 'the other invite handler call');
  const third = await conductorSession(h, seen, otherConversation);
  const orchestrator = h.server.orchestrator;

  const running = await orchestrator.delegate(first.session, {
    runner: 'fake',
    brief: 'a',
    title: 'Refactor the parser',
  });
  const waiting = await orchestrator.delegate(second.session, { runner: 'fake', brief: 'b' });
  const elsewhere = await orchestrator.delegate(third.session, { runner: 'fake', brief: 'c' });
  assert.equal(waiting.state, 'queued');
  assert.equal(
    waiting.progress.at(-1),
    'One task runs at a time on this workspace for now. This one starts when "Refactor the parser" finishes.',
  );
  await eventually(() => started(h, running.taskId) && started(h, elsewhere.taskId), 'two runs');
  await orchestrator.settled();
  assert.equal(started(h, waiting.taskId), false);

  // A task the running one delegates shares its tree, so it is not held.
  const executor = orchestrator.authenticate(
    orchestrator.issueSession({ parentTaskId: running.taskId }).token,
  );
  assert.ok(executor);
  const child = await orchestrator.delegate(executor, { runner: 'fake', brief: 'child' });
  await eventually(() => started(h, child.taskId), 'the child run');
  assert.equal(started(h, waiting.taskId), false);

  await h.fake.runFor(child.taskId).complete();
  await h.fake.runFor(running.taskId).complete();
  await eventually(() => started(h, waiting.taskId), 'the waiting run');
});

test('tasksPerInvite raises the limit', async (t) => {
  const { handler, seen } = recordingHandler();
  const h = await startHarness(t, { handler, tasksPerInvite: 2 });
  const { session } = await conductorSession(h, seen, await newConversation(h));
  const one = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: '1' });
  const two = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: '2' });
  const three = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: '3' });
  await eventually(() => started(h, one.taskId) && started(h, two.taskId), 'two runs');
  assert.equal(three.state, 'queued');
  await h.server.orchestrator.settled();
  assert.equal(started(h, three.taskId), false);
});
