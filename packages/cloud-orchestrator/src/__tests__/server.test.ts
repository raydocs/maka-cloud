import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { type TestContext } from 'node:test';
import { OrchestratorServer } from '../server.js';
import type { TaskView } from '../types.js';
import { eventually, type Harness, makeHarness } from './harness.js';

async function startServer(t: TestContext) {
  const h = await makeHarness(t);
  const server = new OrchestratorServer(h.orchestrator);
  const url = await server.listen();
  t.after(() => server.close());
  return { h, server, url };
}

async function connect(t: TestContext, url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1' }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  t.after(() => client.close());
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    view: result.structuredContent as unknown as TaskView,
    text: (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '',
  };
}

test('exposes exactly the four orchestration tools', async (t) => {
  const { h, url } = await startServer(t);
  const client = await connect(t, url, h.orchestrator.issueSession().token);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'delegate_task',
    'task_cancel',
    'task_status',
    'task_wait',
  ]);
});

test('delegate, status, wait and cancel work end to end over HTTP', async (t) => {
  const { h, url } = await startServer(t);
  const client = await connect(t, url, h.orchestrator.issueSession().token);

  const started = await call(client, 'delegate_task', {
    runner: 'fake',
    brief: 'research X',
    title: 'research',
  });
  assert.equal(started.isError, false);
  const taskId = started.view.taskId;
  await eventually(() => h.fake.runs.length === 1, 'runner start');

  const status = await call(client, 'task_status', { taskId });
  assert.equal(status.view.taskId, taskId);

  const timedOut = await call(client, 'task_wait', { taskId, timeoutMs: 30 });
  assert.equal(timedOut.view.waitTimedOut, true);

  await h.fake.runFor(taskId).complete();
  const done = await call(client, 'task_wait', { taskId, timeoutMs: 5000 });
  assert.equal(done.view.state, 'succeeded');
  assert.equal(done.view.manifest?.confidence, 'high');

  const second = await call(client, 'delegate_task', {
    runner: 'fake',
    brief: 'again',
    mode: 'async',
  });
  await eventually(() => h.fake.runs.length === 2, 'second start');
  const cancelled = await call(client, 'task_cancel', { taskId: second.view.taskId });
  assert.equal(cancelled.view.state, 'cancelled');
  assert.equal(h.fake.runFor(second.view.taskId).cancelCalls, 1);
});

test('wait mode over HTTP returns the finished task', async (t) => {
  const h = await makeHarness(t, {
    fake: { onStart: (run) => void setTimeout(() => void run.complete(), 20) },
  });
  const server = new OrchestratorServer(h.orchestrator);
  const url = await server.listen();
  t.after(() => server.close());
  const client = await connect(t, url, h.orchestrator.issueSession().token);
  const result = await call(client, 'delegate_task', { runner: 'fake', brief: 'go', mode: 'wait' });
  assert.equal(result.view.state, 'succeeded');
});

test('tool errors come back as isError results with a code', async (t) => {
  const { h, url } = await startServer(t);
  const client = await connect(t, url, h.orchestrator.issueSession().token);
  const unknownRunner = await call(client, 'delegate_task', { runner: 'nope', brief: 'x' });
  assert.equal(unknownRunner.isError, true);
  assert.match(unknownRunner.text, /^unknown_runner:/u);
  const missing = await call(client, 'task_status', { taskId: 'tsk_missing' });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /^not_found:/u);
});

test('over HTTP one session cannot reach another session’s tasks', async (t) => {
  const { h, url } = await startServer(t);
  const alice = await connect(t, url, h.orchestrator.issueSession().token);
  const bob = await connect(t, url, h.orchestrator.issueSession().token);
  const { view } = await call(alice, 'delegate_task', { runner: 'fake', brief: 'secret' });
  for (const tool of ['task_status', 'task_wait', 'task_cancel']) {
    const result = await call(bob, tool, { taskId: view.taskId, timeoutMs: 10 });
    assert.equal(result.isError, true, tool);
    assert.match(result.text, /^not_found:/u, tool);
  }
  await eventually(() => h.fake.runs.length === 1, 'run');
  assert.equal(h.fake.runs[0]?.cancelCalls, 0);
});

test('the token given to a runner delegates as a child and sees only its own subtree', async (t) => {
  const { h, url } = await startServer(t);
  const conductor = await connect(t, url, h.orchestrator.issueSession().token);
  const parent = (await call(conductor, 'delegate_task', { runner: 'fake', brief: 'parent' })).view;
  const sibling = (await call(conductor, 'delegate_task', { runner: 'fake', brief: 'sibling' }))
    .view;
  await eventually(() => h.fake.runs.length === 2, 'runs');
  const spec = h.fake.runFor(parent.taskId).spec;
  assert.equal(spec.mcp?.url, url);

  const executor = await connect(t, url, spec.mcp?.token ?? '');
  const child = (await call(executor, 'delegate_task', { runner: 'fake', brief: 'child' })).view;
  assert.equal(child.parentTaskId, parent.taskId);
  assert.equal((await call(executor, 'task_status', { taskId: child.taskId })).isError, false);
  assert.equal((await call(executor, 'task_status', { taskId: parent.taskId })).isError, true);
  assert.equal((await call(executor, 'task_status', { taskId: sibling.taskId })).isError, true);

  // The conductor sees the child; cancelling the parent takes the child with it.
  assert.equal(
    (await call(conductor, 'task_status', { taskId: child.taskId })).view.taskId,
    child.taskId,
  );
  await eventually(() => h.fake.runs.length === 3, 'child run');
  await call(conductor, 'task_cancel', { taskId: parent.taskId });
  assert.equal(
    (await call(conductor, 'task_status', { taskId: child.taskId })).view.state,
    'cancelled',
  );
  assert.equal(
    (await call(conductor, 'task_status', { taskId: sibling.taskId })).view.state,
    'running',
  );
});

test('requests without a valid bearer token are rejected before any MCP handling', async (t) => {
  const { h, url } = await startServer(t);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  const missing = await fetch(url, { method: 'POST', headers, body });
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get('www-authenticate'), 'Bearer');
  const wrong = await fetch(url, {
    method: 'POST',
    headers: { ...headers, authorization: 'Bearer mko_wrong' },
    body,
  });
  assert.equal(wrong.status, 401);
  const issued = h.orchestrator.issueSession();
  h.orchestrator.revokeSession(issued.sessionId);
  const revoked = await fetch(url, {
    method: 'POST',
    headers: { ...headers, authorization: `Bearer ${issued.token}` },
    body,
  });
  assert.equal(revoked.status, 401);
  const wrongPath = await fetch(url.replace('/mcp', '/other'), { method: 'POST', headers, body });
  assert.equal(wrongPath.status, 404);
});

test('malformed JSON is a 400 and an oversized body is a 413', async (t) => {
  const { h, url } = await startServer(t);
  const token = h.orchestrator.issueSession().token;
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
  };
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{nope' })).status, 400);
  const huge = await fetch(url, { method: 'POST', headers, body: 'x'.repeat(400 * 1024) });
  assert.equal(huge.status, 413);
});
