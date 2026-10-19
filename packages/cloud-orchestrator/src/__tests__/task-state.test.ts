import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventually, makeHarness } from './harness.js';

test('taskStateOf follows a task from running to its end, and knows no task it never saw', async (t) => {
  const h = await makeHarness(t);
  const session = h.session();
  const { taskId } = await h.orchestrator.delegate(session, { runner: 'fake', brief: 'go' });
  await eventually(() => h.fake.runs.length === 1, 'runner start');
  await eventually(() => h.orchestrator.taskStateOf(taskId) === 'running', 'running');
  assert.equal(h.orchestrator.rootSessionOfTask(taskId), session.sessionId);

  await h.fake.runFor(taskId).complete();
  await h.orchestrator.wait(session, taskId, 2000);
  assert.equal(h.orchestrator.taskStateOf(taskId), 'succeeded');
  assert.equal(h.orchestrator.taskStateOf('tsk_missing'), undefined);
});
