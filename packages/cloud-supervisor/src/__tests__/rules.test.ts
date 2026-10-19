import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONVERSATION, MANIFEST, MINUTE, rig } from './harness.js';

async function active(r: Awaited<ReturnType<typeof rig>>) {
  return r.supervisor.listItems({ state: 'open' }).items;
}

test('R1: a conductor question becomes an item of the kind its reason names, recommended option first', async () => {
  const r = await rig();
  await r.question('q_taste', 'taste');
  await r.question('q_budget', 'budget_overrun');
  await r.question('q_irrev', 'irreversible');
  await r.supervisor.tick();
  const items = await active(r);
  assert.deepEqual(
    items.map((item) => item.kind),
    ['decision', 'budget', 'approval'],
  );
  assert.deepEqual(
    items.map((item) => item.allowText),
    [true, false, false],
    'only a taste question takes free text; approvals and budget answers are an explicit option',
  );
  for (const item of items) {
    assert.equal(item.options[0]?.recommended, true);
    assert.equal(item.options[0]?.id, 'a');
    assert.equal(item.interrupts, true);
  }
  assert.equal(r.host.interrupts.length, 3, 'each question interrupts once');
  await r.stop();
});

test('R1: the held action behind an irreversible question is shown as evidence', async () => {
  const r = await rig();
  r.host.feed.append(
    'conductor.question',
    CONVERSATION,
    {
      questionId: 'q_pr',
      reason: 'irreversible',
      question: 'Open the pull request?',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
      recommended: 'reject',
      action: { tool: 'open_pull_request', args: { taskId: 'tsk_1', title: 'Fix it' } },
    },
    r.clock.t,
  );
  await r.supervisor.settled();
  const [item] = await active(r);
  assert.equal(item?.kind, 'approval');
  assert.equal(
    item?.options[0]?.id,
    'reject',
    'the conductor recommends reject, so it comes first',
  );
  assert.deepEqual(item?.evidence, [
    { kind: 'action', tool: 'open_pull_request', args: '{"taskId":"tsk_1","title":"Fix it"}' },
  ]);
  await r.stop();
});

test('R1: a repeated question entry makes one item', async () => {
  const r = await rig();
  await r.question('q1');
  await r.question('q1');
  assert.equal((await active(r)).length, 1);
  await r.stop();
});

test('nothing else interrupts: single failures, cancels, restarts, progress and a confident success', async () => {
  const r = await rig();
  // A sub-task that fails once, under a parent.
  await r.taskCreated('p', { title: 'parent' });
  await r.taskCreated('c1', { parent: 'p', title: 'step' });
  await r.taskEvent({ type: 'task_started', taskId: 'c1' });
  await r.taskEvent({ type: 'task_progress', taskId: 'c1', note: 'working' });
  await r.taskEvent({ type: 'task_failed', taskId: 'c1', reason: 'it broke' });
  // A cancelled top-level task, and one interrupted by a restart.
  await r.taskCreated('x', { title: 'cancel me' });
  await r.taskEvent({ type: 'task_cancelled', taskId: 'x' });
  await r.taskCreated('y', { title: 'restart' });
  await r.taskEvent({
    type: 'task_failed',
    taskId: 'y',
    reason: 'orphaned: the orchestrator restarted',
  });
  // A confident top-level success.
  await r.taskCreated('z', { title: 'good' });
  await r.taskEvent({ type: 'task_succeeded', taskId: 'z', manifest: MANIFEST });
  await r.supervisor.tick();
  assert.equal(r.host.interrupts.length, 0);
  const items = await active(r);
  assert.ok(
    items.every((item) => !item.interrupts),
    'only digest-level items exist',
  );
  assert.deepEqual(items.map((item) => item.kind).sort(), ['finished', 'finished']);
  await r.stop();
});

test('R2: the same titled step failing twice raises one blocked item; a third failure refreshes it', async () => {
  const r = await rig();
  await r.taskCreated('p', { title: 'parent' });
  await r.taskCreated('a', { parent: 'p', title: 'run tests' });
  await r.taskEvent({ type: 'task_failed', taskId: 'a', reason: 'tests failed' });
  assert.equal(r.host.interrupts.length, 0, 'one failure is not an interrupt');
  await r.taskCreated('b', { parent: 'p', title: 'run tests' });
  await r.taskEvent({ type: 'task_failed', taskId: 'b', reason: 'tests failed again' });
  await r.supervisor.tick();
  let [item] = await active(r);
  assert.equal(item?.kind, 'blocked');
  assert.match(item?.ask ?? '', /failed 2 times/);
  assert.equal(r.host.interrupts.length, 1);
  const version = item?.version ?? 0;
  await r.taskCreated('c', { parent: 'p', title: 'run tests' });
  await r.taskEvent({ type: 'task_failed', taskId: 'c', reason: 'still failing' });
  [item] = await active(r);
  assert.match(item?.ask ?? '', /failed 3 times/);
  assert.ok((item?.version ?? 0) > version, 'a refresh counts as a new version');
  assert.equal((await active(r)).length, 1);
  assert.equal(r.host.interrupts.length, 1, 'a refresh does not interrupt again');
  await r.stop();
});

test('R2: a success resets the streak and closes the item; different steps do not pair', async () => {
  const r = await rig();
  await r.taskCreated('p', { title: 'parent' });
  await r.taskCreated('a', { parent: 'p', title: 'step one' });
  await r.taskEvent({ type: 'task_failed', taskId: 'a', reason: 'x' });
  await r.taskCreated('b', { parent: 'p', title: 'step two' });
  await r.taskEvent({ type: 'task_failed', taskId: 'b', reason: 'x' });
  assert.equal((await active(r)).length, 0, 'two different steps failed once each');
  await r.taskCreated('a2', { parent: 'p', title: 'step one' });
  await r.taskEvent({ type: 'task_failed', taskId: 'a2', reason: 'x' });
  assert.equal((await active(r)).length, 1);
  await r.taskCreated('a3', { parent: 'p', title: 'step one' });
  await r.taskEvent({ type: 'task_succeeded', taskId: 'a3', manifest: MANIFEST });
  assert.equal((await active(r)).length, 0, 'the success clears the item');
  await r.taskCreated('a4', { parent: 'p', title: 'step one' });
  await r.taskEvent({ type: 'task_failed', taskId: 'a4', reason: 'x' });
  assert.equal((await active(r)).length, 0, 'the streak started again from zero');
  await r.stop();
});

test('R2: restart orphans are not failures; untitled tasks pair only on the same normalized reason', async () => {
  const r = await rig();
  await r.taskCreated('p', { title: 'parent' });
  await r.taskCreated('o1', { parent: 'p', title: 's' });
  await r.taskEvent({ type: 'task_failed', taskId: 'o1', reason: 'orphaned: restarted' });
  await r.taskCreated('o2', { parent: 'p', title: 's' });
  await r.taskEvent({ type: 'task_failed', taskId: 'o2', reason: 'orphaned: restarted' });
  assert.equal((await active(r)).length, 0);

  await r.taskCreated('u1', { parent: 'p' });
  await r.taskEvent({ type: 'task_failed', taskId: 'u1', reason: 'timeout after 30 seconds' });
  await r.taskCreated('u2', { parent: 'p' });
  await r.taskEvent({ type: 'task_failed', taskId: 'u2', reason: 'a different problem' });
  assert.equal((await active(r)).length, 0, 'unrelated untitled failures do not pair');
  await r.taskCreated('u3', { parent: 'p' });
  await r.taskEvent({ type: 'task_failed', taskId: 'u3', reason: 'timeout after 45 seconds' });
  assert.equal((await active(r)).length, 1, 'the same reason, numbers aside, pairs');
  await r.stop();
});

test('R4: a running task with no event for the stall time raises one item per stall episode', async () => {
  const r = await rig();
  await r.taskCreated('t', { title: 'slow' });
  await r.taskEvent({ type: 'task_started', taskId: 't' });
  r.clock.advance(29 * MINUTE);
  await r.supervisor.tick();
  assert.equal((await active(r)).length, 0, 'not yet');
  r.clock.advance(2 * MINUTE);
  await r.supervisor.tick();
  await r.supervisor.tick();
  const [item] = await active(r);
  assert.equal(item?.kind, 'blocked');
  assert.match(item?.ask ?? '', /no progress for 31 minutes/);
  assert.equal(r.host.interrupts.length, 1, 'the second tick does not raise it again');

  // Progress ends the episode and closes the item; a new stall is a new item.
  await r.taskEvent({ type: 'task_progress', taskId: 't', note: 'alive' });
  assert.equal((await active(r)).length, 0);
  r.clock.advance(31 * MINUTE);
  await r.supervisor.tick();
  assert.equal((await active(r)).length, 1);
  await r.stop();
});

test('R4: queued tasks use the queued time; paused tasks and parents of busy children are not stalled', async () => {
  const r = await rig();
  await r.taskCreated('queued', { title: 'waiting for a machine' });
  await r.taskCreated('paused', { title: 'paused' });
  await r.taskEvent({ type: 'task_started', taskId: 'paused' });
  await r.taskEvent({ type: 'task_paused', taskId: 'paused' });
  await r.taskCreated('parent', { title: 'parent' });
  await r.taskEvent({ type: 'task_started', taskId: 'parent' });
  await r.taskCreated('child', { parent: 'parent', title: 'child' });
  await r.taskEvent({ type: 'task_started', taskId: 'child' });
  r.clock.advance(11 * MINUTE);
  await r.supervisor.tick();
  assert.deepEqual(
    (await active(r)).map((item) => item.taskId),
    ['queued'],
    'only the queued task passed its (10 minute) limit',
  );
  r.clock.advance(15 * MINUTE);
  await r.taskEvent({ type: 'task_progress', taskId: 'child', note: 'busy' });
  r.clock.advance(10 * MINUTE);
  await r.supervisor.tick();
  const ids = (await active(r)).map((item) => item.taskId).sort();
  assert.ok(!ids.includes('parent'), 'the parent counts its busy child as activity');
  assert.ok(!ids.includes('paused'), 'a paused task is not stalled');
  assert.ok(
    ids.includes('child') === false,
    'the child made progress 10 minutes ago, under the limit',
  );
  await r.stop();
});

test('R5: a low-confidence top-level result asks the human; a child result does not', async () => {
  const r = await rig();
  await r.taskCreated('top', { title: 'research' });
  await r.taskCreated('sub', { parent: 'top', title: 'part' });
  await r.taskEvent({
    type: 'task_succeeded',
    taskId: 'sub',
    manifest: { ...MANIFEST, confidence: 'low' },
  });
  assert.equal((await active(r)).length, 0);
  await r.taskEvent({
    type: 'task_succeeded',
    taskId: 'top',
    manifest: {
      ...MANIFEST,
      confidence: 'low',
      artifacts: ['out/report.md', 'https://example.com/pr/1'],
    },
  });
  const [item] = await active(r);
  assert.equal(item?.kind, 'decision');
  assert.equal(item?.interrupts, true);
  assert.deepEqual(item?.evidence, [
    { kind: 'artifact', taskId: 'top', name: 'report.md' },
    { kind: 'link', url: 'https://example.com/pr/1', label: 'example.com' },
  ]);
  assert.equal(r.host.interrupts.length, 1);
  await r.stop();
});

test('a user message dismisses the open question item; an inline answer closes it as handled elsewhere', async () => {
  const r = await rig();
  await r.question('q1');
  await r.question('q2');
  await r.userMessage();
  assert.equal(
    (await active(r)).length,
    0,
    'sending a message instead dismisses the open questions',
  );
  await r.question('q3');
  await r.answered('q3', 'a');
  const closed = r.supervisor.listItems({ state: 'closed' }).items;
  assert.equal(closed.find((item) => item.ask.includes('q3'))?.closeReason, 'handled_elsewhere');
  assert.equal(closed.find((item) => item.ask.includes('q1'))?.closeReason, 'condition_cleared');
  await r.stop();
});

test('entries that do not parse are ignored, never guessed at', async () => {
  const r = await rig();
  r.host.feed.append(
    'conductor.question',
    CONVERSATION,
    { questionId: 'bad', options: [] },
    r.clock.t,
  );
  r.host.feed.append('task.event', CONVERSATION, { event: { type: 'task_created' } }, r.clock.t);
  r.host.feed.append('inbox.item', CONVERSATION, { itemId: 'itm_x' }, r.clock.t);
  r.host.feed.append('conversation.created', CONVERSATION, {}, r.clock.t);
  await r.supervisor.settled();
  assert.equal((await active(r)).length, 0);
  await r.question('after');
  assert.equal((await active(r)).length, 1, 'the entries after the bad ones are still processed');
  await r.stop();
});

test('history from before the first start raises no items, except questions still waiting', async () => {
  const { FakeHost, Clock } = await import('./harness.js');
  const host = new FakeHost();
  const clock = new Clock();
  const old = clock.t - 60 * MINUTE;
  host.feed.append(
    'task.event',
    CONVERSATION,
    {
      seq: 1,
      at: old,
      event: {
        type: 'task_created',
        taskId: 'h',
        sessionId: 's',
        runner: 'r',
        mode: 'async',
        title: 'old',
      },
    },
    old,
  );
  host.feed.append(
    'task.event',
    CONVERSATION,
    { seq: 2, at: old, event: { type: 'task_succeeded', taskId: 'h', manifest: MANIFEST } },
    old,
  );
  host.feed.append(
    'conductor.question',
    CONVERSATION,
    {
      questionId: 'waiting',
      reason: 'taste',
      question: 'Still open?',
      options: [{ id: 'a', label: 'A' }],
      recommended: 'a',
    },
    old,
  );
  const r = await rig({ host, clock });
  await r.supervisor.settled();
  const items = await active(r);
  assert.deepEqual(
    items.map((item) => item.kind),
    ['decision'],
    'no finished item for old work, but the open question is listed',
  );
  await r.stop();
});
