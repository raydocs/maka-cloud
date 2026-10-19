import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { OrchestratorError, type OperatorAccess } from '@maka-cloud/orchestrator';
import { ConversationStore } from '../conversations.js';
import { CostLedger } from '../cost.js';
import { openDatabase } from '../db.js';
import { FeedHub } from '../feed.js';
import { DEFAULT_HTTP_LIMITS, PublicApi } from '../http.js';
import { InviteStore } from '../invites.js';
import { RateLimiter } from '../rate-limit.js';
import { SqliteTaskStore } from '../sqlite-task-store.js';
import { conductorSession, recordingHandler } from './conductor.js';
import { eventually, type Harness, newConversation, openStream, startHarness } from './harness.js';

interface TaskJson {
  taskId: string;
  state: string;
  pauseRequested: boolean;
  cancelRequested: boolean;
  costUsd?: number;
  runner?: unknown;
}

async function setup(t: TestContext, overrides: Parameters<typeof startHarness>[1] = {}) {
  const { handler, seen } = recordingHandler();
  const h = await startHarness(t, { handler, ...overrides });
  const conversationId = await newConversation(h);
  const { session } = await conductorSession(h, seen, conversationId);
  const start = async (brief = 'work') => {
    const before = h.fake.runs.length;
    const task = await h.server.orchestrator.delegate(session, { runner: 'fake', brief });
    await eventually(() => h.fake.runs.length > before, 'run');
    await eventually(
      () => h.server.orchestrator.status(session, task.taskId).state === 'running',
      'running',
    );
    return task.taskId;
  };
  return { h, conversationId, session, start };
}

function act(h: Harness, taskId: string, action: string, token?: string | null) {
  return h.api(`/v1/tasks/${taskId}/${action}`, {
    method: 'POST',
    ...(token === undefined ? {} : { token }),
  });
}

async function view(res: Response): Promise<TaskJson> {
  return ((await res.json()) as { task: TaskJson }).task;
}

async function listed(h: Harness, conversationId: string): Promise<TaskJson[]> {
  const res = await h.api(`/v1/conversations/${conversationId}/tasks`);
  return ((await res.json()) as { tasks: TaskJson[] }).tasks;
}

test('cancel through the public API stops the run and answers with the public view', async (t) => {
  const { h, start } = await setup(t);
  const taskId = await start();
  const res = await act(h, taskId, 'cancel');
  assert.equal(res.status, 200);
  const task = await view(res);
  assert.equal(task.state, 'cancelled');
  assert.equal(h.fake.runFor(taskId).cancelCalls, 1);
  assert.ok(!('runner' in task));
});

test('pause holds the task, resume continues it, and the stream carries both without a runner id', async (t) => {
  const { h, conversationId, start } = await setup(t);
  const taskId = await start();
  const stream = await openStream(t, h, `?conversation=${conversationId}`);

  const paused = await view(await act(h, taskId, 'pause'));
  assert.equal(paused.state, 'paused');
  assert.equal(paused.pauseRequested, true);
  assert.equal(h.fake.runFor(taskId).paused, true);
  assert.equal((await listed(h, conversationId))[0]?.state, 'paused');

  const resumed = await view(await act(h, taskId, 'resume'));
  assert.equal(resumed.state, 'running');
  assert.equal(resumed.pauseRequested, false);
  assert.equal(h.fake.runFor(taskId).paused, false);

  await eventually(
    () =>
      stream.events
        .filter((e) => e.event === 'task.event')
        .some((e) => (e.data.event as { type: string }).type === 'task_resumed'),
    'task_resumed on the stream',
  );
  const types = stream.events
    .filter((e) => e.event === 'task.event')
    .map((e) => (e.data.event as { type: string }).type);
  assert.deepEqual(
    types.filter((type) => type.includes('pause') || type.includes('resum')),
    ['task_pause_requested', 'task_paused', 'task_resume_requested', 'task_resumed'],
  );
  // Neither the stream nor the task list names the runner, anywhere in the JSON.
  assert.ok(!JSON.stringify(stream.events).includes('runner'));
  assert.ok(!JSON.stringify(await listed(h, conversationId)).includes('runner'));
});

test('a missing or wrong token gets the same 401 on all three routes, and a revoked one stops working', async (t) => {
  const { h, start } = await setup(t);
  const taskId = await start();
  for (const action of ['cancel', 'pause', 'resume']) {
    for (const token of [null, 'inv_x.y', 'garbage']) {
      const res = await act(h, taskId, action, token);
      assert.equal(res.status, 401, `${action} with ${String(token)}`);
      assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    }
  }
  const other = h.server.invites.create('other');
  const inviteId = h.server.invites.list().find((invite) => invite.label === 'other')?.inviteId;
  assert.ok(inviteId);
  h.server.invites.revoke(inviteId);
  assert.equal((await act(h, taskId, 'cancel', other.token)).status, 401);
  assert.equal(h.fake.runFor(taskId).cancelCalls, 0);
});

test('an unknown task is 404, wrong methods are 405, and neither takes a rate-limit token', async (t) => {
  const { h } = await setup(t, { http: { controlPerMinute: 1 } });
  for (let i = 0; i < 3; i += 1) assert.equal((await act(h, 'tsk_nope', 'pause')).status, 404);
  const wrong = await h.api('/v1/tasks/tsk_nope/pause');
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get('allow'), 'POST');
  assert.equal((await act(h, 'tsk_nope', 'stop')).status, 404);
});

test('a runner that cannot pause answers 409 pause_unsupported and nothing is recorded', async (t) => {
  const { h, conversationId, start } = await setup(t, { fake: { pausable: false } });
  const taskId = await start();
  const res = await act(h, taskId, 'pause');
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'pause_unsupported' });
  const stream = await openStream(t, h, `?conversation=${conversationId}`);
  const count = (await listed(h, conversationId)).length;
  assert.equal(count, 1);
  await eventually(() => stream.events.length >= 4, 'history');
  assert.ok(
    !stream.events.some((e) =>
      String((e.data.event as { type?: string } | undefined)?.type).includes('pause'),
    ),
  );
});

test('a finished task refuses pause and resume with 409 and takes cancel as a no-op', async (t) => {
  const { h, start } = await setup(t);
  const taskId = await start();
  await h.fake.runFor(taskId).complete();
  await eventually(() => h.server.orchestrator.stats().activeTasks === 0, 'task ended');
  assert.equal((await act(h, taskId, 'pause')).status, 409);
  assert.equal((await act(h, taskId, 'resume')).status, 409);
  const cancelled = await act(h, taskId, 'cancel');
  assert.equal(cancelled.status, 200);
  assert.equal((await view(cancelled)).state, 'succeeded');
  assert.equal(h.fake.runFor(taskId).cancelCalls, 0);
});

test('resume needs a paused task', async (t) => {
  const { h, start } = await setup(t);
  const taskId = await start();
  const res = await act(h, taskId, 'resume');
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'invalid_state' });
});

test('cancel reaches a paused task', async (t) => {
  const { h, start } = await setup(t);
  const taskId = await start();
  assert.equal((await view(await act(h, taskId, 'pause'))).state, 'paused');
  const task = await view(await act(h, taskId, 'cancel'));
  assert.equal(task.state, 'cancelled');
  assert.equal(h.fake.runFor(taskId).cancelCalls, 1);
  assert.equal(h.fake.runFor(taskId).resumeCalls, 0);
});

test('two pause requests at once ask the runner once', async (t) => {
  const { h, start } = await setup(t);
  const taskId = await start();
  const hold = h.fake.runFor(taskId).holdPause();
  const first = act(h, taskId, 'pause');
  await eventually(() => h.fake.runFor(taskId).pauseCalls === 1, 'runner asked');
  const second = act(h, taskId, 'pause');
  hold.release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(h.fake.runFor(taskId).pauseCalls, 1);
});

test('control requests are limited per invite and the limit comes back with Retry-After', async (t) => {
  const { h, start } = await setup(t, { http: { controlPerMinute: 3 } });
  const taskId = await start();
  assert.equal((await act(h, taskId, 'pause')).status, 200);
  assert.equal((await act(h, taskId, 'resume')).status, 200);
  assert.equal((await act(h, taskId, 'pause')).status, 200);
  const refused = await act(h, taskId, 'resume');
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('retry-after')) >= 1);
  assert.equal(h.fake.runFor(taskId).resumeCalls, 1);
  const other = h.server.invites.create('other');
  assert.equal((await act(h, taskId, 'resume', other.token)).status, 200);
});

test('a task that was paused when the server stopped is ended on restart', async (t) => {
  const { h, conversationId, start } = await setup(t);
  const taskId = await start();
  assert.equal((await view(await act(h, taskId, 'pause'))).state, 'paused');
  await h.restart();
  const [task] = await listed(h, conversationId);
  assert.equal(task?.taskId, taskId);
  assert.equal(task?.state, 'failed');
  assert.equal((await act(h, taskId, 'resume')).status, 409);
});

test('cost: absent until reported, only ever grows, shows in the task list and the stream, and survives a restart', async (t) => {
  const { h, conversationId, start } = await setup(t);
  const taskId = await start();
  assert.ok(!('costUsd' in ((await listed(h, conversationId))[0] ?? {})));

  assert.equal(h.server.reportCost(taskId, 0), false);
  assert.equal(h.server.reportCost(taskId, -1), false);
  assert.equal(h.server.reportCost(taskId, Number.NaN), false);
  assert.equal(h.server.reportCost('tsk_nope', 1), false);
  assert.equal(h.server.reportCost(taskId, 0.25), true);
  assert.equal(h.server.reportCost(taskId, 0.1), false);
  assert.equal(h.server.reportCost(taskId, 0.25), false);
  assert.equal(h.server.reportCost(taskId, 0.5), true);
  assert.equal((await listed(h, conversationId))[0]?.costUsd, 0.5);

  const stream = await openStream(t, h, `?conversation=${conversationId}`);
  await eventually(() => stream.events.some((e) => e.event === 'task.cost'), 'cost on the stream');
  const costs = stream.events.filter((e) => e.event === 'task.cost');
  assert.deepEqual(
    costs.map((e) => [e.data.taskId, e.data.costUsd]),
    [
      [taskId, 0.25],
      [taskId, 0.5],
    ],
  );
  const lastSeen = stream.events.at(-1)?.id ?? 0;
  stream.close();

  assert.equal(h.server.reportCost(taskId, 0.75), true);
  await h.restart();
  assert.equal((await listed(h, conversationId))[0]?.costUsd, 0.75);
  const resumed = await openStream(t, h, `?conversation=${conversationId}`, {
    'last-event-id': String(lastSeen),
  });
  const [next] = await resumed.until(1);
  assert.equal(next?.event, 'task.cost');
  assert.equal(next?.data.costUsd, 0.75);
});

test('cost is append-only in the database', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cost-test-'));
  const db = openDatabase(join(dir, 'server.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  db.prepare('INSERT INTO task_cost_log (task_id, usd, at) VALUES (?, ?, ?)').run('tsk_1', 1, 1);
  assert.throws(() => db.exec('UPDATE task_cost_log SET usd = 0'), /append-only/u);
  assert.throws(() => db.exec('DELETE FROM task_cost_log'), /append-only/u);
});

// The orchestrator's own suite proves `authorize` runs in the write chain. This
// proves the server's `authorize` is the real check: it looks at the invite and the
// conversation at that moment, not at what was true when the request arrived.
test('the access handed to the orchestrator re-checks the invite when the orchestrator calls it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'control-access-'));
  const db = openDatabase(join(dir, 'server.sqlite'));
  const hub = new FeedHub();
  const invites = new InviteStore(join(dir, 'invites.sqlite'));
  const invite = invites.create('test');
  let n = 0;
  const conversations = new ConversationStore(db, hub, () => ({
    sessionId: `ses_${n++}`,
    token: 'unused',
  }));
  const conversation = conversations.create();
  const sessionId = conversations.sessionOf(conversation.conversationId) ?? '';
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached: () => void = () => undefined;
  const arrived = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const api = new PublicApi({
    db,
    invites,
    conversations,
    tasks: new SqliteTaskStore(db, hub),
    hub,
    messageLimiter: new RateLimiter(1_000_000),
    controlLimiter: new RateLimiter(1_000_000),
    orchestrator: {
      rootSessionOfTask: () => sessionId,
      cancelAs: async (access: OperatorAccess) => {
        reached();
        await gate;
        access.authorize();
        throw new OrchestratorError('invalid_state', 'unreachable');
      },
      pauseAs: () => Promise.reject(new Error('unused')),
      resumeAs: () => Promise.reject(new Error('unused')),
    },
    costs: new CostLedger(db, hub),
    artifacts: { read: () => Promise.resolve({ ok: false, reason: 'not_found' }) },
    artifactLimiter: new RateLimiter(1_000_000),
    limits: DEFAULT_HTTP_LIMITS,
    onMessage: () => undefined,
  });
  const server = createServer((req, res) => {
    void api.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    invites.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/tasks/tsk_1/cancel`;
  const pending = fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${invite.token}` },
  });
  await arrived;
  invites.revoke(invite.inviteId);
  release();
  assert.equal((await pending).status, 401);
});
