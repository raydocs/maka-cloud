import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { OrchestratorServer } from '../server.js';
import { eventually, makeHarness, pendingWaits, sleep } from './harness.js';

function activeTimers(): number {
  return process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
}

async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

test('an aborted wait returns at once, frees its timer and entry, and leaves the task running', async (t) => {
  const h = await makeHarness(t);
  const session = h.session();
  const { taskId } = await h.orchestrator.delegate(session, { runner: 'fake', brief: 'go' });
  const timersBefore = activeTimers();

  const abort = new AbortController();
  const waiting = h.orchestrator.wait(session, taskId, 600_000, abort.signal);
  assert.equal(pendingWaits(h), 1);
  abort.abort();
  const view = await settlesWithin(waiting, 500);

  assert.equal(view.waitTimedOut, true);
  assert.ok(view.state === 'queued' || view.state === 'running', view.state);
  assert.equal(view.cancelRequested, false);
  assert.equal(pendingWaits(h), 0);
  assert.equal(activeTimers(), timersBefore);
  await eventually(() => h.fake.runs.length === 1, 'run');
  assert.equal(h.fake.runFor(taskId).cancelCalls, 0);
});

test('a wait whose signal is already aborted does not register anything', async (t) => {
  const h = await makeHarness(t);
  const session = h.session();
  const { taskId } = await h.orchestrator.delegate(session, { runner: 'fake', brief: 'go' });
  const timersBefore = activeTimers();
  const view = await settlesWithin(
    h.orchestrator.wait(session, taskId, 600_000, AbortSignal.abort()),
    500,
  );
  assert.equal(view.waitTimedOut, true);
  assert.equal(pendingWaits(h), 0);
  assert.equal(activeTimers(), timersBefore);
});

test('a wait that times out or finishes leaves no map entry behind', async (t) => {
  const h = await makeHarness(t);
  const session = h.session();
  const { taskId } = await h.orchestrator.delegate(session, { runner: 'fake', brief: 'go' });
  assert.equal((await h.orchestrator.wait(session, taskId, 10)).waitTimedOut, true);
  assert.equal(pendingWaits(h), 0);

  const finishing = h.orchestrator.wait(session, taskId, 5000);
  await eventually(() => h.fake.runs.length === 1, 'run');
  await h.fake.runFor(taskId).complete();
  assert.equal((await finishing).state, 'succeeded');
  assert.equal(pendingWaits(h), 0);
});

test('one aborted waiter does not disturb another waiting on the same task', async (t) => {
  const h = await makeHarness(t);
  const session = h.session();
  const { taskId } = await h.orchestrator.delegate(session, { runner: 'fake', brief: 'go' });
  const abort = new AbortController();
  const first = h.orchestrator.wait(session, taskId, 5000, abort.signal);
  const second = h.orchestrator.wait(session, taskId, 5000);
  abort.abort();
  assert.equal((await first).waitTimedOut, true);
  assert.equal(pendingWaits(h), 1);
  await eventually(() => h.fake.runs.length === 1, 'run');
  await h.fake.runFor(taskId).complete();
  assert.equal((await second).state, 'succeeded');
  assert.equal(pendingWaits(h), 0);
});

test('a client that disconnects during task_wait releases the wait without cancelling the task', async (t) => {
  const h = await makeHarness(t);
  const server = new OrchestratorServer(h.orchestrator);
  const url = await server.listen();
  t.after(() => server.close());
  const issued = h.orchestrator.issueSession();
  const token = issued.token;
  const client = new Client({ name: 'test-client', version: '1' }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  const started = await client.callTool({
    name: 'delegate_task',
    arguments: { runner: 'fake', brief: 'go' },
  });
  const taskId = (started.structuredContent as { taskId: string }).taskId;

  const call = client
    .callTool({ name: 'task_wait', arguments: { taskId, timeoutMs: 5000 } })
    .catch(() => undefined);
  await eventually(() => pendingWaits(h) === 1, 'wait registered');
  await client.close();
  await call;

  await eventually(() => pendingWaits(h) === 0, 'wait released after disconnect', 1500);
  await sleep(20);
  assert.equal(h.fake.runFor(taskId).cancelCalls, 0);
  assert.equal(
    h.orchestrator.status(h.orchestrator.authenticate(token) ?? h.session(), taskId).state,
    'running',
  );
});
