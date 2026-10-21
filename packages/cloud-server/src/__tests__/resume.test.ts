import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskStore } from '@maka-cloud/orchestrator';
import { conductorSession, recordingHandler } from './conductor.js';
import { eventually, newConversation, openStream, startHarness } from './harness.js';

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

test('a viewer that was connected across a restart picks up from its cursor: the restart event once, then the end, nothing repeated and no driver-only event', async (t) => {
  const { handler, seen } = recordingHandler();
  const h = await startHarness(t, { handler, fake: { recover: true } });
  const conversationId = await newConversation(h);
  const { session } = await conductorSession(h, seen, conversationId);
  const { taskId } = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: 'x' });
  await eventually(() => h.server.orchestrator.taskStateOf(taskId) === 'running', 'running');

  const before = await openStream(t, h, `?conversation=${conversationId}`);
  await eventually(
    () =>
      before.events.some(
        (e) => (e.data.event as { type?: string } | undefined)?.type === 'task_started',
      ),
    'the task to start on the stream',
  );
  const cursor = before.events.at(-1)?.id as number;
  before.close();

  await h.restart();
  await eventually(() => h.fake.recoveries.length === 1, 'recover');
  // The same viewer comes back with its cursor.
  const after = await openStream(t, h, `?conversation=${conversationId}`, {
    'last-event-id': String(cursor),
  });
  const kinds = () =>
    after.events.map((e) => (e.data.event as { type?: string } | undefined)?.type ?? e.event);
  await eventually(() => kinds().includes('task_restarted'), 'the restart event');
  await h.fake.runs.at(-1)?.complete();
  await eventually(() => kinds().includes('task_succeeded'), 'the end');

  // The note that claims the task, the event for the cut-off run coming back, and the end.
  assert.deepEqual(kinds(), ['task_progress', 'task_restarted', 'task_succeeded']);
  const restart = after.events[1]?.data.event as { epoch: number; text: string };
  assert.equal(restart.epoch, 2);
  assert.match(restart.text, /server restarted/u);
  const ids = after.events.map((e) => e.id);
  assert.ok(
    ids.every((id, index) => id > cursor && (index === 0 || id > (ids[index - 1] as number))),
  );
  // The attempt and the steps stay in the log and never reach a viewer.
  const text = JSON.stringify(after.events);
  assert.ok(!text.includes('task_attempt') && !text.includes('step_'));
});
