import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CONVERSATION, firstItem, rig } from './harness.js';

const ASK =
  'Your daily spending limit of $5.00 is used up, so work that needs the model has stopped.';

test('a spending limit that stopped work raises one budget item that interrupts, however often it is hit', async () => {
  const r = await rig();
  r.supervisor.raiseCapHit({
    conversationId: CONVERSATION,
    taskId: 'tsk_1',
    key: 'invite_daily:inv_a:2026-10-20',
    ask: ASK,
  });
  r.supervisor.raiseCapHit({
    conversationId: CONVERSATION,
    key: 'invite_daily:inv_a:2026-10-20',
    ask: ASK,
  });
  await r.supervisor.settled();
  const items = r.supervisor.listItems({ state: 'open' }).items;
  assert.equal(items.length, 1, 'the second hit of the same limit changed nothing');
  assert.equal(items[0]?.kind, 'budget');
  assert.equal(items[0]?.ask, ASK);
  assert.equal(items[0]?.interrupts, true);
  assert.deepEqual(
    items[0]?.options.map((option) => option.id),
    ['ok'],
  );
  assert.equal(r.host.interrupts.length, 1, 'the human is told once');

  // Another limit is another item.
  r.supervisor.raiseCapHit({
    conversationId: CONVERSATION,
    key: 'server_daily:server:2026-10-20',
    ask: 'The server’s daily spending limit is used up.',
  });
  await r.supervisor.settled();
  assert.equal(r.supervisor.listItems({ state: 'open' }).items.length, 2);
  // The periodic pass does not close an item that is still true.
  await r.supervisor.tick();
  assert.equal(r.supervisor.listItems({ state: 'open' }).items.length, 2);
  await r.stop();
});

test('acknowledging a limit item closes it and sends nothing to the conductor', async () => {
  const r = await rig();
  r.supervisor.raiseCapHit({
    conversationId: CONVERSATION,
    key: 'invite_monthly:inv_a:2026-10',
    ask: ASK,
  });
  await r.supervisor.settled();
  const item = await firstItem(r);
  const result = await r.supervisor.answer({
    itemId: item.itemId,
    answerId: `ans_${randomUUID().replaceAll('-', '')}`,
    optionId: 'ok',
    preconditionHash: item.preconditionHash,
  });
  assert.equal(result.ok && result.item.state, 'closed');
  assert.equal(result.ok && result.item.closeReason, 'acknowledged');
  assert.equal(r.host.deliveries.length + r.host.posted.length, 0);
  await r.stop();
});

test('a limit hit after the supervisor stopped is dropped without an error', async () => {
  const r = await rig();
  await r.stop();
  assert.doesNotThrow(() =>
    r.supervisor.raiseCapHit({ conversationId: CONVERSATION, key: 'k', ask: ASK }),
  );
});
