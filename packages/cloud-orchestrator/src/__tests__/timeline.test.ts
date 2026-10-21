import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reduce } from '../reducer.js';
import {
  buildTimeline,
  MAX_COST_POINTS,
  MAX_TURNS,
  STEPS_PAGE_DEFAULT,
  STEPS_PAGE_MAX,
} from '../timeline.js';
import type { StoredEvent, TaskEvent } from '../types.js';

const T = 'tsk_t';
const manifest = {
  summary: 'x',
  done: [] as string[],
  notDone: [] as string[],
  confidence: 'high' as const,
  knownIssues: [] as string[],
};

/** A task that ran one turn, was cut off by a restart in the middle of two steps, and finished. */
function log(): StoredEvent[] {
  const events: Array<[number, TaskEvent]> = [
    [
      0,
      {
        type: 'task_created',
        taskId: T,
        sessionId: 's',
        runner: 'fake',
        mode: 'async',
        budgetUsd: 5,
      },
    ],
    [1_000, { type: 'task_started', taskId: T }],
    [
      1_100,
      {
        type: 'step_intent',
        taskId: T,
        epoch: 1,
        stepId: 'a',
        kind: 'tool:Read',
        replay: 'safe',
        label: 'Read: /secret/plan.md',
      },
    ],
    [1_400, { type: 'step_outcome', taskId: T, epoch: 1, stepId: 'a', status: 'done' }],
    [1_500, { type: 'task_cost', taskId: T, fromTaskId: T, epoch: 1, costUsd: 0.5 }],
    [
      1_600,
      {
        type: 'step_intent',
        taskId: T,
        epoch: 1,
        stepId: 'b',
        kind: 'tool:Bash',
        replay: 'safe',
        label: 'Bash: npm test',
      },
    ],
    [
      1_700,
      {
        type: 'step_intent',
        taskId: T,
        epoch: 1,
        stepId: 'c',
        kind: 'tool:Bash',
        replay: 'never',
        label: 'Bash: git push origin pr',
      },
    ],
    [1_800, { type: 'task_steer', taskId: T, steerId: 'm1', text: 'private words', by: 's' }],
    [2_000, { type: 'task_steer_delivered', taskId: T, steerId: 'm1', epoch: 1 }],
    [3_000, { type: 'task_steer', taskId: T, steerId: 'm2', text: 'more', by: 's' }],
    // The server restarts: both steps were open.
    [10_000, { type: 'task_attempt', taskId: T, epoch: 2, cause: 'restart' }],
    [10_010, { type: 'step_interrupted', taskId: T, epoch: 2, stepId: 'b' }],
    [10_020, { type: 'step_interrupted', taskId: T, epoch: 2, stepId: 'c' }],
    [
      10_500,
      {
        type: 'step_intent',
        taskId: T,
        epoch: 2,
        stepId: 'b',
        kind: 'tool:Bash',
        replay: 'safe',
        label: 'Bash: npm test',
      },
    ],
    [
      11_500,
      { type: 'step_outcome', taskId: T, epoch: 2, stepId: 'b', status: 'failed', output: 'boom' },
    ],
    [11_600, { type: 'task_cost', taskId: T, fromTaskId: T, epoch: 2, costUsd: 0.25 }],
    // A late outcome for the cut-off step from the old epoch changes nothing.
    [11_700, { type: 'step_outcome', taskId: T, epoch: 1, stepId: 'c', status: 'done' }],
    [12_000, { type: 'task_steer_unseen', taskId: T, steerId: 'm2' }],
    [12_100, { type: 'task_succeeded', taskId: T, manifest }],
  ];
  return events.map(([at, event], index) => ({ seq: index + 1, at, event }));
}

test('the timeline has the turns, the steps once each with their timing, the cost over time and the messages as counts', () => {
  const timeline = buildTimeline(log());
  assert.ok(timeline);
  assert.equal(timeline.state, 'succeeded');
  assert.deepEqual(timeline.turns, [
    { epoch: 1, cause: 'start', startedAt: 0, endedAt: 10_000, steps: 3 },
    { epoch: 2, cause: 'restart', startedAt: 10_000, endedAt: 12_100, steps: 1 },
  ]);
  assert.deepEqual(
    timeline.steps.map(
      ({ stepId, kind, replay, state, epoch, attempts, startedAt, endedAt, durationMs }) => ({
        stepId,
        kind,
        replay,
        state,
        epoch,
        attempts,
        startedAt,
        endedAt,
        durationMs,
      }),
    ),
    [
      {
        stepId: 'a',
        kind: 'tool:Read',
        replay: 'safe',
        state: 'done',
        epoch: 1,
        attempts: 1,
        startedAt: 1_100,
        endedAt: 1_400,
        durationMs: 300,
      },
      // A step that ran again after the restart is one row, the second run.
      {
        stepId: 'b',
        kind: 'tool:Bash',
        replay: 'safe',
        state: 'failed',
        epoch: 2,
        attempts: 2,
        startedAt: 10_500,
        endedAt: 11_500,
        durationMs: 1_000,
      },
      // The push was cut off: it has no duration and was not run again.
      {
        stepId: 'c',
        kind: 'tool:Bash',
        replay: 'never',
        state: 'interrupted',
        epoch: 1,
        attempts: 1,
        startedAt: 1_700,
        endedAt: 10_020,
        durationMs: undefined,
      },
    ],
  );
  assert.deepEqual(timeline.cost, [
    { at: 1_500, totalUsd: 0.5 },
    { at: 11_600, totalUsd: 0.75 },
  ]);
  assert.deepEqual(timeline.messages, { sent: 2, read: 1, unseen: 1, withdrawn: 0 });
  assert.equal(timeline.runMs, 12_100 - 1_000);
});

test('only metadata unless content is on: no label, no message text, no output', () => {
  const plain = JSON.stringify(buildTimeline(log()));
  for (const secret of ['/secret/plan.md', 'npm test', 'git push', 'private words', 'boom']) {
    assert.ok(!plain.includes(secret), secret);
  }
  const withContent = buildTimeline(log(), { content: true });
  assert.deepEqual(
    withContent?.steps.map((step) => step.label),
    ['Read: /secret/plan.md', 'Bash: npm test', 'Bash: git push origin pr'],
  );
  assert.ok(!JSON.stringify(withContent).includes('private words'), 'message text is never in it');
  assert.equal(withContent?.content, true);
});

test('the timeline agrees with the task’s own state: the same steps in the same order and states', () => {
  const events = log();
  const task = reduce(events).get(T);
  const timeline = buildTimeline(events);
  assert.deepEqual(
    timeline?.steps.map(({ stepId, kind, replay, state, epoch }) => ({
      stepId,
      kind,
      replay,
      state,
      epoch,
    })),
    [...(task?.steps.values() ?? [])].map(({ stepId, kind, replay, state, epoch }) => ({
      stepId,
      kind,
      replay,
      state,
      epoch,
    })),
  );
  assert.equal(timeline?.state, task?.state);
  assert.equal(timeline?.cost.at(-1)?.totalUsd, task?.costUsd);
  assert.equal(timeline?.turns.at(-1)?.epoch, task?.epoch);
});

test('a task that is still running has an open turn and counts the interval under way; a log without a task has no timeline', () => {
  const running = buildTimeline(log().slice(0, 4), { now: 5_000 });
  assert.equal(running?.turns.at(-1)?.endedAt, undefined);
  assert.equal(running?.runMs, 4_000);
  assert.equal(running?.steps[0]?.state, 'done');
  assert.equal(buildTimeline([]), undefined);
});

test('an attempt the log should not hold (a skipped epoch) is not a turn, and events of other tasks are ignored', () => {
  const events = log();
  const odd: StoredEvent[] = [
    ...events.slice(0, 2),
    { seq: 90, at: 1_050, event: { type: 'task_attempt', taskId: T, epoch: 5, cause: 'restart' } },
    { seq: 91, at: 1_060, event: { type: 'task_progress', taskId: 'other', note: 'x' } },
    ...events.slice(2),
  ];
  assert.deepEqual(
    buildTimeline(odd)?.turns.map((turn) => turn.epoch),
    [1, 2],
  );
});

/** A task whose log holds `reports` usage reports and `steps` steps, as a long run leaves it. */
function longLog(reports: number, steps: number): StoredEvent[] {
  let at = 0;
  const out: StoredEvent[] = [];
  const add = (event: TaskEvent): void => {
    out.push({ seq: out.length + 1, at: (at += 10), event } as StoredEvent);
  };
  add({ type: 'task_created', taskId: T, sessionId: 's', runner: 'fake', mode: 'async' });
  add({ type: 'task_started', taskId: T });
  for (let i = 0; i < steps; i += 1) {
    add({
      type: 'step_intent',
      taskId: T,
      epoch: 1,
      stepId: `s${i}`,
      kind: 'tool:Read',
      replay: 'safe',
      label: `Read: ${i}`,
    });
    add({ type: 'step_outcome', taskId: T, epoch: 1, stepId: `s${i}`, status: 'done' });
  }
  for (let i = 1; i <= reports; i += 1) {
    add({ type: 'task_cost', taskId: T, fromTaskId: T, epoch: 1, costUsd: i / 1000 });
  }
  return out;
}

test('a long log gives a bounded cost series that keeps the first and last point and the count', () => {
  const timeline = buildTimeline(longLog(5000, 0));
  assert.ok(timeline);
  assert.ok(timeline.cost.length <= 2 * MAX_COST_POINTS + 1, `${timeline.cost.length} points`);
  assert.equal(timeline.costReports, 5000);
  assert.equal(timeline.cost.at(0)?.totalUsd, 0.001);
  assert.equal(timeline.cost.at(-1)?.totalUsd, 5);
  // Still a series in time and in total.
  for (const [i, point] of timeline.cost.entries()) {
    const before: { at: number; totalUsd: number } | undefined = timeline.cost[i - 1];
    if (before) assert.ok(point.at > before.at && point.totalUsd >= before.totalUsd);
  }
});

test('steps come in pages that follow each other, with the total and where the next page starts', () => {
  const events = longLog(0, 250);
  const first = buildTimeline(events);
  assert.ok(first);
  assert.equal(first.stepsTotal, 250);
  assert.equal(first.steps.length, STEPS_PAGE_DEFAULT);
  assert.equal(first.stepsNext, STEPS_PAGE_DEFAULT);
  const seen: string[] = [];
  let after: number | undefined = 0;
  while (after !== undefined) {
    const page = buildTimeline(events, { after, limit: 60 });
    assert.ok(page);
    seen.push(...page.steps.map((step) => step.stepId));
    after = page.stepsNext;
  }
  assert.deepEqual(
    seen,
    Array.from({ length: 250 }, (_, i) => `s${i}`),
  );
  // A request cannot ask for more than the cap, or for nothing past the end.
  assert.equal(
    buildTimeline(longLog(0, STEPS_PAGE_MAX + 100), { limit: 100_000 })?.steps.length,
    STEPS_PAGE_MAX,
  );
  const past = buildTimeline(events, { after: 9999 });
  assert.deepEqual(past?.steps, []);
  assert.equal(past?.stepsNext, undefined);
});

test('a task with many turns lists the latest ones and counts them all', () => {
  const events = longLog(0, 0);
  for (let epoch = 2; epoch <= 150; epoch += 1) {
    events.push({
      seq: events.length + 1,
      at: epoch * 100,
      event: { type: 'task_attempt', taskId: T, epoch, cause: 'restart' },
    } as StoredEvent);
  }
  const timeline = buildTimeline(events);
  assert.ok(timeline);
  assert.equal(timeline.turnsTotal, 150);
  assert.equal(timeline.turns.length, MAX_TURNS);
  assert.equal(timeline.turns.at(-1)?.epoch, 150);
  assert.equal(timeline.turns.at(0)?.epoch, 51);
});
