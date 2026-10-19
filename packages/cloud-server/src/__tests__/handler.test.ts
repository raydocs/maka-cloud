import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FakeRunner, RunnerRegistry } from '@maka-cloud/orchestrator';
import type { ConversationHandler } from '../cloud-server.js';
import { conductorSession, recordingHandler } from './conductor.js';
import { eventually, newConversation, postJson, startHarness } from './harness.js';

test('a posted message reaches the handler once, with the text and a way to act as the conversation', async (t) => {
  const { handler, seen, messages } = recordingHandler();
  const h = await startHarness(t, { handler });
  const conversationId = await newConversation(h);
  const res = await postJson(h, `/v1/conversations/${conversationId}/messages`, {
    text: 'find me a flight',
    clientMessageId: 'k1',
  });
  const { messageId } = (await res.json()) as { messageId: string };
  await postJson(h, `/v1/conversations/${conversationId}/messages`, {
    text: 'find me a flight',
    clientMessageId: 'k1',
  });
  // Handler calls follow post order, so a retry that reached the handler would sit before the marker.
  const marker = await postJson(h, `/v1/conversations/${conversationId}/messages`, {
    text: 'marker',
    clientMessageId: 'k2',
  });
  const { messageId: markerId } = (await marker.json()) as { messageId: string };
  await eventually(() => messages.length >= 2, 'handler calls');
  assert.deepEqual(messages, [
    { conversationId, messageId, text: 'find me a flight' },
    { conversationId, messageId: markerId, text: 'marker' },
  ]);
  assert.equal(seen.get(conversationId)?.mcpUrl, h.server.mcpUrl);
});

test('rotating the conductor token keeps the session and stops the old token', async (t) => {
  const { handler, seen } = recordingHandler();
  const h = await startHarness(t, { handler });
  const conversationId = await newConversation(h);
  const first = await conductorSession(h, seen, conversationId);
  const { taskId } = await h.server.orchestrator.delegate(first.session, {
    runner: 'fake',
    brief: 'x',
  });
  const second = await conductorSession(h, seen, conversationId);
  assert.equal(second.session.sessionId, first.session.sessionId);
  assert.notEqual(second.token, first.token);
  assert.equal(h.server.orchestrator.authenticate(first.token), undefined);
  assert.equal(h.server.orchestrator.status(second.session, taskId).taskId, taskId);
});

test('a handler that throws or rejects is reported and does not fail the post', async (t) => {
  const handler: ConversationHandler = {
    onUserMessage: () => {
      throw new Error('conductor is down');
    },
  };
  const h = await startHarness(t, { handler });
  const conversationId = await newConversation(h);
  const res = await postJson(h, `/v1/conversations/${conversationId}/messages`, { text: 'x' });
  assert.equal(res.status, 202);
  await eventually(() => h.warnings.length === 1, 'warning');
  assert.equal(h.warnings[0]?.message, 'The conversation handler failed');
});

test('without a handler a message is stored and nothing else happens', async (t) => {
  const h = await startHarness(t);
  const conversationId = await newConversation(h);
  const res = await postJson(h, `/v1/conversations/${conversationId}/messages`, { text: 'x' });
  assert.equal(res.status, 202);
  assert.deepEqual(h.warnings, []);
});

test('sweepOrphans gets every task id in the log after the restart has ended the orphans', async (t) => {
  const { handler, seen } = recordingHandler();
  const h = await startHarness(t, { handler });
  const conversationId = await newConversation(h);
  const { session } = await conductorSession(h, seen, conversationId);
  const orchestrator = h.server.orchestrator;
  const done = await orchestrator.delegate(session, { runner: 'fake', brief: 'done' });
  const running = await orchestrator.delegate(session, { runner: 'fake', brief: 'running' });
  await eventually(() => h.fake.runs.length === 2, 'runs');
  await h.fake.runFor(done.taskId).complete();
  await orchestrator.wait(session, done.taskId, 2000);

  const calls: string[][] = [];
  let order = '';
  await h.restart({
    sweepOrphans: async (ids) => {
      calls.push([...ids]);
      order += 'sweep ';
      return { stopped: [running.taskId], failed: [] };
    },
  });
  order += 'started';
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.sort(), [done.taskId, running.taskId].sort());
  assert.equal(order, 'sweep started');
  assert.deepEqual(h.warnings, []);
  // The restart ended the orphan before the server came up.
  assert.equal(h.server.orchestrator.status(session, running.taskId).state, 'failed');
});

test('a task whose stop could not be confirmed is swept again and its stop retried after the next start', async (t) => {
  const { handler, seen } = recordingHandler();
  const h = await startHarness(t, { handler });
  const conversationId = await newConversation(h);
  const { session } = await conductorSession(h, seen, conversationId);
  const running = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run');

  const calls: string[][] = [];
  const sweepOrphans = async (ids: Iterable<string>) => {
    calls.push([...ids]);
    return { stopped: [], failed: [] };
  };
  const unreachable = new FakeRunner({
    stopOrphaned: async () => {
      throw new Error('sandbox unreachable');
    },
  });
  await h.restart({ runners: new RunnerRegistry([unreachable]), sweepOrphans });
  const ended = h.server.orchestrator.status(session, running.taskId);
  assert.equal(ended.state, 'failed');
  assert.equal(ended.stopPending, true);
  assert.deepEqual(calls[0], [], 'the task owes a stop, so the sweep does not skip it');

  const reachable = new FakeRunner({ stopOrphaned: async () => {} });
  await h.restart({
    runners: new RunnerRegistry([reachable]),
    sweepOrphans,
    orchestrator: { stopRetry: { firstMs: 1, maxMs: 1 } },
  });
  await eventually(
    () => h.server.orchestrator.status(session, running.taskId).stopPending === undefined,
    'the stop retried and confirmed',
  );
  assert.deepEqual(reachable.orphanStops, [running.taskId]);
  assert.deepEqual(calls[1], [], 'still owed when this start swept');
});

test('a sweep that reports failures or throws is a warning, never a failed start', async (t) => {
  const h = await startHarness(t);
  await h.restart({
    sweepOrphans: async () => ({
      stopped: [],
      failed: [{ machineId: 'mach_a', taskId: 'tsk_a', error: 'sandbox unreachable' }],
    }),
  });
  assert.equal(h.warnings.length, 1);
  assert.equal(h.warnings[0]?.message, 'sweepOrphans could not stop some runners');
  await h.restart({
    sweepOrphans: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(h.warnings.at(-1)?.message, 'sweepOrphans failed');
  assert.equal((await h.api('/v1/conversations')).status, 200);
});

test('the sweep runs before the public API listens', async (t) => {
  const h = await startHarness(t);
  const url = h.server.url;
  await h.server.close();
  let reachable: boolean | undefined;
  const { startCloudServer } = await import('../cloud-server.js');
  const second = await startCloudServer({
    ...h.options,
    port: Number(new URL(url).port),
    sweepOrphans: async () => {
      reachable = await fetch(`${url}/v1/conversations`).then(
        () => true,
        () => false,
      );
      return { stopped: [], failed: [] };
    },
  });
  t.after(() => second.close());
  assert.equal(reachable, false);
});

test('the cli creates, lists and revokes invites while a server runs', async (t) => {
  const h = await startHarness(t);
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args, '--invites', h.options.invitesPath], {
      encoding: 'utf8',
    });
  const created = run('invite', 'create', '--label', 'from cli');
  assert.equal(created.status, 0, created.stderr);
  const token = /token:\s+(\S+)/u.exec(created.stdout)?.[1] ?? '';
  const inviteId = /inviteId:\s+(\S+)/u.exec(created.stdout)?.[1] ?? '';
  assert.match(token, /^mki_inv_/u);
  assert.equal((await h.api('/v1/conversations', { token })).status, 200);
  assert.match(run('invite', 'list').stdout, new RegExp(`${inviteId}\\tactive\\tfrom cli`, 'u'));

  assert.equal(run('invite', 'revoke', inviteId).status, 0);
  assert.equal((await h.api('/v1/conversations', { token })).status, 401);
  assert.match(run('invite', 'list').stdout, new RegExp(`${inviteId}\\trevoked`, 'u'));
  assert.equal(run('invite', 'revoke', inviteId).status, 1);
  assert.equal(run('invite', 'create').status, 2);
});
