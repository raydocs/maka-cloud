import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conductorSession, recordingHandler } from './conductor.js';
import { eventually, newConversation, openStream, startHarness } from './harness.js';

test('a restart keeps tasks, ends the running one with an orphan event and continues the stream from old ids', async (t) => {
  const { handler, seen } = recordingHandler();
  const h = await startHarness(t, { handler });
  const conversationId = await newConversation(h);
  const { session, token } = await conductorSession(h, seen, conversationId);
  const orchestrator = h.server.orchestrator;

  const done = await orchestrator.delegate(session, { runner: 'fake', brief: 'done' });
  const running = await orchestrator.delegate(session, { runner: 'fake', brief: 'running' });
  await eventually(() => h.fake.runs.length === 2, 'runs');
  await h.fake.runFor(done.taskId).complete();
  await orchestrator.wait(session, done.taskId, 2000);
  await eventually(
    () => orchestrator.status(session, running.taskId).state === 'running',
    'running',
  );

  const before = await openStream(t, h, `?conversation=${conversationId}`);
  const known = await before.until(1);
  await eventually(() => before.events.length >= 7, 'events before restart');
  const lastSeen = before.events.at(-1)?.id ?? 0;
  const countBefore = before.events.length;
  before.close();
  assert.ok(known.length > 0);

  await h.restart();
  const after = h.server.orchestrator;

  // Same tasks, the running one ended by an appended event.
  const tasks = (await (await h.api(`/v1/conversations/${conversationId}/tasks`)).json()) as {
    tasks: Array<{ taskId: string; state: string; failureReason?: string }>;
  };
  assert.deepEqual(
    tasks.tasks.map((task) => [task.taskId, task.state]),
    [
      [done.taskId, 'succeeded'],
      [running.taskId, 'failed'],
    ],
  );
  assert.match(tasks.tasks[1]?.failureReason ?? '', /orphaned/u);
  assert.deepEqual(after.orphanedTaskIds, [running.taskId]);

  // The stream resumes from the old id and shows the orphan event exactly once.
  const resumed = await openStream(t, h, `?conversation=${conversationId}`, {
    'last-event-id': String(lastSeen),
  });
  const [orphan] = await resumed.until(1);
  assert.equal(orphan?.event, 'task.event');
  assert.equal((orphan?.data.event as { type: string } | undefined)?.type, 'task_failed');
  assert.ok((orphan?.id ?? 0) > lastSeen);
  const full = await openStream(t, h, `?conversation=${conversationId}`);
  await full.until(countBefore + 1);
  assert.deepEqual(
    full.events.slice(0, countBefore).map((e) => e.id),
    before.events.map((e) => e.id),
  );

  // The conductor's token still works and still sees its tasks.
  const again = after.authenticate(token);
  assert.equal(again?.sessionId, session.sessionId);
  assert.equal(after.status(again ?? session, done.taskId).state, 'succeeded');
});

test('a restart over a log with many finished tasks loads only the unfinished ones', async (t) => {
  const { handler, seen } = recordingHandler();
  const h = await startHarness(t, {
    handler,
    orchestrator: { caches: { archivedTasks: { maxEntries: 0 } } },
  });
  const conversationId = await newConversation(h);
  const { session } = await conductorSession(h, seen, conversationId);
  const orchestrator = h.server.orchestrator;
  for (let i = 0; i < 30; i += 1) {
    const { taskId } = await orchestrator.delegate(session, { runner: 'fake', brief: `t${i}` });
    await eventually(() => h.fake.runs.some((run) => run.spec.taskId === taskId), 'run');
    await h.fake.runFor(taskId).complete();
    await orchestrator.wait(session, taskId, 2000);
  }
  const live = await orchestrator.delegate(session, { runner: 'fake', brief: 'live' });
  await eventually(() => h.fake.runs.length === 31, 'live run');

  await h.restart();
  assert.deepEqual(h.server.orchestrator.orphanedTaskIds, [live.taskId]);
  assert.equal(h.server.orchestrator.stats().activeTasks, 0);
  const tasks = (await (
    await h.api(`/v1/conversations/${conversationId}/tasks?limit=200`)
  ).json()) as {
    tasks: unknown[];
  };
  assert.equal(tasks.tasks.length, 31);
});

test('an executor token for a task that was running at the restart is revoked, and no token is stored in clear', async (t) => {
  const { handler, seen } = recordingHandler();
  const h = await startHarness(t, { handler });
  const conversationId = await newConversation(h);
  const { session, token } = await conductorSession(h, seen, conversationId);
  const { taskId } = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run');
  const executorToken = h.fake.runFor(taskId).spec.mcp?.token ?? '';
  assert.ok(h.server.orchestrator.authenticate(executorToken));
  const inviteToken = h.token;

  await h.restart();
  assert.equal(h.server.orchestrator.authenticate(executorToken), undefined);
  assert.ok(h.server.orchestrator.authenticate(token));
  await h.server.close();

  const { readFile } = await import('node:fs/promises');
  for (const file of [
    h.options.dbPath,
    `${h.options.dbPath}-wal`,
    h.options.invitesPath,
    `${h.options.invitesPath}-wal`,
  ]) {
    const bytes = await readFile(file).catch(() => Buffer.alloc(0));
    for (const secret of [token, executorToken, inviteToken]) {
      assert.ok(!bytes.includes(Buffer.from(secret.slice(secret.indexOf('.') + 1))), file);
    }
  }
  await h.restart();
});
