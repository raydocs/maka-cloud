import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { DEFAULT_QUOTAS, KeyedCounter } from '../quota.js';
import { OrchestratorServer } from '../server.js';
import { OrchestratorError } from '../types.js';
import { eventually, makeHarness } from './harness.js';

const isQuota = (error: unknown) =>
  error instanceof OrchestratorError && error.code === 'quota_exceeded';

test('the defaults are the ones the design note states', () => {
  assert.equal(DEFAULT_QUOTAS.maxActiveTasks, 32);
  assert.equal(DEFAULT_QUOTAS.maxTasksPerWindow, 200);
  assert.equal(DEFAULT_QUOTAS.taskWindowMs, 60 * 60_000);
  assert.equal(DEFAULT_QUOTAS.maxWaits, 8);
  assert.equal(DEFAULT_QUOTAS.maxExecutorWaits, 2);
  assert.equal(DEFAULT_QUOTAS.maxConnections, 8);
  assert.equal(DEFAULT_QUOTAS.maxExecutorConnections, 2);
});

test('a keyed counter removes a key when its count returns to zero', () => {
  const counter = new KeyedCounter<string>();
  assert.ok(counter.tryAcquire('a', 2));
  assert.ok(counter.tryAcquire('a', 2));
  assert.ok(!counter.tryAcquire('a', 2));
  counter.release('a');
  counter.release('a');
  counter.release('a');
  assert.equal(counter.keys, 0);
  assert.equal(counter.count('a'), 0);
});

test('concurrent delegates at limit - 1 create exactly one task', async (t) => {
  const h = await makeHarness(t, { orchestrator: { quotas: { maxActiveTasks: 3 } } });
  const conductor = h.session();
  await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'one' });
  await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'two' });

  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) =>
      h.orchestrator.delegate(conductor, { runner: 'fake', brief: `race ${i}` }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  for (const result of results) {
    if (result.status === 'rejected') assert.ok(isQuota(result.reason), String(result.reason));
  }
  assert.equal(h.store.activeTaskIds().length, 3);
  assert.equal(h.orchestrator.stats().activeTasks, 3);
});

test('a rejected delegate records nothing and leaves no brief behind', async (t) => {
  const h = await makeHarness(t, { orchestrator: { quotas: { maxActiveTasks: 1 } } });
  const conductor = h.session();
  await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'one' });
  await eventually(
    () => h.orchestrator.stats().activeTasks === 1 && h.fake.runs.length === 1,
    'run',
  );
  await eventually(
    () => h.store.readTask(h.store.activeTaskIds()[0] ?? '').length === 2,
    'task started',
  );
  const logBefore = (await h.store.read()).length;
  const dirsBefore = (await readdir(h.dir)).length;
  await assert.rejects(
    h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'two' }),
    isQuota,
  );
  assert.equal((await h.store.read()).length, logBefore);
  assert.equal((await readdir(h.dir)).length, dirsBefore);
});

test('the active-task limit covers the whole tree, frees up when tasks end, and is per conversation', async (t) => {
  const h = await makeHarness(t, { orchestrator: { quotas: { maxActiveTasks: 3 } } });
  const conductor = h.session();
  const parent = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'p' });
  const executor = h.executorSession(parent.taskId);
  const child = await h.orchestrator.delegate(executor, { runner: 'fake', brief: 'c1' });
  await h.orchestrator.delegate(executor, { runner: 'fake', brief: 'c2' });
  // Three unfinished tasks in this conversation, however deep they sit.
  await assert.rejects(h.orchestrator.delegate(executor, { runner: 'fake', brief: 'c3' }), isQuota);
  await assert.rejects(
    h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'p2' }),
    isQuota,
  );
  // Another conversation is not affected.
  await h.orchestrator.delegate(h.session(), { runner: 'fake', brief: 'elsewhere' });

  await eventually(() => h.fake.runs.some((run) => run.spec.taskId === child.taskId), 'run');
  await h.fake.runFor(child.taskId).complete();
  await h.orchestrator.wait(conductor, child.taskId, 2000);
  await h.orchestrator.delegate(executor, { runner: 'fake', brief: 'c3' });
});

test('the creation rate is a rolling window per conversation, counting finished tasks', async (t) => {
  let now = 1_000_000;
  const h = await makeHarness(t, {
    orchestrator: {
      now: () => now,
      quotas: { maxActiveTasks: 100, maxTasksPerWindow: 3, taskWindowMs: 60_000 },
    },
  });
  const conductor = h.session();
  for (let i = 0; i < 3; i += 1) {
    const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: `t${i}` });
    await h.orchestrator.cancel(conductor, taskId);
    now += 10_000;
  }
  assert.equal(h.orchestrator.stats().activeTasks, 0);
  await assert.rejects(h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' }), isQuota);
  await h.orchestrator.delegate(h.session(), { runner: 'fake', brief: 'other conversation' });

  // The first task was created at 1,000,000; at 1,060,001 it has left the window.
  now = 1_060_001;
  await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'allowed again' });
  await assert.rejects(h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'y' }), isQuota);
});

test('at the default rate, the 201st task within an hour is refused and the window rolls', async (t) => {
  let now = 5_000_000;
  const h = await makeHarness(t, {
    orchestrator: { now: () => now, quotas: { maxActiveTasks: 1000 } },
  });
  const conductor = h.session();
  for (let i = 0; i < 200; i += 1) {
    await h.orchestrator.delegate(conductor, { runner: 'fake', brief: `t${i}` });
  }
  await assert.rejects(h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' }), isQuota);
  now += 60 * 60_000 + 1;
  await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'next hour' });
});

test('waits are limited per session, freed by an abort, and wait-mode delegate is refused before a task exists', async (t) => {
  const h = await makeHarness(t, { orchestrator: { quotas: { maxWaits: 2 } } });
  const conductor = h.session();
  const { taskId } = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  const aborts = [new AbortController(), new AbortController()];
  const waits = aborts.map((abort) => h.orchestrator.wait(conductor, taskId, 60_000, abort.signal));
  await eventually(() => h.orchestrator.stats().sessionsWaiting === 1, 'slots taken');

  await assert.rejects(h.orchestrator.wait(conductor, taskId, 60_000), isQuota);
  const logBefore = (await h.store.read()).length;
  await assert.rejects(
    h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'w', mode: 'wait' }),
    isQuota,
  );
  assert.equal((await h.store.read()).length, logBefore);
  // Another session is not limited by this one.
  const other = h.session();
  const theirs = await h.orchestrator.delegate(other, { runner: 'fake', brief: 'y' });
  const otherAbort = new AbortController();
  const otherWait = h.orchestrator.wait(other, theirs.taskId, 60_000, otherAbort.signal);

  aborts[0]?.abort();
  await waits[0];
  const again = new AbortController();
  const third = h.orchestrator.wait(conductor, taskId, 60_000, again.signal);
  for (const abort of [aborts[1], again, otherAbort]) abort?.abort();
  await Promise.all([waits[1], third, otherWait]);
  assert.equal(h.orchestrator.stats().sessionsWaiting, 0);
  assert.equal(h.orchestrator.stats().waitedTasks, 0);
});

test('an executor session has its own, smaller wait limit', async (t) => {
  const h = await makeHarness(t, {
    orchestrator: { quotas: { maxWaits: 5, maxExecutorWaits: 1 } },
  });
  const conductor = h.session();
  const parent = await h.orchestrator.delegate(conductor, { runner: 'fake', brief: 'p' });
  const executor = h.executorSession(parent.taskId);
  const child = await h.orchestrator.delegate(executor, { runner: 'fake', brief: 'c' });
  const abort = new AbortController();
  const first = h.orchestrator.wait(executor, child.taskId, 60_000, abort.signal);
  await eventually(() => h.orchestrator.stats().sessionsWaiting === 1, 'slot taken');
  await assert.rejects(h.orchestrator.wait(executor, child.taskId, 60_000), isQuota);
  abort.abort();
  await first;
  assert.equal(h.orchestrator.stats().sessionsWaiting, 0);
});

function rpc(url: string, token: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
}

const listTools = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const waitCall = (taskId: string) => ({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'task_wait', arguments: { taskId, timeoutMs: 5000 } },
});

/** Opens a blocking task_wait over HTTP and returns once the server holds the connection. */
async function holdConnection(
  h: Awaited<ReturnType<typeof makeHarness>>,
  url: string,
  token: string,
) {
  const owner = h.orchestrator.authenticate(token);
  assert.ok(owner);
  const { taskId } = await h.orchestrator.delegate(owner, { runner: 'fake', brief: 'go' });
  const abort = new AbortController();
  const response = rpc(url, token, waitCall(taskId), abort.signal).catch(() => undefined);
  await eventually(() => h.orchestrator.stats().connectionSessions >= 1, 'connection held');
  return { abort, response };
}

test('open connections are limited per session; the extra one gets a 429 and the slot comes back on close', async (t) => {
  const h = await makeHarness(t, { orchestrator: { quotas: { maxConnections: 1 } } });
  const server = new OrchestratorServer(h.orchestrator);
  const url = await server.listen();
  t.after(() => server.close());
  const issued = h.orchestrator.issueSession();
  const held = await holdConnection(h, url, issued.token);

  const refused = await rpc(url, issued.token, listTools);
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get('retry-after'), '1');
  // Another session still connects.
  const other = await rpc(url, h.orchestrator.issueSession().token, listTools);
  assert.notEqual(other.status, 429);
  await other.arrayBuffer();

  held.abort.abort();
  await held.response;
  await eventually(() => h.orchestrator.stats().connectionSessions === 0, 'connection released');
  const accepted = await rpc(url, issued.token, listTools);
  assert.notEqual(accepted.status, 429);
  await accepted.arrayBuffer();
  await eventually(() => h.orchestrator.stats().connectionSessions === 0, 'all released');
});

test('a ceiling on all open connections applies across sessions', async (t) => {
  const h = await makeHarness(t, { orchestrator: { quotas: { maxTotalConnections: 1 } } });
  const server = new OrchestratorServer(h.orchestrator);
  const url = await server.listen();
  t.after(() => server.close());
  const held = await holdConnection(h, url, h.orchestrator.issueSession().token);
  const refused = await rpc(url, h.orchestrator.issueSession().token, listTools);
  assert.equal(refused.status, 429);
  held.abort.abort();
  await held.response;
  await eventually(() => h.orchestrator.stats().connectionSessions === 0, 'connection released');
  const accepted = await rpc(url, h.orchestrator.issueSession().token, listTools);
  assert.notEqual(accepted.status, 429);
  await accepted.arrayBuffer();
});
