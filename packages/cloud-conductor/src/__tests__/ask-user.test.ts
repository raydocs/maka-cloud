import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import type { ConductorToolSpec } from '../tools.js';
import { calls, lastUserText, refusal, text, tool, toolResults } from './fake-model.js';
import { makeHarness } from './harness.js';

const taste = (overrides: Record<string, unknown> = {}) =>
  tool('ask_user', {
    reason: 'taste',
    question: 'Which tone?',
    options: [
      { id: 'formal', label: 'Formal' },
      { id: 'casual', label: 'Casual' },
    ],
    recommended: 'casual',
    ...overrides,
  });

test('a taste question is posted with the recommendation first, ends the turn, and its answer comes back as the next user message', async (t) => {
  const h = await makeHarness(t);
  h.model.script('conductor', calls(taste()));
  await h.send('cnv_1', 'Write a note.');
  await h.conductor.idle();

  assert.equal(h.model.requests.length, 1, 'ask_user ends the turn without another model call');
  const question = h.outbox.questions[0]!;
  assert.equal(question.reason, 'taste');
  assert.deepEqual(
    question.options.map((option) => option.id),
    ['casual', 'formal'],
  );
  assert.equal(h.conductor.state.run(question.runId)?.state, 'waiting');

  h.model.script('conductor', (request) => {
    assert.match(lastUserText(request), /Answer to question q_\w+ \("Which tone\?"\): Formal\./);
    return text('Here is the formal note.');
  });
  assert.deepEqual(await h.answer('cnv_1', question.questionId, 'formal'), {
    accepted: true,
    duplicate: false,
  });
  await h.conductor.idle();
  assert.equal(h.outbox.messages.at(-1)?.text, 'Here is the formal note.');
  assert.equal(h.conductor.state.run(question.runId)?.state, 'done');
});

test('ask_user refuses every case outside taste, budget overrun and irreversible actions', async (t) => {
  const h = await makeHarness(t);
  const seen: string[] = [];
  const record = (request: Parameters<typeof toolResults>[0]) => {
    const [result] = toolResults(request);
    assert.equal(result?.isError, true, result?.text);
    seen.push(refusal(result));
  };
  h.model.script(
    'conductor',
    calls(tool('ask_user', { reason: 'clarification', question: 'What did you mean?' })),
    (request) => {
      record(request);
      return calls(taste({ options: [{ id: 'only', label: 'Only one' }], recommended: 'only' }));
    },
    (request) => {
      record(request);
      return calls(taste({ recommended: 'neither' }));
    },
    (request) => {
      record(request);
      return calls(tool('ask_user', { reason: 'budget_overrun', question: 'More money?' }));
    },
    (request) => {
      record(request);
      return calls(
        tool('ask_user', { reason: 'irreversible', question: 'Delete it?', recommended: 'reject' }),
      );
    },
    (request) => {
      record(request);
      return calls(
        tool('ask_user', {
          reason: 'irreversible',
          question: 'Delete it?',
          actionRef: 'act_made_up',
          recommended: 'reject',
        }),
      );
    },
    (request) => {
      record(request);
      return text('I picked a reasonable reading and continued.');
    },
  );
  await h.send('cnv_1', 'Do something vague.');
  await h.conductor.idle();

  assert.equal(seen.length, 6);
  assert.doesNotMatch(seen[0] ?? '', /^[a-z_]+: /, 'an unknown reason fails schema validation');
  assert.match(seen[0] ?? '', /reason/);
  assert.match(seen[1] ?? '', /^invalid_options:/);
  assert.match(seen[2] ?? '', /^invalid_recommendation:/);
  assert.match(seen[3] ?? '', /^invalid_request: budget_overrun needs estimateUsd/);
  assert.match(seen[4] ?? '', /^invalid_request: irreversible needs the actionRef/);
  assert.match(seen[5] ?? '', /^no_held_action:/);
  assert.equal(h.outbox.questions.length, 0);
  assert.equal(h.conductor.state.runsInState('done').length, 1);
});

test('taste questions are capped per run', async (t) => {
  const h = await makeHarness(t, { conductor: { limits: { maxTasteQuestionsPerRun: 1 } } });
  h.model.script('conductor', calls(taste()));
  await h.send('cnv_1', 'Write a note.');
  await h.conductor.idle();
  const first = h.outbox.questions[0]!;

  h.model.script('conductor', calls(taste({ question: 'And the length?' })), (request) => {
    assert.match(refusal(toolResults(request)[0]), /^taste_limit:/);
    return text('Done, casual and short.');
  });
  await h.answer('cnv_1', first.questionId, 'casual');
  await h.conductor.idle();
  assert.equal(h.outbox.questions.length, 1);
});

test('only one question is open at a time', async (t) => {
  const h = await makeHarness(t);
  h.model.script('planner', text('1. Do it.'));
  h.model.script(
    'conductor',
    calls(tool('start_playbook', { playbook: 'free', goal: 'g' })),
    calls(tool('delegate_task', { runner: 'codex', brief: 'b', budgetUsd: 50 })),
    (request) => {
      assert.match(refusal(toolResults(request)[0]), /^budget_exceeded:/);
      return calls(taste());
    },
    (request) => {
      assert.match(refusal(toolResults(request)[0]), /^question_open:/);
      return text('Waiting for the budget answer.');
    },
  );
  await h.send('cnv_1', 'Do a big thing.');
  await h.conductor.idle();
  assert.deepEqual(
    h.outbox.questions.map((question) => question.reason),
    ['budget_overrun'],
  );
});

test('a message sent instead of an answer dismisses the question and continues the run', async (t) => {
  const h = await makeHarness(t);
  h.model.script('conductor', calls(taste()));
  await h.send('cnv_1', 'Write a note.');
  await h.conductor.idle();
  const question = h.outbox.questions[0]!;

  h.model.script('conductor', (request) => {
    assert.match(lastUserText(request), /Actually make it a poem\./);
    return text('A poem.');
  });
  await h.send('cnv_1', 'Actually make it a poem.');
  await h.conductor.idle();
  assert.equal(h.conductor.state.question(question.questionId)?.state, 'dismissed');
  assert.deepEqual(await h.answer('cnv_1', question.questionId, 'formal'), {
    accepted: false,
    reason: 'not_open',
  });
  assert.equal(h.conductor.state.runsInState('done').length, 1, 'one run across both messages');
});

const published: unknown[] = [];
const publish: ConductorToolSpec = {
  name: 'publish_page',
  description: 'Publish a page to the public web.',
  parameters: z.object({ title: z.string() }),
  irreversible: true,
  impl: async (args) => {
    published.push(args);
    return { published: true };
  },
};

test('an irreversible tool is held until the user approves that exact call, and the approval works once', async (t) => {
  published.length = 0;
  const h = await makeHarness(t, { conductor: { tools: [publish] } });
  let actionRef = '';
  h.model.script('conductor', calls(tool('publish_page', { title: 'Hello' })), (request) => {
    const held = refusal(toolResults(request)[0]);
    const match = /actionRef "(act_\w+)"/.exec(held);
    assert.ok(match, held);
    actionRef = match[1] as string;
    return calls(
      tool('ask_user', {
        reason: 'irreversible',
        question: 'Publish "Hello" publicly?',
        actionRef,
        recommended: 'approve',
      }),
    );
  });
  await h.send('cnv_1', 'Publish my page.');
  await h.conductor.idle();
  assert.deepEqual(published, [], 'nothing ran before the approval');
  const question = h.outbox.questions[0]!;
  assert.equal(question.reason, 'irreversible');
  assert.deepEqual(
    question.options.map((option) => option.id),
    ['approve', 'reject'],
  );

  h.model.script(
    'conductor',
    (request) => {
      assert.match(lastUserText(request), new RegExp(`actionRef "${actionRef}"`));
      // Different arguments do not use the approval.
      return calls(tool('publish_page', { title: 'Other', actionRef }));
    },
    (request) => {
      assert.match(refusal(toolResults(request)[0]), /^not_approved:/);
      return calls(tool('publish_page', { title: 'Hello', actionRef }));
    },
    (request) => {
      const [result] = toolResults(request);
      assert.equal(result?.isError, false, result?.text);
      return calls(tool('publish_page', { title: 'Hello', actionRef }));
    },
    (request) => {
      assert.match(refusal(toolResults(request)[0]), /^not_approved:/, 'an approval is used once');
      return text('Published.');
    },
  );
  await h.answer('cnv_1', question.questionId, 'approve');
  await h.conductor.idle();
  assert.deepEqual(published, [{ title: 'Hello' }]);
});

test('a rejected irreversible action never runs', async (t) => {
  published.length = 0;
  const h = await makeHarness(t, { conductor: { tools: [publish] } });
  let actionRef = '';
  h.model.script('conductor', calls(tool('publish_page', { title: 'Hello' })), (request) => {
    actionRef = /actionRef "(act_\w+)"/.exec(refusal(toolResults(request)[0]))?.[1] ?? '';
    return calls(
      tool('ask_user', {
        reason: 'irreversible',
        question: 'Publish?',
        actionRef,
        recommended: 'reject',
      }),
    );
  });
  await h.send('cnv_1', 'Publish my page.');
  await h.conductor.idle();
  h.model.script(
    'conductor',
    (request) => {
      assert.match(lastUserText(request), /Don't do it\. Do not perform that action\./);
      return calls(tool('publish_page', { title: 'Hello', actionRef }));
    },
    (request) => {
      assert.match(refusal(toolResults(request)[0]), /^not_approved:/);
      return text('Not published.');
    },
  );
  await h.answer('cnv_1', h.outbox.questions[0]!.questionId, 'reject');
  await h.conductor.idle();
  assert.deepEqual(published, []);
});

test("an answer can carry the user's own words, which reach the model with the option", async (t) => {
  const h = await makeHarness(t);
  h.model.script('conductor', calls(taste()));
  await h.send('cnv_1', 'Write a note.');
  await h.conductor.idle();
  const question = h.outbox.questions[0]!;
  h.model.script('conductor', (request) => {
    assert.match(lastUserText(request), /: Casual\.[\s\S]*The user added: "but no emoji"/);
    return text('Casual, no emoji.');
  });
  assert.deepEqual(
    await h.conductor.onAnswer(
      {
        conversationId: 'cnv_1',
        questionId: question.questionId,
        optionId: 'casual',
        text: 'but no emoji',
      },
      h.access('cnv_1'),
    ),
    { accepted: true, duplicate: false },
  );
  await h.conductor.idle();
  assert.equal(h.outbox.answers[0]?.text, 'but no emoji');
  assert.deepEqual(
    await h.conductor.onAnswer(
      {
        conversationId: 'cnv_1',
        questionId: question.questionId,
        optionId: 'casual',
        text: 'x'.repeat(4001),
      },
      h.access('cnv_1'),
    ),
    { accepted: false, reason: 'text_too_long' },
  );
});

const deleted: unknown[] = [];
const deleteAccount: ConductorToolSpec = {
  name: 'delete_account',
  description: 'Delete a customer account.',
  parameters: z.object({ accountId: z.string(), reason: z.string() }),
  irreversible: true,
  impl: async (args) => {
    deleted.push(args);
    return { deleted: true };
  },
};

test('the approval card shows the held call, built by code; the model text is only supplementary', async (t) => {
  deleted.length = 0;
  const h = await makeHarness(t, { conductor: { tools: [deleteAccount] } });
  h.model.script(
    'conductor',
    calls(tool('delete_account', { accountId: 'acc_42', reason: 'closed by owner' })),
    (request) => {
      const actionRef = /actionRef "(act_\w+)"/.exec(refusal(toolResults(request)[0]))?.[1];
      return calls(
        tool('ask_user', {
          reason: 'irreversible',
          // The model describes the call as something harmless.
          question: 'Generate a read-only preview?',
          actionRef,
          recommended: 'approve',
        }),
      );
    },
  );
  await h.send('cnv_1', 'Tidy up my accounts.');
  await h.conductor.idle();
  const question = h.outbox.questions[0]!;
  assert.equal(question.reason, 'irreversible');
  assert.doesNotMatch(question.question, /read-only preview/);
  assert.match(question.question, /delete_account/);
  assert.match(question.question, /cannot be undone/);
  assert.deepEqual(question.action, {
    tool: 'delete_account',
    args: { accountId: 'acc_42', reason: 'closed by owner' },
  });
  assert.equal(question.note, 'Generate a read-only preview?');
  assert.match(question.question, /accountId: "acc_42"/);
  assert.deepEqual(deleted, []);
});

test('an irreversible tool can add code-built details to the approval card, under the held call', async (t) => {
  const h = await makeHarness(t, {
    conductor: {
      tools: [
        {
          ...deleteAccount,
          approvalDetails: async (args: { accountId: string }) =>
            `Account ${args.accountId} has 3 open invoices.`,
        } as ConductorToolSpec,
      ],
    },
  });
  h.model.script(
    'conductor',
    calls(tool('delete_account', { accountId: 'acc_42', reason: 'closed by owner' })),
    (request) => {
      const actionRef = /actionRef "(act_\w+)"/.exec(refusal(toolResults(request)[0]))?.[1];
      return calls(
        tool('ask_user', {
          reason: 'irreversible',
          question: 'Delete it?',
          actionRef,
          recommended: 'approve',
        }),
      );
    },
  );
  await h.send('cnv_1', 'Delete acc_42.');
  await h.conductor.idle();
  const question = h.outbox.questions[0]!;
  assert.match(
    question.question,
    /^Allow delete_account\(accountId: "acc_42", reason: "closed by owner"\)\? It cannot be undone\.\n\nAccount acc_42 has 3 open invoices\.$/,
  );
  assert.equal(question.note, 'Delete it?');
});
