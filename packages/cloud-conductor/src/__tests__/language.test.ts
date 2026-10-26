import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkHistory } from '@maka-cloud/conductor-checks';
import { type ModelRequest, text } from './fake-model.js';
import { makeHarness } from './harness.js';

const INSTRUCTION = 'Language: reply in Simplified Chinese unless the person writes in another.';

const systemOf = (request: ModelRequest): string => JSON.stringify(request.body.system ?? '');
const messagesOf = (request: ModelRequest): string => JSON.stringify(request.body.messages);

test('a conversation’s instructions go into its system prompt, the same on every turn, and never into history', async (t) => {
  const asked: string[] = [];
  const h = await makeHarness(t, {
    conductor: {
      conversationInstructions: (conversationId) => {
        asked.push(conversationId);
        return conversationId === 'cnv_zh' ? INSTRUCTION : undefined;
      },
    },
  });
  for (const turn of [1, 2, 3]) {
    h.model.script('conductor', text(`回答 ${turn}。`));
    await h.send('cnv_zh', `问题 ${turn}`);
    await h.conductor.idle();
  }
  h.model.script('conductor', text('Answer.'));
  await h.send('cnv_en', 'Question');
  await h.conductor.idle();

  const conductor = h.model.requests.filter((request) => request.lane === 'conductor');
  const zh = conductor.slice(0, 3);
  const en = conductor.slice(3);
  assert.equal(zh.length, 3);
  assert.equal(en.length, 1);
  for (const request of zh) {
    assert.ok(systemOf(request).includes(INSTRUCTION), 'the instruction is in the system prompt');
    assert.ok(!messagesOf(request).includes(INSTRUCTION), 'and in no message');
  }
  assert.ok(
    !systemOf(en[0] as ModelRequest).includes(INSTRUCTION),
    'another conversation has none',
  );
  // Read once, when the conversation's session is made: later turns reuse that prompt as it is.
  assert.deepEqual(asked, ['cnv_zh', 'cnv_en']);

  const report = checkHistory(zh, h.model.emittedThinking.slice(0, 3), {
    isRequestOnlyBlock: () => false,
  });
  assert.deepEqual(report.contentPrefix.breaks, [], 'no earlier turn is rewritten');
  assert.deepEqual(report.systemChanges, [], 'the system prompt does not change between turns');
  // The first user turn reaches the model as it was sent, with nothing added to it.
  const first = zh[2]?.body.messages[0];
  assert.ok(first && JSON.stringify(first.content).includes('问题 1'));
  assert.ok(!JSON.stringify(first.content).includes('Language:'));
});

const HANT_INSTRUCTION =
  'Language: reply in Traditional Chinese, Taiwan usage, unless the person writes in another.';

test('conversations of Simplified and Traditional Chinese readers each keep their own instruction in the system prompt', async (t) => {
  const h = await makeHarness(t, {
    conductor: {
      conversationInstructions: (conversationId) =>
        conversationId === 'cnv_hant' ? HANT_INSTRUCTION : INSTRUCTION,
    },
  });
  for (const turn of [1, 2]) {
    h.model.script('conductor', text(`回答 ${turn}。`));
    await h.send('cnv_hant', `問題 ${turn}`);
    await h.conductor.idle();
    h.model.script('conductor', text(`回答 ${turn}。`));
    await h.send('cnv_hans', `问题 ${turn}`);
    await h.conductor.idle();
  }
  const conductor = h.model.requests.filter((request) => request.lane === 'conductor');
  assert.equal(conductor.length, 4);
  const hant = [conductor[0], conductor[2]] as ModelRequest[];
  const hans = [conductor[1], conductor[3]] as ModelRequest[];
  for (const request of hant) {
    assert.ok(systemOf(request).includes(HANT_INSTRUCTION));
    assert.ok(!systemOf(request).includes(INSTRUCTION));
    assert.ok(!messagesOf(request).includes(HANT_INSTRUCTION), 'never in a message');
  }
  for (const request of hans) {
    assert.ok(systemOf(request).includes(INSTRUCTION));
    assert.ok(!systemOf(request).includes(HANT_INSTRUCTION));
  }
  for (const requests of [hant, hans]) {
    const report = checkHistory(requests, [], { isRequestOnlyBlock: () => false });
    assert.deepEqual(report.contentPrefix.breaks, [], 'no earlier turn is rewritten');
    assert.deepEqual(report.systemChanges, [], 'the system prompt does not change between turns');
  }
});
