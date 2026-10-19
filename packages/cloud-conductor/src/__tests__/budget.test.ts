import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FakeRun, TaskView } from '@maka-cloud/orchestrator';
import { calls, lastUserText, refusal, text, tool, toolResults } from './fake-model.js';
import { gate, type Harness, makeHarness } from './harness.js';

const conductorRequests = (h: Harness) =>
  h.model.requests.filter((request) => request.lane === 'conductor');

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
  h.model.script('conductor', startResearch, calls(delegate(7)));
  await h.send('cnv_1', 'Research something big.');
  await h.conductor.idle();

  assert.equal(h.claude.runs.length, 0, 'nothing was delegated');
  assert.equal(conductorRequests(h).length, 2, 'no request while the question is open');
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
      const [refused] = toolResults(request);
      assert.equal(refused?.isError, true);
      assert.match(refusal(refused), /^budget_exceeded: This delegation needs \$7\.00/);
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
  assert.match(h.outbox.answers[0]?.eventId ?? '', /^evt_\w+$/);
  assert.deepEqual(h.outbox.answers[0], {
    eventId: h.outbox.answers[0]?.eventId,
    conversationId: 'cnv_1',
    runId,
    questionId: question.questionId,
    optionId: 'raise',
  });
});

test('"Stop here" ends the run and cancels the tasks it started', async (t) => {
  const h = await makeHarness(t, { autoComplete: false });
  h.model.script('planner', plan);
  h.model.script('conductor', startResearch, calls(delegate(2)), calls(delegate(4)));
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

test('model spend that crosses the budget mid-turn sends no further request and asks', async (t) => {
  const h = await makeHarness(t);
  h.model.script('planner', plan);
  h.model.script(
    'conductor',
    // 300k output tokens at $20 per million: $6, over the $5 budget.
    {
      ...calls(tool('start_playbook', { playbook: 'research', goal: 'g' })),
      usage: { output: 300_000 },
    },
    text('never sent'),
  );
  await h.send('cnv_1', 'Research.');
  await h.conductor.idle();

  assert.equal(h.model.requests.filter((request) => request.lane === 'planner').length, 0);
  assert.equal(h.model.pending('conductor'), 1, 'the request after the crossing was not sent');
  const question = h.outbox.questions[0]!;
  assert.equal(question.reason, 'budget_overrun');
  assert.match(question.question, /used its \$5\.00 budget/);
  assert.equal(h.conductor.state.run(question.runId)?.state, 'waiting');
  const budget = h.conductor.state.budget(question.runId);
  assert.ok(budget.modelUsd >= 6, `model spend metered per call: ${budget.modelUsd}`);
});

test('once the budget is spent no request is sent until the user answers, whatever the model calls', async (t) => {
  const h = await makeHarness(t);
  // notify, task_cancel and a call to a tool that does not exist all went back
  // to the model before; none may buy another request now.
  h.model.script(
    'conductor',
    {
      ...calls(
        tool('notify', { text: 'Working.' }),
        tool('task_cancel', { taskId: 'tsk_none' }),
        tool('no_such_tool', {}),
      ),
      usage: { output: 300_000 },
    },
    calls(tool('notify', { text: 'Still working.' })),
    calls(tool('notify', { text: 'And still.' })),
    calls(tool('notify', { text: 'More.' })),
    calls(tool('notify', { text: 'More again.' })),
  );
  await h.send('cnv_1', 'Research.');
  await h.conductor.idle();
  assert.equal(conductorRequests(h).length, 1, 'no paid request after the budget ran out');
  const question = h.outbox.questions[0]!;
  assert.equal(question.reason, 'budget_overrun');
  assert.equal(h.conductor.state.run(question.runId)?.state, 'waiting');

  // A message sent instead of an answer does not buy a request either.
  await h.send('cnv_1', 'Keep going.');
  await h.conductor.idle();
  assert.equal(conductorRequests(h).length, 1);

  const open = h.conductor.state.openQuestion(question.runId)!;
  assert.equal(open.reason, 'budget_overrun');
  h.model.reset('conductor');
  h.model.script('conductor', text('Back on budget.'));
  assert.deepEqual(await h.answer('cnv_1', open.questionId, 'raise'), {
    accepted: true,
    duplicate: false,
  });
  await h.conductor.idle();
  assert.equal(conductorRequests(h).length, 2, 'the raise lets requests through again');
  assert.equal(h.conductor.state.run(question.runId)?.state, 'done');
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

  // The delegated task ended, so its $3 is charged; $2 is left, minus the
  // model's small spend.
  assert.equal(h.conductor.state.budget(runId).taskUsd, 3);
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
  assert.equal(h.conductor.state.budget(runId).reservedUsd, 1);

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
  assert.equal(budget.reservedUsd, 0);
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

test('a delegation carries its budget to the runner; crossing it cancels the task and the run is charged the real cost', async (t) => {
  const h = await makeHarness(t, { autoComplete: false });
  const started = gate<FakeRun>();
  const realStart = h.claude.start.bind(h.claude);
  h.claude.start = async (spec) => {
    const run = (await realStart(spec)) as FakeRun;
    started.open(run);
    return run;
  };
  h.model.script('planner', plan);
  h.model.script(
    'conductor',
    startResearch,
    calls(delegate(1, { mode: 'wait', timeoutMs: 600_000 })),
  );
  await h.send('cnv_1', 'Research.');
  const run = await started.promise;
  assert.equal(run.spec.budgetUsd, 1, 'the runner is given the delegation budget');
  // The runner reports what the CLI says it spent so far; $1.30 crosses the $1 cap.
  run.usage(0.4);
  run.usage(1.3);
  await h.conductor.idle();
  await h.orchestrator.settled();

  assert.equal(run.cancelled, true, 'crossing the cap cancels the task');
  assert.equal(h.orchestrator.stats().activeTasks, 0);
  const runId = h.conductor.state.runsInState('waiting')[0]?.runId;
  assert.ok(runId, 'the run waits for the user');
  const budget = h.conductor.state.budget(runId);
  assert.equal(budget.reservedUsd, 0, 'the reservation is settled');
  assert.equal(
    budget.taskUsd,
    1.3,
    'the ledger shows what the task really spent, not the $1 reserved',
  );
  // Spending past a reservation is a violation: nothing more is spent until the user decides.
  const question = h.outbox.questions.at(-1);
  assert.equal(question?.reason, 'budget_overrun');
  assert.match(question?.question ?? '', /\$1\.30/);
  assert.equal(h.model.pending('conductor'), 0);
});

test('a settlement above its reservation charges the full amount, flags it, and blocks spend until the user raises the budget', async (t) => {
  const h = await makeHarness(t);
  h.model.script(
    'conductor',
    calls(
      tool('ask_user', {
        reason: 'taste',
        question: 'A or B?',
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
        recommended: 'a',
      }),
    ),
  );
  await h.send('cnv_1', 'Choose.');
  await h.conductor.idle();
  const runId = h.outbox.questions[0]!.runId;

  assert.equal(h.conductor.reserveSpend('verify:1', 'cnv_1', undefined, 1).ok, true);
  const settled = h.conductor.settleSpend('verify:1', 1.5);
  assert.equal(settled.ok, true);
  assert.equal(settled.ok && settled.overrunUsd, 0.5, 'the overrun is flagged');
  const budget = h.conductor.state.budget(runId);
  assert.equal(budget.externalUsd, 1.5, 'the ledger keeps the true amount');
  assert.equal(budget.reservedUsd, 0);
  assert.ok(budget.remainingUsd > 3, 'money is left, but spend is blocked');
  assert.equal(h.conductor.reserveSpend('verify:2', 'cnv_1', undefined, 0.1).ok, false);

  // The next message sends nothing and asks about the budget instead.
  const before = conductorRequests(h).length;
  await h.send('cnv_1', 'Go on with A.');
  await h.conductor.idle();
  assert.equal(conductorRequests(h).length, before, 'no model request while spend is blocked');
  const question = h.outbox.questions.at(-1)!;
  assert.equal(question.reason, 'budget_overrun');

  h.model.script('conductor', text('Went with A.'));
  await h.answer('cnv_1', question.questionId, 'raise');
  await h.conductor.idle();
  assert.equal(conductorRequests(h).length, before + 1);
  assert.equal(h.conductor.state.run(runId)?.state, 'done');
});

test('a task that ended while its run may still be going keeps its reservation until the stop is confirmed', async (t) => {
  const h = await makeHarness(t, {
    autoComplete: false,
    orchestrator: { stopRetry: { firstMs: 1, maxMs: 1 } },
    conductor: { limits: { stopCheckMs: 5 } },
  });
  // The sandbox cannot be reached: the cancel fails, and so does a stop by id until it can.
  let reachable = false;
  h.claude.stopOrphaned = async () => {
    if (!reachable) throw new Error('sandbox unreachable');
  };
  const realStart = h.claude.start.bind(h.claude);
  h.claude.start = async (spec) => {
    const run = (await realStart(spec)) as FakeRun;
    run.cancel = async () => {
      throw new Error('sandbox unreachable');
    };
    return run;
  };
  const owed = gate();
  const realCancel = h.orchestrator.cancel.bind(h.orchestrator);
  h.orchestrator.cancel = async (session, taskId) => {
    const view = await realCancel(session, taskId);
    if (view.stopPending === true) owed.open();
    return view;
  };
  const settled = gate();
  const realSettle = h.conductor.state.settleDelegation.bind(h.conductor.state);
  h.conductor.state.settleDelegation = (key, actualUsd) => {
    const result = realSettle(key, actualUsd);
    settled.open();
    return result;
  };
  h.model.script('planner', plan);
  h.model.script('conductor', startResearch, calls(delegate(2)), text('Done.'));
  await h.send('cnv_1', 'Research.');
  // The run is over, so its task is cancelled: it ends, but its run is not known to have stopped.
  await owed.promise;
  await h.conductor.idle();
  const [delegation] = h.conductor.state.unsettledDelegations();
  assert.ok(delegation, 'the delegation is not settled');
  assert.equal(
    h.conductor.state.budget(delegation.runId).reservedUsd,
    2,
    'the reservation is held',
  );

  reachable = true;
  await settled.promise;
  assert.deepEqual(h.conductor.state.unsettledDelegations(), []);
  const budget = h.conductor.state.budget(delegation.runId);
  assert.equal(budget.reservedUsd, 0);
  assert.equal(budget.taskUsd, 2, 'no spend was reported, so the whole reservation is charged');
});

test('a delegation keeps its reservation while a task below its task may still run, though its own task stopped', async (t) => {
  const h = await makeHarness(t, {
    autoComplete: false,
    orchestrator: { stopRetry: { firstMs: 1, maxMs: 1 } },
    conductor: { limits: { stopCheckMs: 5 } },
  });
  // The parent's run stops; the child's sandbox cannot be reached until `reachable`.
  let childId = '';
  let reachable = false;
  h.claude.stopOrphaned = async (taskId) => {
    if (taskId === childId && !reachable) throw new Error('sandbox unreachable');
  };
  let starts = 0;
  const realStart = h.claude.start.bind(h.claude);
  h.claude.start = async (spec) => {
    const run = (await realStart(spec)) as FakeRun;
    starts += 1;
    if (starts > 1) {
      run.cancel = async () => {
        throw new Error('sandbox unreachable');
      };
    }
    return run;
  };
  const cancelled = gate();
  const askedAgain = gate();
  let parentViews = 0;
  let firstView: TaskView | undefined;
  const realCancel = h.orchestrator.cancel.bind(h.orchestrator);
  h.orchestrator.cancel = async (session, taskId) => {
    const view = await realCancel(session, taskId);
    if (view.state === 'cancelled') {
      parentViews += 1;
      if (parentViews === 1) {
        firstView = view;
        cancelled.open();
      }
      if (parentViews === 2) askedAgain.open();
    }
    return view;
  };
  const settled = gate();
  const realSettle = h.conductor.state.settleDelegation.bind(h.conductor.state);
  h.conductor.state.settleDelegation = (key, actualUsd) => {
    const result = realSettle(key, actualUsd);
    settled.open();
    return result;
  };
  h.model.script('planner', plan);
  h.model.script('conductor', startResearch, calls(delegate(2)), async () => {
    // The delegated task starts a child before the run ends.
    const [delegation] = h.conductor.state.unsettledDelegations();
    assert.ok(delegation?.taskId);
    const executor = h.orchestrator.authenticate(
      h.orchestrator.issueSession({ parentTaskId: delegation.taskId }).token,
    );
    assert.ok(executor);
    const child = await h.orchestrator.delegate(executor, {
      runner: 'claude-agent-sdk',
      brief: 'child',
    });
    childId = child.taskId;
    return text('Done.');
  });
  await h.send('cnv_1', 'Research.');
  // The run is over, so its task is cancelled. The parent stops; the child does not.
  await cancelled.promise;
  await h.conductor.idle();
  const [delegation] = h.conductor.state.unsettledDelegations();
  assert.ok(delegation, 'the delegation is not settled');
  assert.equal(firstView?.stopPending, undefined, 'the parent itself stopped');
  assert.equal(
    h.conductor.state.budget(delegation.runId).reservedUsd,
    2,
    'the reservation is held',
  );
  // Asked again, the tree still may run: still held.
  await askedAgain.promise;
  await h.conductor.idle();
  assert.equal(h.conductor.state.unsettledDelegations().length, 1);

  reachable = true;
  await settled.promise;
  assert.deepEqual(h.conductor.state.unsettledDelegations(), []);
  assert.equal(h.conductor.state.budget(delegation.runId).reservedUsd, 0);
});

test('a task_status answer keeps the reservation while a task below the delegated one may still run', async (t) => {
  const h = await makeHarness(t, {
    autoComplete: false,
    orchestrator: { stopRetry: { firstMs: 1, maxMs: 1 } },
    conductor: { limits: { stopCheckMs: 5 } },
  });
  // The child's sandbox cannot be reached until `reachable`: its cancel fails, and so does a stop by id.
  let childId = '';
  let reachable = false;
  const childStopTried = gate();
  h.claude.stopOrphaned = async (taskId) => {
    if (taskId !== childId || reachable) return;
    childStopTried.open();
    throw new Error('sandbox unreachable');
  };
  let starts = 0;
  const childStarted = gate();
  const realStart = h.claude.start.bind(h.claude);
  h.claude.start = async (spec) => {
    const run = (await realStart(spec)) as FakeRun;
    starts += 1;
    if (starts > 1) {
      run.cancel = async () => {
        throw new Error('sandbox unreachable');
      };
      childStarted.open();
    }
    return run;
  };
  let settles = 0;
  const settled = gate();
  const realSettle = h.conductor.state.settleDelegation.bind(h.conductor.state);
  h.conductor.state.settleDelegation = (key, actualUsd) => {
    const result = realSettle(key, actualUsd);
    settles += 1;
    settled.open();
    return result;
  };
  let parentId = '';
  // The run ends after the status call, and its task is cancelled; asked twice, it is still held.
  let cancels = 0;
  const askedAgain = gate();
  const realCancel = h.orchestrator.cancel.bind(h.orchestrator);
  h.orchestrator.cancel = async (session, taskId) => {
    const view = await realCancel(session, taskId);
    if (taskId === parentId && ++cancels === 2) askedAgain.open();
    return view;
  };
  let settlesAfterStatus = -1;
  let statusView: Record<string, unknown> | undefined;
  h.model.script('planner', plan);
  h.model.script(
    'conductor',
    startResearch,
    calls(delegate(2)),
    async () => {
      // The delegated task starts a child, then finishes; ending it cancels the child, which fails.
      const [delegation] = h.conductor.state.unsettledDelegations();
      assert.ok(delegation?.taskId);
      parentId = delegation.taskId;
      const executor = h.orchestrator.authenticate(
        h.orchestrator.issueSession({ parentTaskId: parentId }).token,
      );
      assert.ok(executor);
      childId = (
        await h.orchestrator.delegate(executor, { runner: 'claude-agent-sdk', brief: 'c' })
      ).taskId;
      await childStarted.promise;
      await h.claude.runFor(parentId).complete();
      await childStopTried.promise;
      return calls(tool('task_status', { taskId: parentId }));
    },
    (request) => {
      settlesAfterStatus = settles;
      statusView = JSON.parse(toolResults(request)[0]?.text ?? '{}');
      return text('Done.');
    },
  );
  await h.send('cnv_1', 'Research.');
  const first = await Promise.race([
    askedAgain.promise.then(() => 'held'),
    settled.promise.then(() => 'settled'),
  ]);
  assert.equal(first, 'held', 'not settled while the tree may still run');
  assert.equal(statusView?.state, 'succeeded');
  assert.equal(settlesAfterStatus, 0, 'task_status did not settle the delegation');
  assert.equal(h.conductor.state.unsettledDelegations().length, 1);

  reachable = true;
  await settled.promise;
  assert.deepEqual(h.conductor.state.unsettledDelegations(), []);
});

test('a delegation cancelled while its runner is still starting keeps its reservation until the late run is cancelled', async (t) => {
  // The runner cannot stop by id, so nothing is owed: only the start under way can hand back a run.
  const h = await makeHarness(t, {
    autoComplete: false,
    conductor: { limits: { stopCheckMs: 5 } },
  });
  const held = gate();
  const startCalled = gate();
  const realStart = h.claude.start.bind(h.claude);
  let lateRun: FakeRun | undefined;
  h.claude.start = async (spec) => {
    startCalled.open();
    await held.promise;
    lateRun = (await realStart(spec)) as FakeRun;
    return lateRun;
  };
  // Asked again after the cancel, the task is still held.
  const askedAgain = gate();
  let cancelView: TaskView | undefined;
  let cancels = 0;
  const realCancel = h.orchestrator.cancel.bind(h.orchestrator);
  h.orchestrator.cancel = async (session, taskId) => {
    const view = await realCancel(session, taskId);
    cancelView ??= view;
    if (++cancels === 2) askedAgain.open();
    return view;
  };
  const settled = gate();
  const realSettle = h.conductor.state.settleDelegation.bind(h.conductor.state);
  h.conductor.state.settleDelegation = (key, actualUsd) => {
    const result = realSettle(key, actualUsd);
    settled.open();
    return result;
  };
  h.model.script('planner', plan);
  h.model.script('conductor', startResearch, calls(delegate(2)), async () => {
    await startCalled.promise;
    return text('Done.');
  });
  await h.send('cnv_1', 'Research.');
  // The run is over, so its task is cancelled while its runner is still starting.
  const first = await Promise.race([
    askedAgain.promise.then(() => 'held'),
    settled.promise.then(() => 'settled'),
  ]);
  assert.equal(first, 'held', 'not settled while the start may still hand back a run');
  assert.equal(cancelView?.state, 'cancelled');
  assert.equal(cancelView?.stopPending, undefined, 'nothing is owed by id');
  const [delegation] = h.conductor.state.unsettledDelegations();
  assert.ok(delegation, 'the delegation is not settled');
  assert.equal(h.conductor.state.budget(delegation.runId).reservedUsd, 2);

  held.open();
  await settled.promise;
  assert.equal(lateRun?.cancelled, true, 'the late run is cancelled');
  assert.deepEqual(h.conductor.state.unsettledDelegations(), []);
});
