import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONVERSATION,
  FakeHost,
  Gate,
  MANIFEST,
  MINUTE,
  firstItem,
  rig,
  tmpDb,
} from './harness.js';

let counter = 0;
const answerId = () => `ans_${++counter}`;

async function answerFirst(
  r: Awaited<ReturnType<typeof rig>>,
  optionId: string,
  extra: { text?: string; answer?: string; hash?: string } = {},
  predicate?: (item: { kind: string }) => boolean,
) {
  const item = await firstItem(r, predicate);
  return r.supervisor.answer({
    itemId: item.itemId,
    answerId: extra.answer ?? answerId(),
    optionId,
    ...(extra.text === undefined ? {} : { text: extra.text }),
    preconditionHash: extra.hash ?? item.preconditionHash,
  });
}

test('an answer reaches the conductor once and closes the item', async () => {
  const r = await rig();
  await r.question('q1');
  const result = await answerFirst(r, 'b', { text: 'because' });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.item.state, 'closed');
  assert.equal(result.ok && result.item.closeReason, 'answered');
  assert.deepEqual(r.host.deliveries, [
    { conversationId: CONVERSATION, questionId: 'q1', optionId: 'b', text: 'because' },
  ]);
  assert.equal(r.host.applied.get('q1'), 'b');
  await r.stop();
});

test('submitting the same answer again returns the first outcome and delivers nothing more', async () => {
  const r = await rig();
  await r.question('q1');
  const item = await firstItem(r);
  const request = {
    itemId: item.itemId,
    answerId: 'same',
    optionId: 'a',
    preconditionHash: item.preconditionHash,
  };
  const first = await r.supervisor.answer(request);
  const second = await r.supervisor.answer(request);
  assert.equal(first.ok && first.duplicate, false);
  assert.equal(second.ok && second.duplicate, true);
  assert.equal(r.host.deliveries.length, 1);
  const other = await r.supervisor.answer({ ...request, answerId: 'other' });
  assert.deepEqual([other.ok, !other.ok && other.reason], [false, 'already_answered']);
  const different = await r.supervisor.answer({ ...request, optionId: 'b' });
  assert.deepEqual([different.ok, !different.ok && different.reason], [false, 'already_answered']);
  assert.equal(r.host.deliveries.length, 1);
  await r.stop();
});

test('two answers racing while a delivery is in flight deliver once', async () => {
  const r = await rig();
  await r.question('q1');
  const item = await firstItem(r);
  const gate = new Gate();
  const entered = new Gate();
  r.host.script.deliver = async (delivery) => {
    entered.resolve();
    await gate.promise;
    return r.host.conductor(delivery);
  };
  const base = { itemId: item.itemId, preconditionHash: item.preconditionHash };
  const one = r.supervisor.answer({ ...base, answerId: 'one', optionId: 'a' });
  await entered.promise;
  const two = await r.supervisor.answer({ ...base, answerId: 'two', optionId: 'b' });
  assert.equal(two.ok, false, 'the second answer is refused while the first is being delivered');
  assert.equal(!two.ok && two.reason, 'already_answered');
  assert.equal(!two.ok && two.item?.state, 'answering');
  gate.resolve();
  const first = await one;
  assert.equal(first.ok && first.item.state, 'closed');
  assert.equal(r.host.deliveries.length, 1);
  assert.equal(r.host.applied.get('q1'), 'a');
  await r.stop();
});

test('a delivery that failed after the conductor applied it is retried and counts once', async () => {
  const r = await rig();
  await r.question('q1');
  let calls = 0;
  r.host.script.deliver = async (delivery) => {
    calls += 1;
    const outcome = r.host.conductor(delivery);
    if (calls === 1) throw new Error('the response was lost');
    return outcome;
  };
  const first = await answerFirst(r, 'a');
  assert.equal(first.ok && first.item.state, 'answering');
  assert.equal(first.ok && first.item.delivery, 'retrying');
  await r.supervisor.tick();
  assert.equal(calls, 1, 'the retry waits for its backoff');
  r.clock.advance(5 * MINUTE);
  await r.supervisor.tick();
  assert.equal(calls, 2);
  const [item] = r.supervisor.listItems({ state: 'closed' }).items;
  assert.equal(item?.closeReason, 'answered');
  assert.equal(r.host.applied.get('q1'), 'a');
  assert.equal(r.host.deliveries.length, 2, 'sent twice, applied once');
  await r.stop();
});

test('a crash between delivery and close repeats the delivery after a restart, which is a no-op', async () => {
  const dbPath = tmpDb();
  const host = new FakeHost();
  const first = await rig({ host, dbPath });
  await first.question('q1');
  const item = await firstItem(first);
  const entered = new Gate();
  host.script.deliver = async (delivery, signal) => {
    host.conductor(delivery); // the conductor applied it
    entered.resolve();
    await new Promise<void>((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('process stopped'))),
    );
    return { accepted: true, duplicate: false };
  };
  const pending = first.supervisor.answer({
    itemId: item.itemId,
    answerId: 'crash',
    optionId: 'a',
    preconditionHash: item.preconditionHash,
  });
  await entered.promise;
  await first.stop(); // the process ends before the supervisor recorded the result
  const lost = await pending;
  assert.equal(lost.ok && lost.item.state, 'answering');

  host.script.deliver = undefined;
  const second = await rig({ host, dbPath, clock: first.clock });
  second.clock.advance(5 * MINUTE);
  await second.supervisor.tick();
  const [closed] = second.supervisor.listItems({ state: 'closed' }).items;
  assert.equal(closed?.closeReason, 'answered');
  assert.equal(host.applied.get('q1'), 'a');
  assert.equal(host.deliveries.length, 2);
  await second.stop();
});

test('an inline answer that landed first closes the item and the inbox answer delivers nothing', async () => {
  const r = await rig();
  await r.question('q1');
  const item = await firstItem(r);
  await r.answered('q1', 'b');
  const result = await r.supervisor.answer({
    itemId: item.itemId,
    answerId: answerId(),
    optionId: 'a',
    preconditionHash: item.preconditionHash,
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'closed');
  assert.equal(!result.ok && result.item?.closeReason, 'handled_elsewhere');
  assert.equal(r.host.deliveries.length, 0);
  await r.stop();
});

test('an inline answer the feed has not shown yet: a different option is a conflict, the same is a duplicate', async () => {
  const r = await rig();
  await r.question('q1');
  await r.question('q2');
  r.host.applied.set('q1', 'b');
  r.host.applied.set('q2', 'a');
  const q1 = await firstItem(r, (item) => (item as { ask?: string }).ask?.includes('q1') === true);
  const conflict = await r.supervisor.answer({
    itemId: q1.itemId,
    answerId: answerId(),
    optionId: 'a',
    preconditionHash: q1.preconditionHash,
  });
  assert.equal(conflict.ok && conflict.item.closeReason, 'handled_elsewhere');
  const q2 = await firstItem(r, (item) => (item as { ask?: string }).ask?.includes('q2') === true);
  const same = await r.supervisor.answer({
    itemId: q2.itemId,
    answerId: answerId(),
    optionId: 'a',
    preconditionHash: q2.preconditionHash,
  });
  assert.equal(same.ok && same.item.closeReason, 'answered');
  await r.stop();
});

test('a refused delivery closes the item without claiming it was answered', async () => {
  const r = await rig();
  await r.question('q1');
  r.host.script.deliver = async () => ({ accepted: false, reason: 'not_open' });
  const result = await answerFirst(r, 'a');
  assert.equal(result.ok && result.item.closeReason, 'condition_cleared');
  await r.stop();
});

test('a stale hash delivers nothing and returns the refreshed item; the second try with the new hash goes through', async () => {
  const r = await rig();
  await r.taskCreated('p', { title: 'parent' });
  await r.taskCreated('a', { parent: 'p', title: 'run tests' });
  await r.taskEvent({ type: 'task_failed', taskId: 'a', reason: 'broke' });
  await r.taskCreated('b', { parent: 'p', title: 'run tests' });
  await r.taskEvent({ type: 'task_failed', taskId: 'b', reason: 'broke' });
  const seen = await firstItem(r, (item) => item.kind === 'blocked');
  await r.taskCreated('c', { parent: 'p', title: 'run tests' });
  await r.taskEvent({ type: 'task_failed', taskId: 'c', reason: 'broke' });
  const stale = await r.supervisor.answer({
    itemId: seen.itemId,
    answerId: 'try1',
    optionId: 'retry',
    preconditionHash: seen.preconditionHash,
  });
  assert.equal(!stale.ok && stale.reason, 'stale');
  assert.match(!stale.ok ? (stale.item?.ask ?? '') : '', /failed 3 times/);
  assert.equal(r.host.posted.length, 0);
  const fresh = !stale.ok ? stale.item : undefined;
  const ok = await r.supervisor.answer({
    itemId: seen.itemId,
    answerId: 'try2',
    optionId: 'retry',
    preconditionHash: fresh?.preconditionHash ?? '',
  });
  assert.equal(ok.ok, true);
  assert.equal(r.host.posted.length, 1);
  await r.stop();
});

test('a message option posts one built message, keyed by the answer id, with the human words after a delimiter', async () => {
  const r = await rig();
  await r.taskCreated('t', { title: 'Slow "report" job' });
  await r.taskEvent({ type: 'task_started', taskId: 't' });
  r.clock.advance(31 * MINUTE);
  await r.supervisor.tick();
  const item = await firstItem(r, (i) => i.kind === 'blocked');
  const request = {
    itemId: item.itemId,
    answerId: 'msg1',
    optionId: 'check',
    text: 'please be quick',
    preconditionHash: item.preconditionHash,
  };
  const result = await r.supervisor.answer(request);
  assert.equal(result.ok && result.item.closeReason, 'answered');
  assert.equal(r.host.posted.length, 1);
  const [message] = r.host.posted;
  assert.equal(message?.clientMessageId, 'inbox-msg1');
  assert.equal(message?.conversationId, CONVERSATION);
  assert.match(
    message?.text ?? '',
    /^From my inbox: the task “Slow 'report' job” \(t\) has had no progress for 31 minutes/,
  );
  assert.match(message?.text ?? '', /The user wrote: "please be quick"$/);
  await r.supervisor.answer(request);
  assert.equal(r.host.posted.length, 1, 'a repeat posts nothing');
  await r.stop();
});

test('a message is never posted over an open question, which a message would dismiss', async () => {
  const r = await rig();
  await r.taskCreated('t', { title: 'job' });
  await r.taskEvent({ type: 'task_started', taskId: 't' });
  r.clock.advance(31 * MINUTE);
  await r.supervisor.tick();
  await r.question('q1');
  const item = await firstItem(r, (i) => i.kind === 'blocked');
  const result = await r.supervisor.answer({
    itemId: item.itemId,
    answerId: answerId(),
    optionId: 'check',
    preconditionHash: item.preconditionHash,
  });
  assert.equal(!result.ok && result.reason, 'question_open');
  assert.equal(r.host.posted.length, 0);
  const local = await r.supervisor.answer({
    itemId: item.itemId,
    answerId: answerId(),
    optionId: 'wait',
    preconditionHash: item.preconditionHash,
  });
  assert.equal(
    local.ok && local.item.closeReason,
    'acknowledged',
    'a local choice needs no message',
  );
  await r.stop();
});

test('local choices record the decision and send nothing', async () => {
  const r = await rig();
  await r.taskCreated('t', { title: 'research' });
  await r.taskEvent({
    type: 'task_succeeded',
    taskId: 't',
    manifest: { ...MANIFEST, confidence: 'low' },
  });
  const result = await answerFirst(r, 'accept');
  assert.equal(result.ok && result.item.closeReason, 'accepted');
  await r.taskCreated('u', { title: 'other' });
  await r.taskEvent({ type: 'task_succeeded', taskId: 'u', manifest: MANIFEST });
  const finished = await answerFirst(r, 'ok', {}, (item) => item.kind === 'finished');
  assert.equal(finished.ok && finished.item.closeReason, 'acknowledged');
  assert.equal(r.host.deliveries.length + r.host.posted.length, 0);
  await r.stop();
});

test('free text only goes where the item takes it, within the limit', async () => {
  const r = await rig();
  await r.question('q_approve', 'irreversible');
  const refused = await answerFirst(r, 'a', { text: 'sure, go ahead' });
  assert.equal(!refused.ok && refused.reason, 'text_not_allowed');
  assert.equal(r.host.deliveries.length, 0);
  await r.question('q_taste', 'taste');
  const long = await answerFirst(
    r,
    'a',
    { text: 'x'.repeat(4001) },
    (item) => item.kind === 'decision',
  );
  assert.equal(!long.ok && long.reason, 'text_too_long');
  const unknown = await answerFirst(r, 'nope', {}, (item) => item.kind === 'decision');
  assert.equal(!unknown.ok && unknown.reason, 'invalid_option');
  const missing = await r.supervisor.answer({
    itemId: 'itm_missing',
    answerId: answerId(),
    optionId: 'a',
    preconditionHash: 'x',
  });
  assert.equal(!missing.ok && missing.reason, 'not_found');
  const bad = await r.supervisor.answer({
    itemId: 'itm_missing',
    answerId: 'bad id!',
    optionId: 'a',
    preconditionHash: 'x',
  });
  assert.equal(!bad.ok && bad.reason, 'invalid_request');
  await r.stop();
});

test('an answer after stop is refused', async () => {
  const r = await rig();
  await r.question('q1');
  const item = await firstItem(r);
  await r.stop();
  const result = await r.supervisor.answer({
    itemId: item.itemId,
    answerId: 'late',
    optionId: 'a',
    preconditionHash: item.preconditionHash,
  });
  assert.equal(!result.ok && result.reason, 'stopped');
});

test('the caller is stored with the answer and handed to the host with every delivery attempt', async () => {
  const r = await rig();
  await r.question('q1');
  let failures = 1;
  r.host.script.deliver = async (delivery) => {
    if (failures-- > 0) throw new Error('the conductor is busy');
    return r.host.conductor(delivery);
  };
  const item = await firstItem(r);
  const first = await r.supervisor.answer({
    itemId: item.itemId,
    answerId: answerId(),
    optionId: 'a',
    preconditionHash: item.preconditionHash,
    caller: 'inv_a',
  });
  assert.equal(first.ok && first.item.state, 'answering');
  r.clock.advance(MINUTE);
  await r.supervisor.tick();
  assert.deepEqual(
    r.host.deliveries.map((delivery) => delivery.caller),
    ['inv_a', 'inv_a'],
  );
  assert.equal(r.supervisor.getItem(item.itemId)?.closeReason, 'answered');
  await r.stop();
});

test('outside the caller conversations an item is not listed and answering it is not_found', async () => {
  const r = await rig();
  await r.question('q1');
  const item = await firstItem(r);
  assert.deepEqual(r.supervisor.listItems({ conversations: ['cnv_other'] }).items, []);
  assert.deepEqual(r.supervisor.listItems({ conversations: [] }).items, []);
  assert.equal(r.supervisor.listItems({ conversations: [CONVERSATION] }).items.length, 1);
  const refused = await r.supervisor.answer({
    itemId: item.itemId,
    answerId: answerId(),
    optionId: 'a',
    preconditionHash: item.preconditionHash,
    caller: 'inv_b',
    conversations: ['cnv_other'],
  });
  assert.deepEqual(refused, { ok: false, reason: 'not_found' });
  assert.deepEqual(r.host.deliveries, []);
  assert.equal(r.supervisor.getItem(item.itemId)?.state, 'open');
  const accepted = await r.supervisor.answer({
    itemId: item.itemId,
    answerId: answerId(),
    optionId: 'a',
    preconditionHash: item.preconditionHash,
    caller: 'inv_a',
    conversations: [CONVERSATION],
  });
  assert.equal(accepted.ok && accepted.item.closeReason, 'answered');
  await r.stop();
});

test('a message the host refuses for its caller closes the item without delivery', async () => {
  const r = await rig();
  await r.taskCreated('t', { title: 'job' });
  await r.taskEvent({ type: 'task_started', taskId: 't' });
  r.clock.advance(31 * MINUTE);
  await r.supervisor.tick();
  const item = await firstItem(r, (i) => i.kind === 'blocked');
  r.host.refusedCallers.add('inv_gone');
  const result = await r.supervisor.answer({
    itemId: item.itemId,
    answerId: 'msg_refused',
    optionId: 'check',
    preconditionHash: item.preconditionHash,
    caller: 'inv_gone',
  });
  assert.equal(result.ok && result.item.closeReason, 'condition_cleared');
  assert.deepEqual(r.host.posted, []);
  await r.stop();
});
