import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newConversation, openStream, postJson, startHarness } from './harness.js';

const routes: Array<{ method: string; path: string; body?: unknown }> = [
  { method: 'GET', path: '/v1/conversations' },
  { method: 'POST', path: '/v1/conversations', body: {} },
  { method: 'POST', path: '/v1/conversations/cnv_x/messages', body: { text: 'hi' } },
  { method: 'GET', path: '/v1/conversations/cnv_x/tasks' },
  { method: 'GET', path: '/v1/events' },
  { method: 'GET', path: '/v1/unknown' },
];

test('every route turns away a missing, malformed, unknown or revoked token with the same 401', async (t) => {
  const h = await startHarness(t);
  const revoked = h.server.invites.create('gone');
  h.server.invites.revoke(revoked.inviteId);
  const real = h.token;
  const tokens: Array<string | null> = [
    null,
    '',
    'nope',
    'mki_',
    'mki_.',
    'mki_inv_unknown.secret',
    `${real.slice(0, real.indexOf('.'))}.wrongsecret`,
    revoked.token,
  ];
  for (const route of routes) {
    for (const token of tokens) {
      const res = await h.api(route.path, {
        method: route.method,
        token,
        ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
      });
      assert.equal(res.status, 401, `${route.method} ${route.path} with ${String(token)}`);
      assert.deepEqual(await res.json(), { error: 'unauthorized' });
      assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    }
  }
});

test('an invite revoked while the server runs stops working on the next request', async (t) => {
  const h = await startHarness(t);
  const second = h.server.invites.create('second');
  assert.equal((await h.api('/v1/conversations', { token: second.token })).status, 200);
  h.server.invites.revoke(second.inviteId);
  assert.equal((await h.api('/v1/conversations', { token: second.token })).status, 401);
  assert.equal((await h.api('/v1/conversations')).status, 200);
});

test('create a conversation, list it, post a message and read the tasks', async (t) => {
  const h = await startHarness(t);
  const created = await postJson(h, '/v1/conversations', { title: 'Research' });
  assert.equal(created.status, 201);
  const { conversationId } = (await created.json()) as { conversationId: string };
  assert.match(conversationId, /^cnv_/u);

  const list = await h.api('/v1/conversations');
  const body = (await list.json()) as { conversations: Array<Record<string, unknown>> };
  assert.equal(body.conversations.length, 1);
  assert.equal(body.conversations[0]?.conversationId, conversationId);
  assert.equal(body.conversations[0]?.title, 'Research');
  // The orchestrator session behind a conversation never reaches clients.
  assert.ok(!JSON.stringify(body).includes('ses_'));

  const posted = await postJson(h, `/v1/conversations/${conversationId}/messages`, {
    text: 'hello',
  });
  assert.equal(posted.status, 202);
  assert.match(((await posted.json()) as { messageId: string }).messageId, /^msg_/u);

  const tasks = await h.api(`/v1/conversations/${conversationId}/tasks`);
  assert.deepEqual(await tasks.json(), { tasks: [] });
});

test('a retried message with the same client id stores once and returns the first id', async (t) => {
  const h = await startHarness(t);
  const conversationId = await newConversation(h);
  const send = () =>
    postJson(h, `/v1/conversations/${conversationId}/messages`, {
      text: 'once',
      clientMessageId: 'c-1',
    });
  const first = (await (await send()).json()) as { messageId: string };
  const stream = await openStream(t, h);
  const again = (await (await send()).json()) as { messageId: string };
  assert.equal(again.messageId, first.messageId);
  const different = (await (
    await postJson(h, `/v1/conversations/${conversationId}/messages`, {
      text: 'other',
      clientMessageId: 'c-2',
    })
  ).json()) as { messageId: string };
  assert.notEqual(different.messageId, first.messageId);
  // The feed is ordered, so once a later marker message arrives, a retry that emitted
  // something would already have shown up before it.
  await postJson(h, `/v1/conversations/${conversationId}/messages`, {
    text: 'marker',
    clientMessageId: 'c-marker',
  });
  const events = await stream.until(4);
  assert.deepEqual(
    events.map((event) => [event.event, event.data.text]),
    [
      ['conversation.created', undefined],
      ['message.posted', 'once'],
      ['message.posted', 'other'],
      ['message.posted', 'marker'],
    ],
  );
});

test('unknown conversations are 404, bad bodies are 400, big bodies are 413, wrong methods are 405', async (t) => {
  const h = await startHarness(t);
  const conversationId = await newConversation(h);
  const messages = `/v1/conversations/${conversationId}/messages`;
  assert.equal(
    (await postJson(h, '/v1/conversations/cnv_nope/messages', { text: 'x' })).status,
    404,
  );
  assert.equal((await h.api('/v1/conversations/cnv_nope/tasks')).status, 404);
  assert.equal((await h.api('/v1/events?conversation=cnv_nope')).status, 404);

  assert.equal((await postJson(h, messages, { text: '' })).status, 400);
  assert.equal((await postJson(h, messages, { nope: 1 })).status, 400);
  assert.equal((await postJson(h, messages, { text: 'x', extra: 1 })).status, 400);
  assert.equal((await postJson(h, messages, { text: 'é'.repeat(20_000) })).status, 400);
  assert.equal((await h.api(messages, { method: 'POST', body: '{not json' })).status, 400);
  assert.equal((await h.api(messages, { method: 'POST' })).status, 400);
  assert.equal((await postJson(h, messages, { text: 'x'.repeat(70 * 1024) })).status, 413);
  assert.equal((await postJson(h, '/v1/conversations', { title: 'x'.repeat(201) })).status, 400);

  assert.equal((await h.api(messages)).status, 405);
  assert.equal((await h.api('/v1/conversations', { method: 'DELETE' })).status, 405);
  assert.equal((await h.api('/v1/events?after=abc')).status, 400);
  assert.equal((await h.api('/v1/events', { method: 'POST', body: '{}' })).status, 405);
});

test('message posts are limited per invite and the limit comes back with Retry-After', async (t) => {
  const h = await startHarness(t, { http: { messagesPerMinute: 3 } });
  const conversationId = await newConversation(h);
  const path = `/v1/conversations/${conversationId}/messages`;
  for (let i = 0; i < 3; i += 1)
    assert.equal((await postJson(h, path, { text: `m${i}` })).status, 202);
  const refused = await postJson(h, path, { text: 'one too many' });
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('retry-after')) >= 1);
  // Another invite has its own budget, in a conversation of its own; the refused message was not stored.
  const other = h.server.invites.create('other');
  const created = await postJson(h, '/v1/conversations', {}, other.token);
  const { conversationId: theirs } = (await created.json()) as { conversationId: string };
  const theirPath = `/v1/conversations/${theirs}/messages`;
  assert.equal((await postJson(h, theirPath, { text: 'fine' }, other.token)).status, 202);
  const stream = await openStream(t, h, `?conversation=${conversationId}`);
  await stream.until(4);
  assert.equal(stream.events.filter((e) => e.event === 'message.posted').length, 3);
});
