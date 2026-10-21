import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { StepLog } from '@maka-cloud/orchestrator';
import { conductorSession, recordingHandler } from './conductor.js';
import { eventually, type Harness, newConversation, startHarness } from './harness.js';

async function setup(t: TestContext, overrides: Parameters<typeof startHarness>[1] = {}) {
  const { handler, seen } = recordingHandler();
  const h = await startHarness(t, { handler, ...overrides });
  const conversationId = await newConversation(h);
  const { session } = await conductorSession(h, seen, conversationId);
  const task = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: 'work' });
  await eventually(() => h.fake.runs.length === 1, 'run');
  await eventually(
    () => h.server.orchestrator.status(session, task.taskId).state === 'running',
    'running',
  );
  const run = h.fake.runFor(task.taskId);
  return { h, taskId: task.taskId, run, steps: run.spec.steps as StepLog };
}

const timelineOf = async (h: Harness, taskId: string, token?: string | null) =>
  h.api(`/v1/tasks/${taskId}/timeline`, token === undefined ? {} : { token });

test('the timeline shows the turn, the steps and their states from the log, and agrees with it', async (t) => {
  const { h, taskId, run, steps } = await setup(t);
  await steps.intent({
    stepId: 'toolu_1',
    kind: 'tool:Read',
    replay: 'safe',
    label: 'Read: /work/plan.md',
  });
  await steps.outcome('toolu_1', { status: 'done' });
  await steps.intent({
    stepId: 'toolu_2',
    kind: 'tool:Bash',
    replay: 'never',
    label: 'Bash: git push origin pr',
  });

  const res = await timelineOf(h, taskId);
  assert.equal(res.status, 200);
  const { timeline } = (await res.json()) as {
    timeline: {
      state: string;
      turns: Array<{ epoch: number; cause: string; steps: number }>;
      steps: Array<{ stepId: string; kind: string; state: string; replay: string; label?: string }>;
      content: boolean;
    };
  };
  assert.equal(timeline.state, 'running');
  assert.deepEqual(
    timeline.turns.map(({ epoch, cause, steps: n }) => ({ epoch, cause, steps: n })),
    [{ epoch: 1, cause: 'start', steps: 2 }],
  );
  assert.deepEqual(
    timeline.steps.map(({ stepId, kind, state, replay }) => ({ stepId, kind, state, replay })),
    [
      { stepId: 'toolu_1', kind: 'tool:Read', state: 'done', replay: 'safe' },
      { stepId: 'toolu_2', kind: 'tool:Bash', state: 'running', replay: 'never' },
    ],
  );
  assert.equal(timeline.content, false);
  // Metadata only: nothing of what the steps did.
  assert.ok(!JSON.stringify(timeline).includes('plan.md'));
  assert.ok(!JSON.stringify(timeline).includes('git push'));
});

test('with content on the owner’s timeline says what each step did', async (t) => {
  const { h, taskId, steps } = await setup(t, { timelineContent: true });
  await steps.intent({
    stepId: 'toolu_1',
    kind: 'tool:Read',
    replay: 'safe',
    label: 'Read: /work/plan.md',
  });
  const { timeline } = (await (await timelineOf(h, taskId)).json()) as {
    timeline: { content: boolean; steps: Array<{ label?: string }> };
  };
  assert.equal(timeline.content, true);
  assert.deepEqual(
    timeline.steps.map((step) => step.label),
    ['Read: /work/plan.md'],
  );
});

test('with content on a secret in a step label is scrubbed on the way out', async (t) => {
  const { h, taskId, steps } = await setup(t, { timelineContent: true });
  await steps.intent({
    stepId: 'toolu_1',
    kind: 'tool:Bash',
    replay: 'never',
    label: 'Bash: curl -H "Authorization: Bearer abcdef0123456789abcdef" https://x.test',
  });
  const text = await (await timelineOf(h, taskId)).text();
  assert.ok(!text.includes('abcdef0123456789'), text);
  assert.match(text, /\[secret\]/u);
});

test('a timeline is owner-only: a wrong token is 401, another owner’s task is 404', async (t) => {
  const { h, taskId, steps } = await setup(t);
  await steps.intent({ stepId: 'toolu_1', kind: 'tool:Read', replay: 'safe', label: 'Read: a' });
  assert.equal((await timelineOf(h, taskId)).status, 200);
  for (const token of [null, 'inv_x.y', 'garbage']) {
    assert.equal((await timelineOf(h, taskId, token)).status, 401);
  }
  const other = h.server.invites.create('other');
  assert.equal((await timelineOf(h, taskId, other.token)).status, 404);
  assert.equal((await timelineOf(h, 'tsk_nope')).status, 404);
  assert.equal((await h.api(`/v1/tasks/${taskId}/timeline`, { method: 'POST' })).status, 405);
});

test('a finished task keeps its timeline, with its end and its cost', async (t) => {
  const { h, taskId, run, steps } = await setup(t);
  await steps.intent({ stepId: 'toolu_1', kind: 'tool:Read', replay: 'safe', label: 'Read: a' });
  await steps.outcome('toolu_1', { status: 'done' });
  run.usage(0.5);
  await run.complete();
  await eventually(() => h.server.orchestrator.taskStateOf(taskId) === 'succeeded', 'the end');
  const { timeline } = (await (await timelineOf(h, taskId)).json()) as {
    timeline: {
      state: string;
      finishedAt?: number;
      cost: Array<{ totalUsd: number }>;
      turns: Array<{ endedAt?: number }>;
    };
  };
  assert.equal(timeline.state, 'succeeded');
  assert.ok(timeline.finishedAt !== undefined);
  assert.equal(timeline.turns[0]?.endedAt, timeline.finishedAt);
  assert.equal(timeline.cost.at(-1)?.totalUsd, 0.5);
});
