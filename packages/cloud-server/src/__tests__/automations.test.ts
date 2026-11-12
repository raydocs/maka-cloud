import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordingHandler } from './conductor.js';
import { eventually, newConversation, postJson, sleep, startHarness } from './harness.js';

test('postToConversation posts once per key and hands the message to the handler', async (t) => {
  const { handler, messages } = recordingHandler();
  const h = await startHarness(t, { handler });
  const conversationId = await newConversation(h);
  const input = {
    conversationId,
    key: 'automation:aut_1:checks',
    text: 'checks done',
    external: true,
  };
  assert.equal(h.server.postToConversation(input), 'delivered');
  assert.equal(h.server.postToConversation(input), 'delivered');
  await eventually(() => messages.some((m) => m.text === 'checks done'), 'delivered');
  await sleep(100);
  assert.equal(messages.filter((m) => m.text === 'checks done').length, 1);
  assert.equal(h.server.postToConversation({ ...input, conversationId: 'conv_missing' }), 'gone');
});

test('postToConversation does not post for an owner whose invite is revoked', async (t) => {
  const h = await startHarness(t);
  const conversationId = await newConversation(h);
  h.server.invites.revoke(h.inviteId);
  assert.equal(
    h.server.postToConversation({
      conversationId,
      key: 'automation:aut_2:x',
      text: 'x',
      external: false,
    }),
    'gone',
  );
});

test('the automation routes list and cancel only the owner’s waits', async (t) => {
  const waits = new Map<string, Array<{ id: string; state: string }>>();
  const h = await startHarness(t, {
    automations: {
      list: (conversationId) => waits.get(conversationId) ?? [],
      cancel: (conversationId, id) => {
        const wait = waits.get(conversationId)?.find((w) => w.id === id && w.state === 'watching');
        if (!wait) return false;
        wait.state = 'cancelled';
        return true;
      },
    },
  });
  const conversationId = await newConversation(h);
  waits.set(conversationId, [{ id: 'aut_a', state: 'watching' }]);

  const listed = await h.api(`/v1/conversations/${conversationId}/automations`);
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), { automations: [{ id: 'aut_a', state: 'watching' }] });

  const other = h.server.invites.create('other');
  const foreign = await h.api(`/v1/conversations/${conversationId}/automations`, {
    token: other.token,
  });
  assert.equal(foreign.status, 404);
  const foreignCancel = await postJson(
    h,
    `/v1/conversations/${conversationId}/automations/aut_a/cancel`,
    {},
    other.token,
  );
  assert.equal(foreignCancel.status, 404);
  assert.equal(waits.get(conversationId)?.[0]?.state, 'watching');

  const cancelled = await postJson(
    h,
    `/v1/conversations/${conversationId}/automations/aut_a/cancel`,
    {},
  );
  assert.equal(cancelled.status, 200);
  assert.equal(waits.get(conversationId)?.[0]?.state, 'cancelled');
  const again = await postJson(
    h,
    `/v1/conversations/${conversationId}/automations/aut_a/cancel`,
    {},
  );
  assert.equal(again.status, 404);
  const wrongMethod = await postJson(h, `/v1/conversations/${conversationId}/automations`, {});
  assert.equal(wrongMethod.status, 405);
});

test('without automations the routes are unknown', async (t) => {
  const h = await startHarness(t);
  const conversationId = await newConversation(h);
  const res = await h.api(`/v1/conversations/${conversationId}/automations`);
  assert.equal(res.status, 404);
});
