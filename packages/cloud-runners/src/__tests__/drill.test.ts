import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reduce, type StepLog } from '@maka-cloud/orchestrator';
import { until } from './harness.js';
import { crashInsideNeverStep, fakeFile, lines } from './drill.js';

test('drill: the driver dies inside a never step: the step is reported interrupted and never run again, the task goes on, and the dead driver’s late writes are refused', async (t) => {
  const { h, store, second, info, taskId, specs, takeoverMs } = await crashInsideNeverStep(t);
  t.diagnostic(`takeover to the resumed CLI having its message: ${takeoverMs} ms`);
  assert.ok(takeoverMs <= 12_000, `the task was running again after ${takeoverMs} ms`);

  // The second process took the task over in the recorded session.
  assert.deepEqual(second.resumedTaskIds, [taskId]);
  await until(() => second.status(info, taskId).state === 'succeeded', 30_000).catch(
    async (error) => {
      const view = second.status(info, taskId);
      throw new Error(
        `${String(error)}: ${JSON.stringify(view)} ${JSON.stringify((await store.read()).map((e) => e.event.type))} prompts ${JSON.stringify(await lines(fakeFile(h, 'prompts.log')))} hooks ${JSON.stringify(await lines(fakeFile(h, 'hooks.log')))}`,
      );
    },
  );

  // The step is in the log as cut off, not as done, and it ran once.
  const record = reduce(await store.read()).get(taskId);
  assert.equal(record?.state, 'succeeded');
  assert.equal(record?.steps.get('read-1')?.state, 'done');
  assert.equal(record?.steps.get('deploy-1')?.state, 'interrupted');
  assert.deepEqual(await lines(fakeFile(h, 'ran.log')), ['read-1', 'deploy-1']);

  // The agent was told in words which step may have taken effect.
  const prompts = await lines(fakeFile(h, 'prompts.log'));
  assert.equal(prompts.length, 2, 'one prompt for each attempt');
  assert.match(prompts[1] ?? '', /cut off and may or may not have taken effect/u);
  assert.match(prompts[1] ?? '', /Bash: deploy --now/u);

  // The first process is still holding its step log of epoch 1: it can neither settle the step nor
  // start another.
  const stale = specs[0]?.steps as StepLog;
  const before = (await store.read()).length;
  assert.equal(await stale.outcome('deploy-1', { status: 'done' }), 'ignored');
  const another = await stale.intent({
    stepId: 'deploy-2',
    kind: 'Bash',
    replay: 'never',
    label: 'deploy again',
  });
  assert.equal(another.status, 'refused');
  assert.equal((await store.read()).length, before, 'nothing of the old attempt was written');
  assert.equal(
    reduce(await store.read())
      .get(taskId)
      ?.steps.get('deploy-1')?.state,
    'interrupted',
  );
});
