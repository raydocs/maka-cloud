import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskStore } from '@maka-cloud/orchestrator';
import { conductorSession, recordingHandler } from './conductor.js';
import { eventually, newConversation, startHarness } from './harness.js';

test('a server restart resumes a running task once the MCP endpoint is up, and the log (SQLite) says so', async (t) => {
  const { handler, seen } = recordingHandler();
  const h = await startHarness(t, { handler, fake: { recover: true } });
  const conversationId = await newConversation(h);
  const { session } = await conductorSession(h, seen, conversationId);
  const { taskId } = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: 'x' });
  await eventually(() => h.server.orchestrator.taskStateOf(taskId) === 'running', 'running');
  assert.equal(h.fake.runs.length, 1);

  await h.restart();
  const orchestrator = h.server.orchestrator;
  assert.deepEqual(orchestrator.resumedTaskIds, [taskId]);
  assert.deepEqual(orchestrator.orphanedTaskIds, []);
  await eventually(() => h.fake.recoveries.length === 1, 'recover');
  const spec = h.fake.recoveries[0];
  assert.equal(spec?.recovery.epoch, 2);
  // The resumed executor gets the server's own endpoint, which exists only after it listened.
  assert.equal(spec?.mcp?.url, h.server.mcpUrl);
  assert.equal(orchestrator.taskStateOf(taskId), 'running');

  await h.fake.runs.at(-1)?.complete();
  await eventually(() => orchestrator.taskStateOf(taskId) === 'succeeded', 'the task to end');
  const log = (await (orchestrator as unknown as { store: TaskStore }).store.read()).map(
    ({ event }) => event.type,
  );
  assert.deepEqual(
    log.filter(
      (type) => type === 'task_attempt' || type === 'task_started' || type === 'task_failed',
    ),
    ['task_started', 'task_attempt'],
  );
});
