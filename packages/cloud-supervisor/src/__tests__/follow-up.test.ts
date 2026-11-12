import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONVERSATION, HOUR, MANIFEST, rig } from './harness.js';

const URL = 'https://github.com/acme/calc/pull/1';

test('a fix run the PR follow-up reports on raises nothing here: no finished item, no failure, no stall', async () => {
  const followed = new Set(['tsk_fix', 'tsk_fix2', 'tsk_fix3']);
  const r = await rig({ followedTask: (taskId) => followed.has(taskId) });
  // A task nobody follows, as the control: each of these raises an item for it.
  for (const taskId of ['tsk_fix', 'tsk_other']) {
    await r.taskCreated(taskId, { title: `Fix checks ${taskId}` });
    await r.taskEvent({ type: 'task_started', taskId });
    await r.taskEvent({ type: 'task_succeeded', taskId, manifest: MANIFEST });
  }
  // The same step failing twice is not a \"same step failed twice\" item for a followed task.
  for (const taskId of ['tsk_fix2', 'tsk_fix3']) {
    await r.taskCreated(taskId, { title: 'Fix failing checks of PR #1' });
    await r.taskEvent({ type: 'task_started', taskId });
    await r.taskEvent({ type: 'task_failed', taskId, reason: 'the checks failed' });
  }
  await r.taskCreated('tsk_slow_fix', { title: 'Fix slow' });
  followed.add('tsk_slow_fix');
  await r.taskEvent({ type: 'task_started', taskId: 'tsk_slow_fix' });
  await r.taskCreated('tsk_slow', { title: 'Slow' });
  await r.taskEvent({ type: 'task_started', taskId: 'tsk_slow' });
  r.clock.advance(2 * HOUR);
  await r.supervisor.tick();
  const items = r.supervisor.listItems({ state: 'all' }).items;
  assert.deepEqual(
    items.map((item) => [item.kind, item.taskId]),
    [
      ['finished', 'tsk_other'],
      ['blocked', 'tsk_slow'],
    ],
  );
  await r.stop();
});

test('a quiet follow-up update never interrupts and leaves the task its own verdict; \"needs you\" interrupts once', async () => {
  const r = await rig();
  r.supervisor.raiseFollowUp({
    conversationId: CONVERSATION,
    taskId: 'tsk_1',
    key: 'tsk_1:passed',
    needsYou: false,
    ask: 'Checks passed on pull request #1 in acme/calc.',
    url: URL,
  });
  await r.supervisor.settled();
  const [quiet] = r.supervisor.listItems({ state: 'open' }).items;
  assert.equal(quiet?.kind, 'finished');
  assert.equal(quiet?.interrupts, false);
  // No task: a result card picks its verdict from the task's own items, which this is not.
  assert.equal(quiet?.taskId, null);
  assert.deepEqual(quiet?.evidence, [{ kind: 'link', url: URL, label: 'Pull request' }]);
  assert.equal(r.host.interrupts.length, 0);

  const exhausted = {
    conversationId: CONVERSATION,
    taskId: 'tsk_1',
    key: 'tsk_1:exhausted',
    needsYou: true,
    ask: 'Checks still fail on pull request #1 in acme/calc after one automatic fix (“unit tests”). It was not tried again.',
    url: URL,
  };
  r.supervisor.raiseFollowUp(exhausted);
  r.supervisor.raiseFollowUp(exhausted);
  await r.supervisor.settled();
  const loud = r.supervisor.listItems({ state: 'open' }).items.filter((i) => i.interrupts);
  assert.equal(loud.length, 1);
  assert.equal(loud[0]?.kind, 'decision');
  assert.equal(loud[0]?.taskId, 'tsk_1');
  assert.deepEqual(
    loud[0]?.options.map((option) => [option.id, option.recommended]),
    [
      ['retry', true],
      ['mine', false],
    ],
  );
  assert.equal(r.host.interrupts.length, 1);

  // The recommended answer asks the agent in the same conversation, once.
  const item = loud[0]!;
  const answered = await r.supervisor.answer({
    itemId: item.itemId,
    answerId: 'ans_retry_1',
    optionId: 'retry',
    preconditionHash: item.preconditionHash,
  });
  assert.equal(answered.ok, true);
  await r.supervisor.settled();
  assert.equal(r.host.posted.length, 1);
  assert.equal(r.host.posted[0]?.conversationId, CONVERSATION);
  assert.match(r.host.posted[0]?.text ?? '', /still fail on pull request #1 .*\(task tsk_1\)/);
  await r.stop();
});
