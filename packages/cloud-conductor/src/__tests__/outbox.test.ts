import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OutboxAnswered, OutboxMessage } from '../outbox.js';
import { calls, text, tool } from './fake-model.js';
import { gate, makeHarness } from './harness.js';

const taste = tool('ask_user', {
  reason: 'taste',
  question: 'A or B?',
  options: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ],
  recommended: 'a',
});

test('an answered event that fails to send is sent again, with the same event id, until it is acked', {
  timeout: 20_000,
}, async (t) => {
  const h = await makeHarness(t, { conductor: { limits: { outboxRetryMs: 5 } } });
  h.model.script('conductor', calls(taste));
  await h.send('cnv_1', 'Choose.');
  await h.conductor.idle();
  const question = h.outbox.questions[0]!;

  const attempts: OutboxAnswered[] = [];
  const delivered = gate<OutboxAnswered>();
  h.outbox.answered = (answered) => {
    attempts.push(answered);
    if (attempts.length < 3) throw new Error('feed unavailable');
    h.outbox.answers.push(answered);
    delivered.open(answered);
  };
  h.model.script('conductor', text('A it is.'));
  assert.deepEqual(await h.answer('cnv_1', question.questionId, 'a'), {
    accepted: true,
    duplicate: false,
  });
  const sent = await delivered.promise;
  assert.equal(attempts.length, 3);
  assert.ok(sent.eventId, 'every event has an id');
  assert.ok(
    attempts.every((attempt) => attempt.eventId === sent.eventId),
    'the id is stable',
  );
  await h.conductor.idle();
  assert.equal(h.outbox.answers.length, 1);
});

test('a final message that is not delivered does not mark the run done; it is sent again after a restart', {
  timeout: 20_000,
}, async (t) => {
  const h = await makeHarness(t, { conductor: { limits: { outboxRetryMs: 60_000 } } });
  const attempts: OutboxMessage[] = [];
  const failed = gate();
  const deliver = h.outbox.message.bind(h.outbox);
  h.outbox.message = (message) => {
    attempts.push(message);
    failed.open();
    throw new Error('feed unavailable');
  };
  h.model.script('conductor', text('Here is your answer.'));
  await h.send('cnv_1', 'Question.');
  await h.conductor.idle();
  await failed.promise;
  assert.equal(h.conductor.state.runsInState('done').length, 0, 'not done before it is delivered');
  const [delivering] = h.conductor.state.runsInState('delivering');
  assert.ok(delivering, 'the run waits for its delivery');

  // The process stops before the retry; the next one sends the same event.
  const received = gate<OutboxMessage>();
  h.outbox.message = (message) => {
    deliver(message);
    received.open(message);
  };
  const reopened = await h.restart();
  const message = await received.promise;
  assert.equal(message.text, 'Here is your answer.');
  assert.equal(message.eventId, attempts[0]?.eventId);
  await reopened.idle();
  assert.equal(reopened.state.run(delivering.runId)?.state, 'done');
  assert.equal(reopened.state.run(delivering.runId)?.endReason, 'delivered');
  assert.equal(h.outbox.messages.length, 1);
});

test('events of one conversation are delivered in order, and a stuck conversation does not hold up another', {
  timeout: 20_000,
}, async (t) => {
  const h = await makeHarness(t, { conductor: { limits: { outboxRetryMs: 60_000 } } });
  const deliver = h.outbox.message.bind(h.outbox);
  h.outbox.message = (message) => {
    if (message.conversationId === 'cnv_stuck') throw new Error('feed unavailable');
    deliver(message);
  };
  h.model.script('conductor', text('Stuck answer.'));
  await h.send('cnv_stuck', 'One.');
  await h.conductor.idle();
  h.model.script('conductor', text('Other answer.'));
  await h.send('cnv_other', 'Two.');
  await h.conductor.idle();
  assert.deepEqual(
    h.outbox.messages.map((message) => message.text),
    ['Other answer.'],
  );
  assert.equal(h.conductor.state.runsInState('done').length, 1);
});
