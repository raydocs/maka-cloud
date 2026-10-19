import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { type TestContext, test } from 'node:test';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { SessionAuth } from '../auth.js';
import { createSessionMcpServer } from '../server.js';
import { OrchestratorError } from '../types.js';
import { makeHarness } from './harness.js';

function spyOnTimingSafeEqual(t: TestContext) {
  const spy = t.mock.method(crypto, 'timingSafeEqual');
  // Named imports of built-ins only see the replacement after a sync.
  syncBuiltinESMExports();
  t.after(() => {
    spy.mock.restore();
    syncBuiltinESMExports();
  });
  return spy;
}

test('token digests are compared with timingSafeEqual', (t) => {
  const auth = new SessionAuth();
  const issued = auth.issue();
  const spy = spyOnTimingSafeEqual(t);

  assert.equal(auth.resolve(issued.token)?.sessionId, issued.sessionId);
  assert.equal(spy.mock.callCount(), 1);
  const [stored, presented] = spy.mock.calls[0]?.arguments ?? [];
  assert.ok(Buffer.isBuffer(stored) && Buffer.isBuffer(presented));
  assert.equal(stored.length, presented.length);

  const wrongSecret = `${issued.token.slice(0, issued.token.indexOf('.'))}.nope`;
  assert.equal(auth.resolve(wrongSecret), undefined);
  assert.equal(spy.mock.callCount(), 2);
});

test('malformed tokens and unknown sessions never authenticate', () => {
  const auth = new SessionAuth();
  const issued = auth.issue();
  for (const token of ['', 'mko_', 'mko_.', 'nope', 'mko_ses_unknown.secret', issued.sessionId]) {
    assert.equal(auth.resolve(token), undefined, token);
  }
});

test('a revoked session fails a tool call that was already authenticated', async (t) => {
  const h = await makeHarness(t);
  const issued = h.orchestrator.issueSession();
  const session = h.orchestrator.authenticate(issued.token);
  assert.ok(session);
  const server = createSessionMcpServer(h.orchestrator, session);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '1' }, { capabilities: {} });
  await client.connect(clientSide);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const before = await client.callTool({
    name: 'delegate_task',
    arguments: { runner: 'fake', brief: 'go' },
  });
  assert.notEqual(before.isError, true);

  h.orchestrator.revokeSession(session.sessionId);
  for (const [name, args] of [
    ['delegate_task', { runner: 'fake', brief: 'again' }],
    ['task_status', { taskId: 'tsk_x' }],
    ['task_wait', { taskId: 'tsk_x', timeoutMs: 10 }],
    ['task_cancel', { taskId: 'tsk_x' }],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    assert.match(text, /^unauthorized:/u, name);
  }
  assert.equal(h.fake.runs.length, 1);
});

test('a session revoked while a delegate is writing its brief records no task', async (t) => {
  let onNewTask: () => void = () => {};
  const h = await makeHarness(t, {
    orchestrator: {
      newTaskId: () => {
        onNewTask();
        return `tsk_${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
      },
    },
  });
  const session = h.session();
  onNewTask = () => h.orchestrator.revokeSession(session.sessionId);
  await assert.rejects(
    h.orchestrator.delegate(session, { runner: 'fake', brief: 'go' }),
    (error: unknown) => error instanceof OrchestratorError && error.code === 'unauthorized',
  );
  assert.equal((await h.store.read()).length, 0);
  assert.equal(h.fake.runs.length, 0);
});
