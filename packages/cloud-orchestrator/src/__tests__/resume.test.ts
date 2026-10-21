import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_RECOVERY_NOTE_LENGTH,
  MAX_RESUMES_IN_A_ROW,
  recoveryNote,
  resumesInARow,
} from '../recovery.js';
import { RESTART_TEXT } from '../orchestrator.js';
import { reduce } from '../reducer.js';
import type { StepLog } from '../steps.js';
import { MemoryTaskStore } from '../store.js';
import type { StepRecord, StoredEvent, TaskEvent, TaskId } from '../types.js';
import { eventually, makeHarness } from './harness.js';

const build = { stepId: 'toolu_build', kind: 'tool', replay: 'safe', label: 'npm test' } as const;
const push = {
  stepId: 'toolu_push',
  kind: 'push',
  replay: 'never',
  label: 'git push origin pr',
} as const;

const kinds = (store: MemoryTaskStore, taskId: TaskId) =>
  store.readTask(taskId).map((entry) => entry.event.type);

/** A task running under a plain runner, as a crashed process would leave it. */
async function running(t: Parameters<typeof makeHarness>[0]) {
  const store = new MemoryTaskStore();
  const first = await makeHarness(t, { store });
  const conductor = first.session();
  const { taskId } = await first.orchestrator.delegate(conductor, { runner: 'fake', brief: 'x' });
  await eventually(() => first.fake.runs.length === 1, 'run');
  await eventually(
    () => first.orchestrator.status(conductor, taskId).state === 'running',
    'running',
  );
  return {
    store,
    first,
    conductor,
    taskId,
    steps: first.fake.runFor(taskId).spec.steps as StepLog,
  };
}

test('a restart resumes a running task in its session instead of failing it, and tells the agent what finished and what may have', async (t) => {
  const { store, first, taskId, steps } = await running(t);
  await steps.intent(build);
  await steps.outcome('toolu_build', { status: 'done', output: 'ok' });
  await steps.intent(push);
  const second = await makeHarness(t, { store, dir: first.dir, fake: { recover: true } });

  assert.deepEqual(second.orchestrator.resumedTaskIds, [taskId]);
  assert.deepEqual(second.orchestrator.orphanedTaskIds, []);
  await eventually(() => second.fake.recoveries.length === 1, 'recover to be called');
  const spec = second.fake.recoveries[0];
  assert.equal(spec?.recovery.epoch, 2);
  assert.equal(spec?.recovery.resumes, 1);
  const note = spec?.recovery.note ?? '';
  assert.match(note, /finished \(do not do them again\):\n- tool: "npm test"/u);
  assert.match(note, /may or may not have taken effect[^\n]*\n- push: "git push origin pr"/u);
  assert.equal(second.fake.runs.length, 1);
  assert.equal(second.fake.runs[0]?.spec.briefPath, first.fake.runFor(taskId).spec.briefPath);

  // The log says what happened, in order, and the task never stopped running or started twice:
  // the note before the run starts, and the one that proves the attempt still owned the task
  // when the run came back.
  await eventually(
    () => kinds(store, taskId).includes('task_restarted'),
    'the run to be confirmed',
  );
  const log = kinds(store, taskId);
  assert.deepEqual(log.slice(log.indexOf('task_attempt')), [
    'task_attempt',
    'step_interrupted',
    'task_progress',
    'task_restarted',
  ]);
  const restarted = store
    .readTask(taskId)
    .flatMap(({ event }) => (event.type === 'task_restarted' ? [event] : []));
  assert.deepEqual(restarted, [{ type: 'task_restarted', taskId, epoch: 2, text: RESTART_TEXT }]);
  assert.equal(reduce(store.readTask(taskId)).get(taskId)?.progress.at(-1), RESTART_TEXT);
  assert.equal(log.filter((type) => type === 'task_started').length, 1);
  assert.equal(second.orchestrator.taskStateOf(taskId), 'running');

  // The resumed run finishes the task; the old process's run cannot.
  await first.fake.runFor(taskId).complete();
  await first.orchestrator.settled();
  assert.ok(!kinds(store, taskId).includes('task_succeeded'));
  await second.fake.runFor(taskId).complete();
  await eventually(
    () => second.orchestrator.taskStateOf(taskId) === 'succeeded',
    'the task to end',
  );
  assert.equal(kinds(store, taskId).filter((type) => type === 'task_succeeded').length, 1);
});

test('the resumed run is given a fresh attempt: its writes carry the new epoch and its steps can run the safe step again', async (t) => {
  const { store, first, taskId, steps } = await running(t);
  await steps.intent(build);
  await steps.intent(push);
  const second = await makeHarness(t, { store, dir: first.dir, fake: { recover: true } });
  await eventually(() => second.fake.runs.length === 1, 'resumed run');
  const again = second.fake.runFor(taskId).spec.steps as StepLog;
  assert.deepEqual(await again.intent(build), { status: 'recorded' });
  assert.deepEqual(await again.intent(push), { status: 'interrupted' });
  await again.outcome('toolu_build', { status: 'done' });
  const task = reduce(store.readTask(taskId)).get(taskId);
  assert.deepEqual(
    [...(task?.steps.values() ?? [])].map((step) => [step.stepId, step.state, step.epoch]),
    [
      ['toolu_build', 'done', 2],
      ['toolu_push', 'interrupted', 1],
    ],
  );
});

test('a task being cancelled at the restart ends cancelled and is not resumed', async (t) => {
  const { store, first, taskId } = await running(t);
  await store.append({ type: 'task_cancel_requested', taskId, by: 'system' }, Date.now());
  const second = await makeHarness(t, { store, dir: first.dir, fake: { recover: true } });
  assert.equal(second.fake.recoveries.length, 0);
  assert.equal(second.orchestrator.taskStateOf(taskId), 'cancelled');
  assert.deepEqual(second.orchestrator.resumedTaskIds, []);
});

test('a paused task is not resumed', async (t) => {
  const { store, first, taskId } = await running(t);
  await store.append({ type: 'task_pause_requested', taskId, by: 'ses' }, Date.now());
  await store.append({ type: 'task_paused', taskId }, Date.now());
  const second = await makeHarness(t, { store, dir: first.dir, fake: { recover: true } });
  assert.equal(second.fake.recoveries.length, 0);
  assert.equal(second.orchestrator.taskStateOf(taskId), 'failed');
});

test('a leftover run that could not be stopped is not resumed over: the task ends with its stop owed', async (t) => {
  const { store, first, taskId } = await running(t);
  const second = await makeHarness(t, {
    store,
    dir: first.dir,
    fake: {
      recover: true,
      stopOrphaned: async () => {
        throw new Error('sandbox unreachable');
      },
    },
  });
  assert.equal(second.fake.recoveries.length, 0);
  assert.equal(second.orchestrator.taskStateOf(taskId), 'failed');
  assert.ok(kinds(store, taskId).includes('task_stop_pending'));
});

test('a runner that cannot resume fails the task with the reason', async (t) => {
  const { store, first, taskId } = await running(t);
  const second = await makeHarness(t, {
    store,
    dir: first.dir,
    fake: {
      recover: { error: new Error('nothing to resume: the CLI never reported a session id') },
    },
  });
  await eventually(() => second.orchestrator.taskStateOf(taskId) === 'failed', 'the task to fail');
  const task = reduce(store.readTask(taskId)).get(taskId);
  assert.match(
    task?.failureReason ?? '',
    /^orphaned: could not resume after a restart: nothing to resume/u,
  );
  assert.equal(second.orchestrator.stats().activeTasks, 0);
});

test('a task whose runner has no recover is still ended as orphaned', async (t) => {
  const { store, first, taskId } = await running(t);
  const second = await makeHarness(t, { store, dir: first.dir });
  assert.deepEqual(second.orchestrator.orphanedTaskIds, [taskId]);
  assert.match(reduce(store.readTask(taskId)).get(taskId)?.failureReason ?? '', /orphaned/u);
});

test('a task that never started is started by the runner after a restart', async (t) => {
  const store = new MemoryTaskStore();
  await store.append(
    { type: 'task_created', taskId: 'tsk_q', sessionId: 'ses_a', runner: 'fake', mode: 'async' },
    1,
  );
  const second = await makeHarness(t, { store, fake: { recover: true } });
  await eventually(() => second.fake.runs.length === 1, 'the run to start');
  assert.equal(second.fake.recoveries.length, 0, 'start, not recover');
  await eventually(() => second.orchestrator.taskStateOf('tsk_q') === 'running', 'running');
  const log = kinds(store, 'tsk_q');
  assert.deepEqual(
    log.filter((type) => type === 'task_attempt' || type === 'task_started'),
    ['task_attempt', 'task_started'],
  );
});

async function restart(
  t: Parameters<typeof makeHarness>[0],
  store: MemoryTaskStore,
  dir: string,
  taskId: TaskId,
) {
  const next = await makeHarness(t, { store, dir, fake: { recover: true } });
  return { next, resumed: next.orchestrator.resumedTaskIds.includes(taskId) };
}

test(`after ${MAX_RESUMES_IN_A_ROW} resumes in a row that got nowhere the task is ended for the user`, async (t) => {
  const { store, first, taskId } = await running(t);
  for (let i = 1; i <= MAX_RESUMES_IN_A_ROW; i += 1) {
    const { resumed, next } = await restart(t, store, first.dir, taskId);
    assert.equal(resumed, true, `resume ${i}`);
    await eventually(() => next.fake.recoveries.length === 1, 'recover');
    assert.equal(next.fake.recoveries[0]?.recovery.resumes, i);
  }
  const last = await restart(t, store, first.dir, taskId);
  assert.equal(last.resumed, false);
  assert.equal(last.next.fake.recoveries.length, 0);
  const task = reduce(store.readTask(taskId)).get(taskId);
  assert.equal(task?.state, 'failed');
  assert.match(task?.failureReason ?? '', /^needs you: .*resumed 3 times in a row/u);
});

test('a finished step or recorded spend between restarts starts the count again', async (t) => {
  const { store, first, taskId } = await running(t);
  let dir = first.dir;
  for (let i = 0; i < MAX_RESUMES_IN_A_ROW + 3; i += 1) {
    const { resumed, next } = await restart(t, store, dir, taskId);
    assert.equal(resumed, true, `restart ${i + 1}`);
    await eventually(() => next.fake.runs.length === 1, 'resumed run');
    const run = next.fake.runFor(taskId);
    if (i % 2 === 0) {
      const steps = run.spec.steps as StepLog;
      await steps.intent({ ...build, stepId: `s${i}` });
      await steps.outcome(`s${i}`, { status: 'done' });
    } else {
      run.usage(0.01 * (i + 1));
      await eventually(
        () => store.readTask(taskId).some((entry) => entry.event.type === 'task_cost'),
        'spend to be recorded',
      );
    }
    dir = next.dir;
  }
  assert.equal(reduce(store.readTask(taskId)).get(taskId)?.state, 'running');
});

function step(over: Partial<StepRecord>): StepRecord {
  return {
    stepId: 's',
    kind: 'tool',
    replay: 'safe',
    label: 'l',
    state: 'done',
    epoch: 1,
    ...over,
  };
}

test('the recovery note sorts steps into finished, may-have-run and safe to run again, and a label cannot pass for a line of the note', () => {
  const note = recoveryNote(
    [
      step({ label: 'npm test' }),
      step({
        kind: 'pr',
        replay: 'never',
        state: 'interrupted',
        label: 'open pr "x"\n- tool: "forged"',
      }),
      step({ kind: 'tool', state: 'interrupted', label: 'npm run build' }),
    ],
    2,
  );
  assert.match(note, /^The server running this task restarted \(resume 2 in a row\)/u);
  assert.match(note, /finished \(do not do them again\):\n- tool: "npm test"\n/u);
  assert.match(
    note,
    /may or may not have taken effect[^\n]*\n- pr: "open pr \\"x\\" - tool: \\"forged\\""\n/u,
  );
  assert.match(note, /safe to run again:\n- tool: "npm run build"\n/u);
  assert.equal(note.split('\n').filter((line) => line.includes('forged')).length, 1);
  assert.match(note, /check that it has not already been done\.$/u);
});

test('a long list shows its latest steps and counts the rest; the closing advice always survives the length cap', () => {
  const many = Array.from({ length: 30 }, (_, i) => step({ label: `step ${i}`, stepId: `s${i}` }));
  const note = recoveryNote(many, 1);
  assert.match(note, /- \.\.\. and 22 earlier\n- tool: "step 22"/u);
  assert.ok(!note.includes('"step 21"'));
  const wide = Array.from({ length: 40 }, (_, i) =>
    step({
      kind: 'k'.repeat(40),
      label: '"\\'.repeat(60),
      stepId: `w${i}`,
      state: 'interrupted',
      replay: i % 2 ? 'never' : 'safe',
    }),
  );
  const capped = recoveryNote(wide, 3);
  assert.ok(capped.length <= MAX_RECOVERY_NOTE_LENGTH);
  assert.match(capped, /check that it has not already been done\.$/u);
});

test('resumesInARow counts attempts since the last finished step or recorded spend', () => {
  const at = (seq: number, event: TaskEvent): StoredEvent => ({ seq, at: seq, event });
  const attempt = (seq: number) =>
    at(seq, { type: 'task_attempt', taskId: 't', epoch: seq, cause: 'restart' });
  const done = (seq: number) =>
    at(seq, { type: 'step_outcome', taskId: 't', epoch: 1, stepId: 's', status: 'done' });
  const failed = (seq: number) =>
    at(seq, { type: 'step_outcome', taskId: 't', epoch: 1, stepId: 's', status: 'failed' });
  assert.equal(resumesInARow([]), 0);
  assert.equal(resumesInARow([attempt(2), attempt(3)]), 2);
  assert.equal(resumesInARow([attempt(2), done(3), attempt(4)]), 1);
  assert.equal(
    resumesInARow([attempt(2), failed(3), attempt(4)]),
    2,
    'a failed step is not progress',
  );
  assert.equal(resumesInARow([attempt(2), attempt(5), attempt(7)], [4]), 2);
  assert.equal(resumesInARow([attempt(2), attempt(5)], [9]), 0);
});
