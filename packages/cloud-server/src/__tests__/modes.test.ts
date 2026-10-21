import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { ConversationHandler } from '../cloud-server.js';
import { MIGRATIONS } from '../db.js';
import { eventually, newConversation, postJson, startHarness } from './harness.js';

function modeHandler() {
  const seen: Array<{ messageId: string; text: string; mode?: string; external?: boolean }> = [];
  const handler: ConversationHandler = {
    onUserMessage(message) {
      seen.push(message);
    },
  };
  return { handler, seen };
}

const post = (h: Awaited<ReturnType<typeof startHarness>>, id: string, body: object) =>
  postJson(h, `/v1/conversations/${id}/messages`, body);

test('the mode a user picks reaches the handler with its message, and a message without one carries none', async (t) => {
  const { handler, seen } = modeHandler();
  const h = await startHarness(t, { handler });
  const id = await newConversation(h);
  assert.equal((await post(h, id, { text: 'deep one', mode: 'deep' })).status, 202);
  assert.equal((await post(h, id, { text: 'plain one' })).status, 202);
  await eventually(() => seen.length === 2, 'both messages');
  assert.deepEqual(
    seen.map((message) => [message.text, message.mode, message.external]),
    [
      ['deep one', 'deep', false],
      ['plain one', undefined, undefined],
    ],
    'a pick is not an outside text: only a standing duty marks one so',
  );
});

test('a mode that is not one, and anything else in the body, is refused', async (t) => {
  const { handler, seen } = modeHandler();
  const h = await startHarness(t, { handler });
  const id = await newConversation(h);
  for (const body of [
    { text: 'x', mode: 'turbo' },
    { text: 'x', mode: 'DEEP' },
    { text: 'x', mode: 7 },
    { text: 'x', mode: null },
    { text: 'x', mode: 'deep', external: true },
    { text: 'x', mode: 'deep', run: { dutyId: 'd', authority: 'read-only', budgetUsd: 1 } },
  ]) {
    assert.equal((await post(h, id, body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(seen, []);
});

test('a retry of a message keeps the mode it was first sent with', async (t) => {
  const { handler, seen } = modeHandler();
  const h = await startHarness(t, { handler });
  const id = await newConversation(h);
  const first = await post(h, id, { text: 'go', clientMessageId: 'k1', mode: 'quick' });
  const retry = await post(h, id, { text: 'go', clientMessageId: 'k1', mode: 'deep' });
  assert.deepEqual(await retry.json(), await first.json());
  await post(h, id, { text: 'marker', clientMessageId: 'k2' });
  await eventually(() => seen.length >= 2, 'handler calls');
  assert.deepEqual(
    seen.map((message) => [message.text, message.mode]),
    [
      ['go', 'quick'],
      ['marker', undefined],
    ],
  );
});

test('a delivery that is retried still carries the mode', async (t) => {
  const seen: Array<string | undefined> = [];
  let failures = 1;
  const handler: ConversationHandler = {
    onUserMessage(message) {
      seen.push(message.mode);
      if (failures-- > 0) throw new Error('the conductor is restarting');
    },
  };
  const h = await startHarness(t, { handler, delivery: { retryBaseMs: 5 } });
  const id = await newConversation(h);
  await post(h, id, { text: 'go', mode: 'deep' });
  await eventually(() => seen.length === 2, 'the retry');
  assert.deepEqual(seen, ['deep', 'deep']);
});

test('another invite cannot post a message with a mode into a conversation it does not own', async (t) => {
  const { handler, seen } = modeHandler();
  const h = await startHarness(t, { handler });
  const id = await newConversation(h);
  const other = h.server.invites.create('other');
  const refused = await h.api(`/v1/conversations/${id}/messages`, {
    method: 'POST',
    token: other.token,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'mine now', mode: 'deep' }),
  });
  assert.equal(refused.status, 404);
  assert.deepEqual(seen, []);
});

test('a database from before modes opens, and its messages carry no mode', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'modes-migration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const old = new DatabaseSync(join(dir, 'server.sqlite'));
  for (const step of MIGRATIONS.slice(0, 9)) old.exec(step);
  old.exec('PRAGMA user_version = 9');
  old.exec(`
    INSERT INTO conversations (conversation_id, n, title, session_id, created_at, owner)
      VALUES ('cnv_old', 1, 'Old', 'ses_old', 1, NULL);
    INSERT INTO messages (n, message_id, conversation_id, role, text, client_message_id, at)
      VALUES (1, 'msg_old', 'cnv_old', 'user', 'old', NULL, 1);
    INSERT INTO message_meta (message_id, external, run) VALUES ('msg_old', 1, NULL);
    INSERT INTO message_deliveries (message_id, conversation_id, next_attempt_at) VALUES ('msg_old', 'cnv_old', 0);
  `);
  old.close();
  const { handler, seen } = modeHandler();
  const h = await startHarness(t, { dir, handler, delivery: { retryBaseMs: 5 } });
  await eventually(() => seen.length === 1, 'the old message is delivered');
  assert.deepEqual([seen[0]?.mode, seen[0]?.external], [undefined, true]);
  assert.ok(h.server);
});
