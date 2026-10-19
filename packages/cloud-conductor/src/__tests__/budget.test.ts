import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FakeRun } from '@maka-cloud/orchestrator';
import { calls, lastUserText, refusal, text, tool, toolResults } from './fake-model.js';
import { gate, makeHarness } from './harness.js';

const startResearch = calls(tool('start_playbook', { playbook: 'research', goal: 'g' }));
const plan = text('1. Do the work.');

function delegate(budgetUsd: number, extra: Record<string, unknown> = {}) {
  return tool('delegate_task', {
    runner: 'claude-agent-sdk',
    brief: 'Do the work.',
    budgetUsd,
    ...extra,
  });
}

test('a delegation over the budget is not sent: code asks to raise or stop, and a raise lets it through', async (t) => {
  const h = await makeHarness(t);
  h.model.script('planner', plan);
  h.model.script('conductor', startResearch, calls(delegate(7)), (request) => {
    const [refused] = toolResults(request);
    assert.equal(refused?.isError, true);
    assert.match(refusal(refused), /^budget_exceeded: This delegation needs \$7\.00/);
    return text('The run needs more budget; I asked.');
  });
  await h.send('cnv_1', 'Research something big.');
  await h.conductor.idle();

  assert.equal(h.claude.runs.length, 0, 'nothing was delegated');
  assert.equal(h.outbox.questions.length, 1);
  const question = h.outbox.questions[0]!;
  assert.equal(question.reason, 'budget_overrun');
  assert.equal(question.recommended, 'raise');
  assert.deepEqual(
    question.options.map((option) => option.id),
    ['raise', 'stop'],
  );
  const runId = question.runId;
  assert.equal(h.conductor.state.run(runId)?.state, 'waiting');

  h.model.script(
    'conductor',
    (request) => {
      assert.match(lastUserText(request), /Answer to question q_\w+ .*Raise the budget to \$/);
      assert.match(lastUserText(request), /The run budget is now \$/);
      return calls(delegate(7, { mode: 'wait', timeoutMs: 10_000 }));
    },
    (request) => {
      const [delegated] = toolResults(request);
      assert.equal(delegated?.isError, false, delegated?.text);
      return text('Done.');
    },
  );
  assert.deepEqual(await h.answer('cnv_1', question.questionId, 'raise'), {
    accepted: true,
    duplicate: false,
  });
  await h.conductor.idle();

  assert.equal(h.claude.runs.length, 1);
  const budget = h.conductor.state.budget(runId);
  assert.ok(budget.budgetUsd >= 7 * 1.2, `budget raised to ${budget.budgetUsd}`);
  assert.equal(h.conductor.state.run(runId)?.state, 'done');
  // Answers are idempotent per question: the same one again changes nothing,
  // a different one is a conflict.
  const raised = h.conductor.state.budget(runId).budgetUsd;
  assert.deepEqual(await h.answer('cnv_1', question.questionId, 'raise'), {
    accepted: true,
    duplicate: true,
  });
  assert.deepEqual(await h.answer('cnv_1', question.questionId, 'stop'), {
    accepted: false,
    reason: 'conflict',
  });
  assert.equal(h.conductor.state.budget(runId).budgetUsd, raised);
  assert.equal(h.outbox.answers.length, 1, 'one answered event per question');
  assert.deepEqual(h.outbox.answers[0], {
    conversationId: 'cnv_1',
    runId,
    questionId: question.questionId,
    optionId: 'raise',
  });
});

test('"Stop here" ends the run and cancels the tasks it started', async (t) => {
  const h = await makeHarness(t, { autoComplete: false });
  h.model.script('planner', plan);
  h.model.script(
    'conductor',
    startResearch,
    calls(delegate(2)),
    calls(delegate(4)),
    text('Asked about the budget.'),
  );
  await h.send('cnv_1', 'Research.');
  await h.conductor.idle();
  assert.equal(h.claude.runs.length, 1);
  const run = h.claude.runs[0] as FakeRun;
  const question = h.outbox.questions[0]!;
  assert.equal(question.reason, 'budget_overrun');

  assert.deepEqual(await h.answer('cnv_1', question.questionId, 'stop'), {
    accepted: true,
    duplicate: false,
  });
  await h.conductor.idle();
  assert.equal(h.conductor.state.run(question.runId)?.state, 'cancelled');
  assert.equal(run.cancelled, true, 'the running child task was cancelled');
  assert.equal(h.model.pending('conductor'), 0);
  assert.equal(h.conductor.stats().openClients, 0);
});

test('model spend that crosses the budget mid-turn stops the tools and asks', async (t) => {
  const h = await makeHarness(t);
  h.model.script('planner', plan);
  h.model.script(
    'conductor',
    // 300k output tokens at $20 per million: $6, over the $5 budget.
    {
      ...calls(tool('start_playbook', { playbook: 'research', goal: 'g' })),
      usage: { output: 300_000 },
    },
    (request) => {
      const [refused] = toolResults(request);
      assert.equal(refused?.isError, true);
      assert.match(refusal(refused), /^run_must_stop: A question is waiting for the user\./);
      return text('Out of budget.');
    },
  );
  await h.send('cnv_1', 'Research.');
  await h.conductor.idle();

  assert.equal(h.model.requests.filter((request) => request.lane === 'planner').length, 0);
  const question = h.outbox.questions[0]!;
  assert.equal(question.reason, 'budget_overrun');
  assert.match(question.question, /used its \$5\.00 budget/);
  assert.equal(h.conductor.state.run(question.runId)?.state, 'waiting');
  const budget = h.conductor.state.budget(question.runId);
  assert.ok(budget.modelUsd >= 6, `model spend metered per call: ${budget.modelUsd}`);
});

test('a model that keeps calling tools after it must stop is stopped by force', async (t) => {
  const h = await makeHarness(t);
  h.model.script(
    'conductor',
    { ...calls(tool('task_status', { taskId: 'x' })), usage: { output: 300_000 } },
    calls(tool('task_status', { taskId: 'x' })),
    calls(tool('task_status', { taskId: 'x' })),
    text('never reached'),
  );
  await h.send('cnv_1', 'Research.');
  await h.conductor.idle();
  const [question] = h.outbox.questions;
  assert.equal(question?.reason, 'budget_overrun');
  // Two refusals, then the turn is stopped; the question stays open.
  assert.equal(h.conductor.state.run(question.runId)?.state, 'waiting');
  assert.equal(h.model.pending('conductor'), 2);
  assert.deepEqual(h.conductor.stats().runningTurns, 0);
});

test('two delegations at the budget limit in one step: exactly one is reserved', async (t) => {
  const h = await makeHarness(t, { autoComplete: false });
  // The first delegation is held inside the runner start, after its
  // reservation, until the second delegation has been decided.
  const held = gate();
  const secondStarted = gate<'second delegation started'>();
  const asked = gate<'budget question posted'>();
  let starts = 0;
  const realStart = h.claude.start.bind(h.claude);
  h.claude.start = async (spec) => {
    starts += 1;
    if (starts === 2) secondStarted.open('second delegation started');
    if (starts === 1) await held.promise;
    return realStart(spec);
  };
  const realQuestion = h.outbox.question.bind(h.outbox);
  h.outbox.question = (question) => {
    realQuestion(question);
    asked.open('budget question posted');
  };
  h.model.script('planner', plan);
  h.model.script('conductor', startResearch, calls(delegate(3), delegate(3)), (request) => {
    const results = toolResults(request);
    assert.equal(results.length, 2);
    assert.equal(results.filter((result) => !result.isError).length, 1);
    assert.match(refusal(results.find((result) => result.isError)), /^budget_exceeded/);
    return text('One delegated, one refused.');
  });
  await h.send('cnv_1', 'Research.');
  const first = await Promise.race([asked.promise, secondStarted.promise]);
  assert.equal(
    first,
    'budget question posted',
    'the second delegation must be refused, not started',
  );
  held.open();
  await h.conductor.idle();
  assert.equal(h.claude.runs.length, 1);
  const runId = h.outbox.questions[0]!.runId;
  assert.equal(h.conductor.state.budget(runId).reservedUsd, 3);
});

test('budget_overrun from the model needs an estimate over what is left', async (t) => {
  const h = await makeHarness(t);
  h.model.script(
    'conductor',
    calls(tool('ask_user', { reason: 'budget_overrun', question: 'More?', estimateUsd: 2 })),
    (request) => {
      const [refused] = toolResults(request);
      assert.match(refusal(refused), /^within_budget:/);
      return calls(
        tool('ask_user', {
          reason: 'budget_overrun',
          question: 'This needs about $9.',
          estimateUsd: 9,
        }),
      );
    },
    text('Asked.'),
  );
  await h.send('cnv_1', 'Research.');
  await h.conductor.idle();
  const question = h.outbox.questions[0]!;
  assert.equal(question.reason, 'budget_overrun');
  assert.equal(question.question, 'This needs about $9.');
  assert.equal(question.options[0]?.id, 'raise');
  assert.match(question.options[0]?.label ?? '', /\$10\.8/);
});

test('spend reserved by a caller outside the conductor shares the run budget, settles once, and works after the turn ended', async (t) => {
  const h = await makeHarness(t);
  h.model.script('planner', plan);
  h.model.script('conductor', startResearch, calls(delegate(3)), text('Delegated.'));
  await h.send('cnv_1', 'Research.');
  await h.conductor.idle();
  const [taskId] = h.conductor.state.tasksOf(h.conductor.state.runsInState('done')[0]!.runId);
  assert.ok(taskId);
  const runId = h.conductor.state.runsInState('done')[0]!.runId;

  // $3 is reserved by the delegation; $2 is left, minus the model's small spend.
  const over = h.conductor.reserveSpend('verify:1', 'cnv_1', taskId, 2);
  assert.equal(over.ok, false);
  assert.equal(over.ok === false && over.reason, 'budget', 'a budget refusal is distinguishable');

  const reserved = h.conductor.reserveSpend('verify:2', 'cnv_1', taskId, 1);
  assert.equal(reserved.ok, true);
  assert.equal(
    reserved.ok && reserved.charge.runId,
    runId,
    'charged to the run that delegated the task',
  );
  assert.deepEqual(h.conductor.reserveSpend('verify:2', 'cnv_1', taskId, 1), {
    ...reserved,
    duplicate: true,
  });
  assert.deepEqual(h.conductor.reserveSpend('verify:2', 'cnv_1', taskId, 0.5), {
    ok: false,
    reason: 'conflict',
  });
  assert.equal(h.conductor.state.budget(runId).reservedUsd, 4);

  const settled = h.conductor.settleSpend('verify:2', 0.25);
  assert.equal(settled.ok && settled.charge.state, 'settled');
  assert.equal(
    h.conductor.settleSpend('verify:2', 0.25).ok,
    true,
    'the same settlement again is a no-op',
  );
  assert.deepEqual(h.conductor.settleSpend('verify:2', 0.5), { ok: false, reason: 'conflict' });
  assert.deepEqual(h.conductor.settleSpend('verify:unknown', 0.5), {
    ok: false,
    reason: 'not_found',
  });
  const budget = h.conductor.state.budget(runId);
  assert.equal(budget.reservedUsd, 3);
  assert.equal(budget.externalUsd, 0.25);

  assert.deepEqual(h.conductor.reserveSpend('verify:3', 'cnv_none', undefined, 1), {
    ok: false,
    reason: 'no_run',
  });
  assert.deepEqual(h.conductor.reserveSpend('verify:4', 'cnv_1', undefined, -1), {
    ok: false,
    reason: 'invalid_amount',
  });
});

test('an external reservation and a delegation at the limit cannot both pass', async (t) => {
  const h = await makeHarness(t, { autoComplete: false });
  h.model.script('planner', plan);
  h.model.script(
    'conductor',
    startResearch,
    (request) => {
      // Between steps, a caller outside the conductor takes $4 of the $5.
      const reserved = h.conductor.reserveSpend('verify:race', 'cnv_1', undefined, 4);
      assert.equal(reserved.ok, true);
      return calls(delegate(3));
    },
    (request) => {
      assert.match(refusal(toolResults(request)[0]), /^budget_exceeded/);
      return text('Asked.');
    },
  );
  await h.send('cnv_1', 'Research.');
  await h.conductor.idle();
  assert.equal(h.claude.runs.length, 0);
  assert.equal(h.outbox.questions[0]?.reason, 'budget_overrun');
});
