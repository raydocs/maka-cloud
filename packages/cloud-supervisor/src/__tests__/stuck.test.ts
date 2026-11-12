import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONVERSATION, firstItem, rig } from './harness.js';

test('raiseStuck opens one blocked item per worker with local T33 options', async () => {
  const r = await rig();
  const input = {
    conversationId: CONVERSATION,
    workerId: 'wrk_1',
    ask: 'This worker is stuck (stuck). Tried: nothing recorded. Where: No progress.',
    options: [
      { id: 'narrow', label: 'Narrow the scope and try a different approach', recommended: true },
      { id: 'stop', label: 'Stop here and keep what was done', recommended: false },
    ],
  };
  assert.equal(r.supervisor.raiseStuck(input), true);
  assert.equal(r.supervisor.raiseStuck(input), true);
  await r.supervisor.settled();
  const items = r.supervisor.listItems({ state: 'open' }).items;
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, 'blocked');
  assert.equal(items[0]?.ask, input.ask);
  assert.deepEqual(
    items[0]?.options.map((option) => option.id),
    ['narrow', 'stop'],
  );
  const item = await firstItem(r);
  const answered = await r.supervisor.answer({
    itemId: item.itemId,
    answerId: 'ans_stuck_1',
    optionId: 'stop',
    preconditionHash: item.preconditionHash,
  });
  assert.equal(answered.ok && answered.item.state, 'closed');
  assert.equal(answered.ok && answered.item.closeReason, 'acknowledged');
  assert.equal(r.host.deliveries.length + r.host.posted.length, 0, 'a tap grants nothing');
  await r.stop();
});

test('raiseStuck after stop raises nothing', async () => {
  const r = await rig();
  await r.stop();
  assert.equal(
    r.supervisor.raiseStuck({
      conversationId: CONVERSATION,
      workerId: 'wrk_x',
      ask: 'stuck',
      options: [{ id: 'stop', label: 'Stop', recommended: true }],
    }),
    false,
  );
});
