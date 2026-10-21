import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FakeRun } from '@maka-cloud/orchestrator';
import { z } from 'zod';
import type { Conductor, ConductorOptions } from '../conductor.js';
import type { ConductorToolSpec } from '../tools.js';
import {
  calls,
  lastUserText,
  type ModelRequest,
  type Reply,
  refusal,
  type Step,
  text,
  tool,
  toolResults,
} from './fake-model.js';
import { gate, type Harness, makeHarness } from './harness.js';

/** Everything a turn holds is given back. */
function assertReleased(conductor: Conductor): void {
  assert.deepEqual(conductor.stats(), {
    runningTurns: 0,
    waitingForSlot: 0,
    queued: 0,
    planners: 0,
    timers: 0,
    openClients: 0,
    outboxSending: 0,
    outboxRetrying: 0,
    stopChecks: 0,
  });
}

/** A model step that tells the test it started and answers only when released. */
function heldStep(reply: Reply = text('released')) {
  const started = gate();
  const release = gate();
  const step: Step = async () => {
    started.open();
    await release.promise;
    return reply;
  };
  return { step, started: started.promise, release: () => release.open() };
}

const conductorRequests = (h: Harness) =>
  h.model.requests.filter((request) => request.lane === 'conductor');

async function startedTaskTurn(h: Harness) {
  // A run with a running child task and an unfinished model call.
  const held = heldStep();
  h.model.script('planner', text('1. Do it.'));
  h.model.script(
    'conductor',
    calls(tool('start_playbook', { playbook: 'free', goal: 'g' })),
    calls(tool('delegate_task', { runner: 'codex', brief: 'b', budgetUsd: 1 })),
    held.step,
  );
  await h.send('cnv_1', 'Go.');
  await held.started;
  t_assertRunning(h);
  return held;
}

function t_assertRunning(h: Harness): void {
  assert.equal(h.conductor.stats().runningTurns, 1);
  assert.equal(h.codex.runs.length, 1);
}

test('exit by user stop during a model call: the turn, its client and its tasks are released', async (t) => {
  const h = await makeHarness(t, { autoComplete: false });
  const held = await startedTaskTurn(h);
  assert.equal(h.conductor.stats().openClients, 1);
  assert.equal(await h.conductor.stop('cnv_1'), true);
  await h.conductor.idle();
  held.release();
  const [run] = h.conductor.state.runsInState('cancelled');
  assert.equal(run?.endReason, 'user_stop');
  assert.equal(h.codex.runs[0]?.cancelled, true);
  assertReleased(h.conductor);
  assert.equal(h.outbox.messages.length, 0);
});

test('exit by user stop during planning: the planner session is stopped too', async (t) => {
  const h = await makeHarness(t);
  const held = heldStep(text('a plan'));
  h.model.script('planner', held.step);
  h.model.script('conductor', calls(tool('start_playbook', { playbook: 'research', goal: 'g' })));
  await h.send('cnv_1', 'Go.');
  await held.started;
  assert.equal(h.conductor.stats().planners, 1);
  await h.conductor.stop('cnv_1');
  await h.conductor.idle();
  held.release();
  assert.equal(h.conductor.state.runsInState('cancelled').length, 1);
  assert.equal(conductorRequests(h).length, 1, 'the conductor got no tool result back');
  assertReleased(h.conductor);
});

test('exit by shutdown during a blocking task_wait: the run is interrupted and everything released', async (t) => {
  const h = await makeHarness(t, { autoComplete: false });
  const waiting = gate();
  h.model.script('planner', text('1. Do it.'));
  h.model.script(
    'conductor',
    calls(tool('start_playbook', { playbook: 'free', goal: 'g' })),
    calls(tool('delegate_task', { runner: 'codex', brief: 'b', budgetUsd: 1 })),
    (request) => {
      const taskId = (toolResults(request)[0]?.json?.task as { taskId: string } | undefined)
        ?.taskId;
      setImmediate(() => waiting.open());
      return calls(tool('task_wait', { taskId, timeoutMs: 600_000 }));
    },
  );
  await h.send('cnv_1', 'Go.');
  await waiting.promise;
  // The wait is inside the orchestrator once its blocking-wait slot is taken.
  while (h.orchestrator.stats().sessionsWaiting === 0)
    await new Promise((resolve) => setImmediate(resolve));
  await h.conductor.close();
  assert.equal(h.conductor.state.db.isOpen, false);
  assertReleased(h.conductor);
  const reopened = await h.restart();
  assert.equal(reopened.state.runsInState('interrupted')[0]?.endReason, 'shutdown');
});

test('exit by timeout: the turn is stopped, the run fails with a notice, its tasks are cancelled', async (t) => {
  // The timeout fires once the model call is under way, not at a wall-clock guess.
  const timeouts: Array<() => void> = [];
  const h = await makeHarness(t, {
    autoComplete: false,
    conductor: { hooks: { turnTimer: (fire) => timeouts.push(fire) } },
  });
  const held = await startedTaskTurn(h);
  assert.equal(timeouts.length, 1);
  timeouts[0]!();
  await h.conductor.idle();
  held.release();
  const [run] = h.conductor.state.runsInState('failed');
  assert.equal(run?.endReason, 'timeout');
  assert.match(h.outbox.notices.at(-1)?.text ?? '', /took longer than/);
  assert.equal(h.codex.runs[0]?.cancelled, true);
  assertReleased(h.conductor);
});

test('exit by planner timeout: the planner is stopped and the conductor carries on', async (t) => {
  const h = await makeHarness(t, { conductor: { limits: { plannerTimeoutMs: 300 } } });
  const held = heldStep(text('late plan'));
  h.model.script('planner', held.step);
  h.model.script(
    'conductor',
    calls(tool('start_playbook', { playbook: 'research', goal: 'g' })),
    (request) => {
      assert.match(refusal(toolResults(request)[0]), /^planner_timeout:/);
      return text('Planned it myself.');
    },
  );
  await h.send('cnv_1', 'Go.');
  await h.conductor.idle();
  held.release();
  assert.equal(h.outbox.messages.at(-1)?.text, 'Planned it myself.');
  assertReleased(h.conductor);
});

test('exit by a model error: the run fails with a notice and everything is released', async (t) => {
  const h = await makeHarness(t, { autoComplete: false });
  h.model.script('planner', text('1. Do it.'));
  h.model.script(
    'conductor',
    calls(tool('start_playbook', { playbook: 'free', goal: 'g' })),
    calls(tool('delegate_task', { runner: 'codex', brief: 'b', budgetUsd: 1 })),
    {
      error: {
        status: 400,
        body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } },
      },
    },
  );
  await h.send('cnv_1', 'Go.');
  await h.conductor.idle();
  assert.equal(h.conductor.state.runsInState('failed')[0]?.endReason, 'model_error');
  assert.match(h.outbox.notices.at(-1)?.text ?? '', /The run failed: .*bad request/);
  assert.equal(h.codex.runs[0]?.cancelled, true);
  assertReleased(h.conductor);
});

test('exit by a throw before the turn is sent: the run fails and everything is released', async (t) => {
  const h = await makeHarness(t, {
    conductor: {
      hooks: {
        beforeSend: async () => {
          throw new Error('injected');
        },
      },
    },
  });
  await h.send('cnv_1', 'Go.');
  await h.conductor.idle();
  assert.equal(h.conductor.state.runsInState('failed')[0]?.endReason, 'model_error');
  assert.equal(conductorRequests(h).length, 0);
  assertReleased(h.conductor);
});

const failing: ConductorToolSpec = {
  name: 'flaky_lookup',
  description: 'Looks something up.',
  parameters: z.object({ q: z.string() }),
  effects: [],
  impl: async () => {
    throw new Error('lookup broke');
  },
};

test('a tool that throws fails only that call', async (t) => {
  const h = await makeHarness(t, { conductor: { tools: [failing] } });
  h.model.script('conductor', calls(tool('flaky_lookup', { q: 'x' })), (request) => {
    assert.match(refusal(toolResults(request)[0]), /lookup broke/);
    return text('Worked around it.');
  });
  await h.send('cnv_1', 'Go.');
  await h.conductor.idle();
  assert.equal(h.conductor.state.runsInState('done').length, 1);
  assertReleased(h.conductor);
});

test('exit by restart: an active run is ended as interrupted, a waiting question survives and its answer continues the session', async (t) => {
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
  await h.send('cnv_waiting', 'Choose for me later.');
  await h.conductor.idle();
  const question = h.outbox.questions[0]!;
  // A crash right after a message was admitted, before its turn ran.
  h.conductor.state.admitMessage('cnv_crashed', 'msg_crashed', 5);
  const conductor = await h.restart();

  const [interrupted] = conductor.state.runsInState('interrupted');
  assert.equal(interrupted?.conversationId, 'cnv_crashed');
  assert.equal(interrupted?.endReason, 'restart');
  assert.match(h.outbox.notices.at(-1)?.text ?? '', /interrupted by a restart/);
  assert.equal(conductor.state.run(question.runId)?.state, 'waiting');

  const before = conductorRequests(h).at(-1) as ModelRequest;
  h.model.script('conductor', (request) => {
    assert.ok(request.body.messages.length > before.body.messages.length);
    assert.ok(request.raw.includes('Choose for me later.'), 'same Maka session, history kept');
    return text('Went with B.');
  });
  assert.deepEqual(await h.answer('cnv_waiting', question.questionId, 'b'), {
    accepted: true,
    duplicate: false,
  });
  await conductor.idle();
  assert.equal(h.outbox.messages.at(-1)?.text, 'Went with B.');
  assertReleased(conductor);
});

test('race: a stop after the turn registered but before it was sent sends nothing', async (t) => {
  const registered = gate();
  const proceed = gate();
  const h = await makeHarness(t, {
    conductor: {
      hooks: {
        beforeSend: async () => {
          registered.open();
          await proceed.promise;
        },
      },
    },
  });
  await h.send('cnv_1', 'Go.');
  await registered.promise;
  assert.equal(await h.conductor.stop('cnv_1'), true);
  proceed.open();
  await h.conductor.idle();
  assert.equal(conductorRequests(h).length, 0);
  assert.equal(h.conductor.state.runsInState('cancelled').length, 1);
  assertReleased(h.conductor);
});

test('race: a stop while the turn waits for a slot: it never runs and the slot passes on', async (t) => {
  const h = await makeHarness(t, { conductor: { limits: { maxConcurrentRuns: 1 } } });
  const held = heldStep(text('A done.'));
  h.model.script('conductor', held.step);
  await h.send('cnv_a', 'A.');
  await held.started;
  await h.send('cnv_b', 'B.');
  assert.equal(h.conductor.stats().waitingForSlot, 1);
  assert.equal(await h.conductor.stop('cnv_b'), true);
  held.release();
  await h.conductor.idle();
  assert.equal(conductorRequests(h).length, 1, 'B never reached the model');
  assert.deepEqual(
    h.outbox.messages.map((message) => message.text),
    ['A done.'],
  );
  assertReleased(h.conductor);
});

test('close while a turn waits for a slot releases the waiter', async (t) => {
  const h = await makeHarness(t, { conductor: { limits: { maxConcurrentRuns: 1 } } });
  const held = heldStep();
  h.model.script('conductor', held.step);
  await h.send('cnv_a', 'A.');
  await held.started;
  await h.send('cnv_b', 'B.');
  assert.equal(h.conductor.stats().waitingForSlot, 1);
  await h.conductor.close();
  held.release();
  assertReleased(h.conductor);
});

test('a message during a run waits its turn and joins the same run; the queue is capped', async (t) => {
  const h = await makeHarness(t, { conductor: { limits: { maxQueuedPerConversation: 1 } } });
  const held = heldStep(text('First.'));
  h.model.script('conductor', held.step, (request: ModelRequest) => {
    assert.ok(request.raw.includes('First.'), 'the second turn sees the first answer');
    return text('Second.');
  });
  await h.send('cnv_1', 'One.');
  await held.started;
  await h.send('cnv_1', 'Two.');
  await h.send('cnv_1', 'Three.');
  assert.match(h.outbox.notices.at(-1)?.text ?? '', /Too many messages are waiting/);
  held.release();
  await h.conductor.idle();
  assert.deepEqual(
    h.outbox.messages.map((message) => message.text),
    ['First.', 'Second.'],
  );
  assert.equal(h.conductor.state.runsInState('done').length, 1);
  assertReleased(h.conductor);
});

test('a message sent while the turn asks a question stands in for the answer', async (t) => {
  const h = await makeHarness(t);
  const held = heldStep(
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
  h.model.script('conductor', held.step, (request: ModelRequest) => {
    assert.match(lastUserText(request), /Use C\./);
    return text('C it is.');
  });
  await h.send('cnv_1', 'Pick one.');
  await held.started;
  await h.send('cnv_1', 'Use C.');
  held.release();
  await h.conductor.idle();
  const question = h.outbox.questions[0]!;
  assert.equal(h.conductor.state.question(question.questionId)?.state, 'dismissed');
  assert.equal(h.outbox.messages.at(-1)?.text, 'C it is.');
  assert.equal(h.conductor.state.run(question.runId)?.state, 'done');
  assertReleased(h.conductor);
});

test('a message delivered twice runs once', async (t) => {
  const h = await makeHarness(t);
  h.model.script('conductor', text('Once.'));
  await h.send('cnv_1', 'Hi.', 'msg_same');
  await h.send('cnv_1', 'Hi.', 'msg_same');
  await h.conductor.idle();
  assert.equal(conductorRequests(h).length, 1);
  assert.equal(h.outbox.messages.length, 1);
});

test('race: an answer followed at once by a stop runs no turn', async (t) => {
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
  const before = conductorRequests(h).length;
  const answered = h.answer('cnv_1', h.outbox.questions[0]!.questionId, 'a');
  const stopped = h.conductor.stop('cnv_1');
  assert.deepEqual(await answered, { accepted: true, duplicate: false });
  assert.equal(await stopped, true);
  await h.conductor.idle();
  assert.equal(conductorRequests(h).length, before);
  assertReleased(h.conductor);
});

/** No task is left running in the orchestrator. */
async function assertNoTasks(h: Harness): Promise<void> {
  await h.orchestrator.settled();
  assert.equal(h.orchestrator.stats().activeTasks, 0, 'no task is left running');
  for (const run of [...h.claude.runs, ...h.codex.runs]) assert.equal(run.cancelled, true);
}

/** Resolves with each task run as its runner starts it. */
function onRunStart(h: Harness) {
  const started = gate<FakeRun>();
  const realStart = h.codex.start.bind(h.codex);
  h.codex.start = async (spec) => {
    const run = (await realStart(spec)) as FakeRun;
    started.open(run);
    return run;
  };
  return started.promise;
}

const delegateFree = (extra: Record<string, unknown> = {}) => [
  calls(tool('start_playbook', { playbook: 'free', goal: 'g' })),
  calls(tool('delegate_task', { runner: 'codex', brief: 'b', budgetUsd: 1, ...extra })),
];

test('a stop while delegate_task waits for its task cancels that task', async (t) => {
  const h = await makeHarness(t, { autoComplete: false });
  const started = onRunStart(h);
  h.model.script('planner', text('1. Do it.'));
  h.model.script('conductor', ...delegateFree({ mode: 'wait', timeoutMs: 600_000 }));
  await h.send('cnv_1', 'Go.');
  await started;
  assert.equal(await h.conductor.stop('cnv_1'), true);
  await h.conductor.idle();
  await assertNoTasks(h);
  assertReleased(h.conductor);
});

test('a stop while the delegation response is lost cancels the task by its idempotency key', async (t) => {
  const h = await makeHarness(t, { autoComplete: false });
  const created = gate();
  const respond = gate();
  const delegate = h.orchestrator.delegate.bind(h.orchestrator);
  h.orchestrator.delegate = async (...args) => {
    const view = await delegate(...args);
    created.open();
    await respond.promise;
    return view;
  };
  h.model.script('planner', text('1. Do it.'));
  h.model.script('conductor', ...delegateFree());
  await h.send('cnv_1', 'Go.');
  await created.promise;
  assert.equal(await h.conductor.stop('cnv_1'), true);
  await h.conductor.idle();
  respond.open();
  await assertNoTasks(h);
  assert.equal(h.orchestrator.stats().activeTasks, 0);
  assertReleased(h.conductor);
});

test('a stop before the delegation reaches the orchestrator: the task is never created', async (t) => {
  const h = await makeHarness(t, { autoComplete: false });
  const arrived = gate();
  const proceed = gate();
  const outcome = gate<string>();
  const delegate = h.orchestrator.delegate.bind(h.orchestrator);
  h.orchestrator.delegate = async (...args) => {
    arrived.open();
    await proceed.promise;
    try {
      const view = await delegate(...args);
      outcome.open('created');
      return view;
    } catch (error) {
      outcome.open(String(error));
      throw error;
    }
  };
  h.model.script('planner', text('1. Do it.'));
  h.model.script('conductor', ...delegateFree());
  await h.send('cnv_1', 'Go.');
  await arrived.promise;
  assert.equal(await h.conductor.stop('cnv_1'), true);
  await h.conductor.idle();
  proceed.open();
  // The held request goes on after the cancel and is refused.
  assert.match(await outcome.promise, /cancelled/);
  assert.equal(h.codex.runs.length, 0);
  await assertNoTasks(h);
  const runId = h.conductor.state.runsInState('cancelled')[0]!.runId;
  assert.equal(
    h.conductor.state.budget(runId).reservedUsd,
    0,
    'nothing ran, so nothing is charged',
  );
});

test('shutdown cancels the tasks of a running turn and of a run waiting for an answer', async (t) => {
  const h = await makeHarness(t, { autoComplete: false });
  // cnv_wait delegated a task, then asked a question and waits.
  h.model.script('planner', text('1. Do it.'), text('1. Do it.'));
  h.model.script(
    'conductor',
    ...delegateFree(),
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
  await h.send('cnv_wait', 'Go.');
  await h.conductor.idle();
  assert.equal(h.conductor.state.runsInState('waiting').length, 1);
  assert.equal(h.codex.runs.length, 1);
  // cnv_run has a task running and a model call in flight.
  const held = heldStep();
  h.model.script('conductor', ...delegateFree(), held.step);
  await h.send('cnv_run', 'Go.');
  await held.started;
  assert.equal(h.codex.runs.length, 2);

  await h.conductor.close();
  held.release();
  await assertNoTasks(h);
  assertReleased(h.conductor);
  const reopened = await h.restart();
  assert.equal(reopened.state.runsInState('interrupted')[0]?.endReason, 'shutdown');
  assert.equal(reopened.state.runsInState('waiting').length, 1, 'the question survives');
});

test('a cancel that fails at shutdown is kept and retried on the next start', async (t) => {
  const h = await makeHarness(t, { autoComplete: false });
  const cancel = h.orchestrator.cancel.bind(h.orchestrator);
  let failing = true;
  h.orchestrator.cancel = async (...args) => {
    if (failing) throw new Error('orchestrator unavailable');
    return cancel(...args);
  };
  const held = heldStep();
  h.model.script('planner', text('1. Do it.'));
  h.model.script('conductor', ...delegateFree(), held.step);
  await h.send('cnv_1', 'Go.');
  await held.started;
  await h.conductor.close();
  held.release();
  await h.orchestrator.settled();
  assert.equal(h.orchestrator.stats().activeTasks, 1, 'the failed cancel left the task running');
  failing = false;

  const reopened = await h.restart({
    orchestratorAccess: (conversationId) => h.access(conversationId),
  });
  await reopened.idle();
  await assertNoTasks(h);
  assertReleased(reopened);
});

const PAUSED = 'Spending is paused.';

test('stopAll ends every open run, cancels their tasks, tells each user why, and releases everything', async (t) => {
  const h = await makeHarness(t, {
    autoComplete: false,
    conductor: { orchestratorAccess: (conversationId) => h.access(conversationId) },
  });
  // One conversation waits for an answer, with no task and no turn.
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
  await h.send('cnv_b', 'Choose.');
  await h.conductor.idle();
  assert.equal(h.conductor.state.runsInState('waiting').length, 1);
  // Another has a task running and a model call in flight.
  const started = onRunStart(h);
  const held = heldStep();
  h.model.script('planner', text('1. Do it.'));
  h.model.script('conductor', ...delegateFree(), held.step);
  await h.send('cnv_a', 'Go.');
  await started;
  await held.started;

  assert.equal(await h.conductor.stopAll('paused', PAUSED), 2);
  await h.conductor.idle();
  held.release();
  assert.deepEqual(
    h.conductor.state.runsInState('cancelled').map((run) => run.endReason),
    ['paused', 'paused'],
  );
  assert.deepEqual(h.outbox.notices.map((notice) => [notice.conversationId, notice.text]).sort(), [
    ['cnv_a', PAUSED],
    ['cnv_b', PAUSED],
  ]);
  await assertNoTasks(h);
  assertReleased(h.conductor);
  assert.equal(await h.conductor.stopAll('paused', PAUSED), 0, 'nothing is left to stop');
});

test('stopAll with nothing open stops nothing, and a later message starts a fresh run', async (t) => {
  const h = await makeHarness(t);
  assert.equal(await h.conductor.stopAll('paused', PAUSED), 0);
  h.model.script('conductor', text('Back.'));
  await h.send('cnv_1', 'Hi.');
  await h.conductor.idle();
  assert.deepEqual(
    h.outbox.messages.map((message) => message.text),
    ['Back.'],
  );
  assert.equal(await h.conductor.stopAll('paused', PAUSED), 0, 'the finished run is not stopped');
  h.model.script('conductor', text('Again.'));
  await h.send('cnv_1', 'Once more.');
  await h.conductor.idle();
  assert.equal(h.conductor.state.runsInState('cancelled').length, 0);
  assertReleased(h.conductor);
});

test('stopAll on a closed conductor stops nothing', async (t) => {
  const h = await makeHarness(t);
  await h.conductor.close();
  assert.equal(await h.conductor.stopAll('paused', PAUSED), 0);
});

test('stopAll after a restart that gives no orchestrator access still ends the waiting run', async (t) => {
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
  await h.conductor.close();
  const reopened = await h.restart({});
  assert.equal(reopened.state.runsInState('waiting').length, 1, 'the question survives');
  assert.equal(await reopened.stopAll('paused', PAUSED), 1);
  await reopened.idle();
  assert.equal(reopened.state.runsInState('cancelled')[0]?.endReason, 'paused');
  assertReleased(reopened);
});

test('a cancel that fails after a pause is retried by the next stopAll, with no open run left, and its reservation is held until the stop is confirmed', async (t) => {
  const h = await makeHarness(t, {
    autoComplete: false,
    conductor: { orchestratorAccess: (conversationId) => h.access(conversationId) },
  });
  const cancel = h.orchestrator.cancel.bind(h.orchestrator);
  let failing = true;
  let attempts = 0;
  h.orchestrator.cancel = async (...args) => {
    attempts += 1;
    if (failing) throw new Error('orchestrator unavailable');
    return cancel(...args);
  };
  const started = onRunStart(h);
  const held = heldStep();
  h.model.script('planner', text('1. Do it.'));
  h.model.script('conductor', ...delegateFree(), held.step);
  await h.send('cnv_a', 'Go.');
  await started;
  await held.started;

  assert.equal(await h.conductor.stopAll('paused', PAUSED), 1);
  await h.conductor.idle();
  held.release();
  assert.equal(attempts, 1);
  assert.equal(h.orchestrator.stats().activeTasks, 1, 'the failed cancel left the task running');
  assert.equal(h.conductor.state.runsInState('cancelled').length, 1, 'the run itself is over');
  const [owed] = h.conductor.state.unsettledDelegations();
  assert.ok(owed?.cancelPending, 'the cancel is owed, so the reservation is still held');

  // The connection comes back. Nothing is open, but the pause watcher keeps calling stopAll.
  failing = false;
  assert.equal(await h.conductor.stopAll('paused', PAUSED), 0, 'no run is stopped again');
  await h.conductor.idle();
  assert.ok(attempts >= 2, 'the owed cancel was tried again');
  await assertNoTasks(h);
  assert.deepEqual(
    h.conductor.state.unsettledDelegations(),
    [],
    'settled once the stop is confirmed',
  );
  assertReleased(h.conductor);
});

test('a cancel that fails after a user stop is retried on a timer, without any further call', async (t) => {
  const h = await makeHarness(t, {
    autoComplete: false,
    conductor: {
      orchestratorAccess: (conversationId) => h.access(conversationId),
      limits: { stopCheckMs: 5 },
    },
  });
  const cancel = h.orchestrator.cancel.bind(h.orchestrator);
  let failures = 0;
  const retried = gate();
  h.orchestrator.cancel = async (...args) => {
    if (failures < 2) {
      failures += 1;
      throw new Error('orchestrator unavailable');
    }
    const view = await cancel(...args);
    retried.open();
    return view;
  };
  const started = onRunStart(h);
  const held = heldStep();
  h.model.script('planner', text('1. Do it.'));
  h.model.script('conductor', ...delegateFree(), held.step);
  await h.send('cnv_a', 'Go.');
  await started;
  await held.started;
  assert.equal(await h.conductor.stop('cnv_a'), true);
  held.release();
  await retried.promise;
  await h.conductor.idle();
  assert.equal(failures, 2, 'it kept trying until the orchestrator answered');
  await assertNoTasks(h);
  assert.deepEqual(h.conductor.state.unsettledDelegations(), []);
  assertReleased(h.conductor);
});

// -- tasks the orchestrator keeps across a restart ---------------------------------------------------

/** A run with a task running and its model call held, as a restart finds it. */
async function runningTaskTurn(h: Harness) {
  const started = onRunStart(h);
  const held = heldStep();
  h.model.script('planner', text('1. Do it.'));
  h.model.script('conductor', ...delegateFree(), held.step);
  await h.send('cnv_1', 'Go.');
  const run = await started;
  await held.started;
  return { run, held };
}

const keepTasks = (h: () => Harness): Partial<ConductorOptions> => ({
  tasksSurviveRestart: true,
  orchestratorAccess: (conversationId) => h().access(conversationId),
  limits: { stopCheckMs: 1 },
});

test('with tasks that survive a restart, a restart neither cancels a running task nor settles it, and it is settled once it ends', async (t) => {
  const h: Harness = await makeHarness(t, {
    autoComplete: false,
    conductor: keepTasks(() => h),
  });
  const { run, held } = await runningTaskTurn(h);
  const [before] = h.conductor.state.unsettledDelegations();
  assert.ok(before?.taskId, 'the delegation is bound to its task');

  const closing = h.conductor.close();
  held.release();
  await closing;
  const reopened = await h.restart();
  await reopened.idle();
  assert.equal(h.orchestrator.stats().activeTasks, 1, 'the task is still running');
  const [owed] = reopened.state.unsettledDelegations();
  assert.equal(owed?.key, before.key);
  assert.equal(owed?.cancelPending, false, 'no cancel is owed for it');
  assert.equal(owed?.reservedUsd, before.reservedUsd, 'its reservation is kept');
  assert.equal(h.warnings.length, 0, JSON.stringify(h.warnings));

  // It ends; the conductor finds out by asking, and settles it.
  await run.complete();
  await h.orchestrator.settled();
  for (let pass = 0; reopened.state.unsettledDelegations().length > 0; pass++) {
    assert.ok(pass < 500, 'the delegation was never settled');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(reopened.state.delegation(before.key)?.state, 'settled');
  await reopened.idle();
  assert.equal(reopened.stats().stopChecks, 0);
});

test('the same restart without that setting cancels the task, as before', async (t) => {
  const h = await makeHarness(t, { autoComplete: false });
  const { held } = await runningTaskTurn(h);
  const closing = h.conductor.close();
  held.release();
  await closing;
  assert.equal(h.orchestrator.stats().activeTasks, 0, 'the shutdown cancelled it');
  await h.restart({ orchestratorAccess: (conversationId) => h.access(conversationId) });
  await assertNoTasks(h);
});

test('a task the conductor never learned of is still cancelled by its key at a restart that keeps tasks', async (t) => {
  const h = await makeHarness(t, {
    autoComplete: false,
    conductor: { tasksSurviveRestart: true },
  });
  const created = gate();
  const respond = gate();
  const delegate = h.orchestrator.delegate.bind(h.orchestrator);
  h.orchestrator.delegate = async (...args) => {
    const view = await delegate(...args);
    created.open();
    await respond.promise;
    return view;
  };
  h.model.script('planner', text('1. Do it.'));
  h.model.script('conductor', ...delegateFree());
  await h.send('cnv_1', 'Go.');
  await created.promise;
  const reopened = await h.restart({
    tasksSurviveRestart: true,
    orchestratorAccess: (conversationId) => h.access(conversationId),
  });
  respond.open();
  await reopened.idle();
  await h.orchestrator.settled();
  await assertNoTasks(h);
});

test('the operator’s pause still cancels a task that was kept across a restart', async (t) => {
  const h: Harness = await makeHarness(t, {
    autoComplete: false,
    conductor: keepTasks(() => h),
  });
  const { held } = await runningTaskTurn(h);
  const closing = h.conductor.close();
  held.release();
  await closing;
  const reopened = await h.restart({ limits: { stopCheckMs: 60_000 } });
  await reopened.idle();
  assert.equal(h.orchestrator.stats().activeTasks, 1);
  assert.equal(await reopened.stopAll('paused', 'Spending is paused.'), 0, 'no run is open');
  await reopened.idle();
  await assertNoTasks(h);
});
