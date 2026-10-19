import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { ConversationHandler } from '../cloud-server.js';
import type { ConductorFeedEvent } from '../conductor-feed.js';
import { MIGRATIONS, openDatabase } from '../db.js';
import type { AnswerOutcome } from '../http.js';
import { newConversation, openStream, postJson, startHarness } from './harness.js';

const question = (
  conversationId: string,
  eventId = 'evt_q1',
): Extract<ConductorFeedEvent, { kind: 'question' }> => ({
  kind: 'question',
  eventId,
  conversationId,
  questionId: 'q_1',
  reason: 'taste',
  question: 'Which tone?',
  options: [
    { id: 'casual', label: 'Casual' },
    { id: 'formal', label: 'Formal' },
  ],
  recommended: 'casual',
});

test('conductor output reaches the conversation feed with the agreed payloads', async (t) => {
  const h = await startHarness(t);
  const conversationId = await newConversation(h);
  const { publisher } = h.server;
  publisher.publish({ kind: 'message', eventId: 'evt_m1', conversationId, text: 'Here it is.' });
  publisher.publish({ kind: 'notice', eventId: 'evt_n1', conversationId, text: 'Working on it.' });
  publisher.publish(question(conversationId));
  publisher.publish({
    kind: 'answered',
    eventId: 'evt_a1',
    conversationId,
    questionId: 'q_1',
    optionId: 'formal',
    text: 'no emoji',
  });

  const stream = await openStream(t, h, `?conversation=${conversationId}`);
  const [, message, notice, asked, answered] = await stream.until(5);
  assert.equal(message?.event, 'message.posted');
  assert.equal(message?.data.role, 'assistant');
  assert.equal(message?.data.text, 'Here it is.');
  assert.equal(notice?.event, 'conductor.notice');
  assert.deepEqual(
    { ...notice?.data, at: 0 },
    { conversationId, noticeId: 'evt_n1', text: 'Working on it.', at: 0 },
  );
  assert.equal(asked?.event, 'conductor.question');
  assert.deepEqual(
    { ...asked?.data, at: 0 },
    {
      conversationId,
      questionId: 'q_1',
      reason: 'taste',
      question: 'Which tone?',
      options: [
        { id: 'casual', label: 'Casual' },
        { id: 'formal', label: 'Formal' },
      ],
      recommended: 'casual',
      at: 0,
    },
  );
  assert.equal(answered?.event, 'conductor.answered');
  assert.deepEqual(
    { ...answered?.data, at: 0 },
    { conversationId, questionId: 'q_1', optionId: 'formal', text: 'no emoji', at: 0 },
  );
  assert.equal(typeof answered?.data.at, 'number');
});

test('publishing an event id again is a no-op; different content under that id is a conflict', async (t) => {
  const h = await startHarness(t);
  const conversationId = await newConversation(h);
  const { publisher } = h.server;
  const first = publisher.publish(question(conversationId));
  assert.equal(first.published && first.duplicate, false);
  assert.deepEqual(publisher.publish(question(conversationId)), {
    published: true,
    duplicate: true,
    feedId: null,
  });
  const message = { kind: 'message', eventId: 'evt_m', conversationId, text: 'Once.' } as const;
  publisher.publish(message);
  assert.equal((publisher.publish(message) as { duplicate: boolean }).duplicate, true);
  assert.deepEqual(publisher.publish({ ...message, text: 'Changed.' }), {
    published: false,
    reason: 'conflict',
  });
  assert.deepEqual(publisher.publish({ ...question(conversationId), question: 'Other?' }), {
    published: false,
    reason: 'conflict',
  });
  assert.deepEqual(publisher.publish(question('cnv_missing', 'evt_other')), {
    published: false,
    reason: 'unknown_conversation',
  });
  // The duplicates left nothing in the feed: the marker comes right after the originals.
  publisher.publish({ kind: 'notice', eventId: 'evt_marker', conversationId, text: 'marker' });
  const stream = await openStream(t, h, `?conversation=${conversationId}`);
  const events = await stream.until(4);
  assert.deepEqual(
    events.map((event) => event.event),
    ['conversation.created', 'conductor.question', 'message.posted', 'conductor.notice'],
  );
});

test('published events survive a restart and replay from their position', async (t) => {
  const h = await startHarness(t);
  const conversationId = await newConversation(h);
  h.server.publisher.publish(question(conversationId));
  await h.restart();
  assert.equal(
    (h.server.publisher.publish(question(conversationId)) as { duplicate: boolean }).duplicate,
    true,
  );
  const stream = await openStream(t, h, `?conversation=${conversationId}&after=1`);
  const [asked] = await stream.until(1);
  assert.equal(asked?.event, 'conductor.question');
  assert.equal(asked?.data.questionId, 'q_1');
});

function answeringHandler(outcome: (answer: unknown) => AnswerOutcome) {
  const answers: unknown[] = [];
  const handler: ConversationHandler = {
    onUserMessage: () => undefined,
    onAnswer: async (answer, conductor) => {
      answers.push({ ...answer, mcpUrl: conductor.mcpUrl });
      return outcome(answer);
    },
  };
  return { handler, answers };
}

test('the answers route passes the answer on and maps every outcome to a status', async (t) => {
  let next: AnswerOutcome = { accepted: true, duplicate: false };
  const { handler, answers } = answeringHandler(() => next);
  const h = await startHarness(t, { handler });
  const conversationId = await newConversation(h);
  const path = `/v1/conversations/${conversationId}/answers`;

  const ok = await postJson(h, path, { questionId: 'q_1', optionId: 'casual', text: 'thanks' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { accepted: true, duplicate: false });
  assert.deepEqual(answers, [
    {
      conversationId,
      questionId: 'q_1',
      optionId: 'casual',
      text: 'thanks',
      mcpUrl: h.server.mcpUrl,
    },
  ]);

  next = { accepted: true, duplicate: true };
  const again = await postJson(h, path, { questionId: 'q_1', optionId: 'casual' });
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { accepted: true, duplicate: true });

  const statuses: Array<[AnswerOutcome, number]> = [
    [{ accepted: false, reason: 'conflict' }, 409],
    [{ accepted: false, reason: 'not_open' }, 409],
    [{ accepted: false, reason: 'closed' }, 409],
    [{ accepted: false, reason: 'not_found' }, 404],
    [{ accepted: false, reason: 'unknown_option' }, 400],
    [{ accepted: false, reason: 'text_too_long' }, 400],
  ];
  for (const [outcome, status] of statuses) {
    next = outcome;
    const res = await postJson(h, path, { questionId: 'q_1', optionId: 'formal' });
    assert.equal(res.status, status, JSON.stringify(outcome));
    assert.deepEqual(await res.json(), { error: (outcome as { reason: string }).reason });
  }

  const called = answers.length;
  for (const body of [
    {},
    { questionId: 'q_1' },
    { questionId: 'q_1', optionId: 'a', text: 'x'.repeat(4001) },
    { questionId: 'q_1', optionId: 'a', extra: true },
  ]) {
    assert.equal((await postJson(h, path, body)).status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal(
    (await postJson(h, '/v1/conversations/cnv_none/answers', { questionId: 'q', optionId: 'a' }))
      .status,
    404,
  );
  assert.equal((await postJson(h, path, { questionId: 'q', optionId: 'a' }, null)).status, 401);
  assert.equal((await h.api(path)).status, 405);
  assert.equal(answers.length, called, 'rejected requests never reach the handler');
});

test('without a handler that takes answers the route is 404, so the web app hides the control', async (t) => {
  const h = await startHarness(t, { handler: { onUserMessage: () => undefined } });
  const conversationId = await newConversation(h);
  const res = await postJson(h, `/v1/conversations/${conversationId}/answers`, {
    questionId: 'q',
    optionId: 'a',
  });
  assert.equal(res.status, 404);
});

test('createHandler gets the publisher, and the handler closes while the orchestrator endpoint is still up', async (t) => {
  const order: string[] = [];
  const h = await startHarness(t, {
    createHandler: ({ publisher }) => ({
      onUserMessage: (message) => {
        publisher.publish({
          kind: 'message',
          eventId: `reply:${message.messageId}`,
          conversationId: message.conversationId,
          text: `echo ${message.text}`,
        });
      },
      close: async () => {
        const res = await fetch(h.server.mcpUrl, { method: 'POST' }).catch(() => undefined);
        order.push(res ? 'mcp up' : 'mcp down');
      },
    }),
  });
  const conversationId = await newConversation(h);
  const stream = await openStream(t, h, `?conversation=${conversationId}`);
  await postJson(h, `/v1/conversations/${conversationId}/messages`, { text: 'hi' });
  const [, user, reply] = await stream.until(3);
  assert.equal(user?.data.role, 'user');
  assert.equal(reply?.data.role, 'assistant');
  assert.equal(reply?.data.text, 'echo hi');
  await h.server.close();
  assert.deepEqual(order, ['mcp up']);
});

test('a createHandler that throws fails the start and leaves the database free', async (t) => {
  const h = await startHarness(t);
  await h.server.close();
  await assert.rejects(
    h.restart({
      createHandler: () => {
        throw new Error('no key');
      },
    }),
    /no key/u,
  );
  await h.restart({ createHandler: undefined });
});

test('a version 1 database is migrated in place and keeps its rows', async (t) => {
  const h = await startHarness(t);
  await h.server.close();
  const path = join(h.dir, 'v1.sqlite');
  const old = new DatabaseSync(path);
  old.exec(MIGRATIONS[0] as string);
  old.exec('PRAGMA user_version = 1');
  old
    .prepare(
      "INSERT INTO conversations (conversation_id, n, session_id, created_at) VALUES ('c', 1, 's1', 1)",
    )
    .run();
  old.close();
  const db = openDatabase(path);
  t.after(() => db.close());
  assert.equal(
    (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    MIGRATIONS.length,
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n, 1);
  db.prepare(
    "INSERT INTO conductor_events (event_id, conversation_id, kind, ref, data, at) VALUES ('e', 'c', 'notice', 'e', '{}', 1)",
  ).run();
  assert.throws(() => db.exec("UPDATE conductor_events SET data = 'x'"), /append-only/u);
  assert.throws(() => db.exec('DELETE FROM conductor_events'), /append-only/u);
});

test('an approval question carries the held call and the model note as separate fields', async (t) => {
  const h = await startHarness(t);
  const conversationId = await newConversation(h);
  h.server.publisher.publish({
    ...question(conversationId, 'evt_irr'),
    reason: 'irreversible',
    question: 'Run delete_account?',
    options: [
      { id: 'reject', label: 'Reject' },
      { id: 'approve', label: 'Approve' },
    ],
    recommended: 'reject',
    note: 'Generate a read-only preview?',
    action: { tool: 'delete_account', args: { accountId: 'a_1' } },
  });
  const stream = await openStream(t, h, `?conversation=${conversationId}`);
  const [, asked] = await stream.until(2);
  assert.equal(asked?.data.question, 'Run delete_account?');
  assert.equal(asked?.data.note, 'Generate a read-only preview?');
  assert.deepEqual(asked?.data.action, { tool: 'delete_account', args: { accountId: 'a_1' } });
});
