import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OrchestratorError, type SessionInfo } from '@maka-cloud/orchestrator';
import { conductorSession, recordingHandler } from './conductor.js';
import {
  eventually,
  type Harness,
  newConversation,
  openStream,
  postJson,
  startHarness,
} from './harness.js';

// The orchestrator's own suite runs these against the in-memory store with the
// archive cache off. Here the same invariants run against SQLite, where a
// finished task is only ever read back from the database.
async function setup(t: Parameters<typeof startHarness>[0], overrides = {}) {
  const { handler, seen } = recordingHandler();
  const h = await startHarness(t, {
    handler,
    orchestrator: { caches: { archivedTasks: { maxEntries: 0 } } },
    ...overrides,
  });
  const conversationId = await newConversation(h);
  const { session } = await conductorSession(h, seen, conversationId);
  return { h, session, conversationId, orchestrator: h.server.orchestrator };
}

async function executorOf(h: Harness, taskId: string): Promise<SessionInfo> {
  const issued = h.server.orchestrator.issueSession({ parentTaskId: taskId });
  const session = h.server.orchestrator.authenticate(issued.token);
  assert.ok(session);
  return session;
}

async function finish(h: Harness, session: SessionInfo, taskId: string) {
  await eventually(() => h.fake.runs.some((run) => run.spec.taskId === taskId), 'run');
  await h.fake.runFor(taskId).complete();
  await h.server.orchestrator.wait(session, taskId, 2000);
}

test('a task whose ancestor ended and left memory cannot delegate (SQLite)', async (t) => {
  const { h, session, orchestrator } = await setup(t);
  const parent = await orchestrator.delegate(session, { runner: 'fake', brief: 'p' });
  const executor = await executorOf(h, parent.taskId);
  await finish(h, session, parent.taskId);
  assert.equal(orchestrator.stats().activeTasks, 0);
  await assert.rejects(
    orchestrator.delegate(executor, { runner: 'fake', brief: 'late' }),
    (error: unknown) => error instanceof OrchestratorError && error.code === 'invalid_request',
  );
});

test('cancel on an ended parent reaches its running descendants (SQLite)', async (t) => {
  const { h, session, orchestrator } = await setup(t);
  const parent = await orchestrator.delegate(session, { runner: 'fake', brief: 'p' });
  const child = await orchestrator.delegate(await executorOf(h, parent.taskId), {
    runner: 'fake',
    brief: 'c',
  });
  await eventually(() => h.fake.runs.length === 2, 'runs');
  await finish(h, session, parent.taskId);
  const view = await orchestrator.cancel(session, parent.taskId);
  assert.equal(view.state, 'succeeded');
  assert.equal(orchestrator.status(session, child.taskId).state, 'cancelled');
  assert.equal(h.fake.runFor(child.taskId).cancelCalls, 1);
});

test('a wait on a finished task returns at once (SQLite)', async (t) => {
  const { h, session, orchestrator } = await setup(t, {
    orchestrator: { quotas: { maxWaits: 0 }, caches: { archivedTasks: { maxEntries: 0 } } },
  });
  const { taskId } = await orchestrator.delegate(session, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run');
  await h.fake.runFor(taskId).complete();
  await eventually(() => orchestrator.stats().activeTasks === 0, 'archived');
  const view = await orchestrator.wait(session, taskId, 60_000);
  assert.equal(view.state, 'succeeded');
  assert.equal(view.waitTimedOut, undefined);
});

test('concurrent delegates at limit - 1 create exactly one task (SQLite)', async (t) => {
  const { session, orchestrator } = await setup(t, {
    orchestrator: { quotas: { maxActiveTasks: 3 }, caches: { archivedTasks: { maxEntries: 0 } } },
  });
  await orchestrator.delegate(session, { runner: 'fake', brief: 'one' });
  await orchestrator.delegate(session, { runner: 'fake', brief: 'two' });
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) =>
      orchestrator.delegate(session, { runner: 'fake', brief: `r${i}` }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  for (const result of results) {
    if (result.status === 'rejected') {
      assert.ok(
        result.reason instanceof OrchestratorError && result.reason.code === 'quota_exceeded',
      );
    }
  }
  assert.equal(orchestrator.stats().activeTasks, 3);
});

test('the creation rate survives a restart: it is counted from the database', async (t) => {
  let now = 10_000_000;
  const { h, session } = await setup(t, {
    orchestrator: { now: () => now, quotas: { maxTasksPerWindow: 2, maxActiveTasks: 50 } },
  });
  const orchestrator = h.server.orchestrator;
  await orchestrator.delegate(session, { runner: 'fake', brief: 'a' });
  await orchestrator.delegate(session, { runner: 'fake', brief: 'b' });
  await h.restart();
  const rotated = h.server.orchestrator.rotateSession(session.sessionId);
  assert.ok(rotated);
  const again = h.server.orchestrator.authenticate(rotated.token);
  assert.ok(again);
  await assert.rejects(
    h.server.orchestrator.delegate(again, { runner: 'fake', brief: 'c' }),
    (error: unknown) => error instanceof OrchestratorError && error.code === 'quota_exceeded',
  );
  now += 61 * 60_000;
  await h.server.orchestrator.delegate(again, { runner: 'fake', brief: 'later' });
});

test('the tasks route lists one conversation, in order, in pages', async (t) => {
  const { h, session, conversationId, orchestrator } = await setup(t);
  const otherConversation = await newConversation(h);
  const ids: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    ids.push((await orchestrator.delegate(session, { runner: 'fake', brief: `t${i}` })).taskId);
  }
  const page = async (query: string) =>
    (await (await h.api(`/v1/conversations/${conversationId}/tasks${query}`)).json()) as {
      tasks: Array<{ taskId: string }>;
      next?: number;
    };
  const first = await page('?limit=2');
  assert.deepEqual(
    first.tasks.map((task) => task.taskId),
    ids.slice(0, 2),
  );
  assert.ok(first.next !== undefined);
  const second = await page(`?limit=2&after=${first.next}`);
  assert.deepEqual(
    second.tasks.map((task) => task.taskId),
    ids.slice(2, 4),
  );
  const third = await page(`?limit=2&after=${second.next}`);
  assert.deepEqual(
    third.tasks.map((task) => task.taskId),
    ids.slice(4),
  );
  assert.equal(third.next, undefined);
  const empty = (await (await h.api(`/v1/conversations/${otherConversation}/tasks`)).json()) as {
    tasks: unknown[];
  };
  assert.deepEqual(empty.tasks, []);
});

test('task events reach the conversation stream, with their log seq, in order', async (t) => {
  const { h, session, conversationId, orchestrator } = await setup(t);
  const stream = await openStream(t, h, `?conversation=${conversationId}`);
  const { taskId } = await orchestrator.delegate(session, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run');
  await h.fake.runFor(taskId).complete();
  await orchestrator.wait(session, taskId, 2000);
  await eventually(
    () => stream.events.filter((e) => e.event === 'task.event').length >= 3,
    'task events',
  );
  const taskEvents = stream.events.filter((e) => e.event === 'task.event');
  assert.deepEqual(
    taskEvents.map((e) => (e.data.event as { type: string }).type),
    ['task_created', 'task_started', 'task_succeeded'],
  );
  const seqs = taskEvents.map((e) => e.data.seq as number);
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
  );
  assert.ok(taskEvents.every((e) => e.data.conversationId === conversationId));
});

test('another conversation does not see the first one’s task events', async (t) => {
  const { h, session, orchestrator } = await setup(t);
  const other = await newConversation(h);
  const stream = await openStream(t, h, `?conversation=${other}`);
  await orchestrator.delegate(session, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run');
  // The feed is ordered: once the other conversation's own marker arrives, any task event
  // that wrongly reached this stream would already be in front of it.
  const marker = await postJson(h, `/v1/conversations/${other}/messages`, { text: 'marker' });
  assert.equal(marker.status, 202);
  await stream.until(2);
  assert.deepEqual(
    stream.events.map((e) => e.event),
    ['conversation.created', 'message.posted'],
  );
});

test('the orchestrator MCP endpoint is up on its own port and wants a session token', async (t) => {
  const { h } = await setup(t);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  const noToken = await fetch(h.server.mcpUrl, { method: 'POST', headers, body });
  assert.equal(noToken.status, 401);
  // An invite token is not a session token.
  const invite = await fetch(h.server.mcpUrl, {
    method: 'POST',
    headers: { ...headers, authorization: `Bearer ${h.token}` },
    body,
  });
  assert.equal(invite.status, 401);
  assert.notEqual(new URL(h.server.mcpUrl).port, new URL(h.server.url).port);
});
