import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { ProposalOutcome } from '../host.js';
import { CONVERSATION, Gate, MINUTE, type Rig, rig } from './harness.js';

const SETS = [
  { id: 'read-only', label: 'Only watch and report', recommended: false },
  { id: 'recommended', label: 'Fix CI and answer reviews', recommended: true },
  { id: 'none', label: 'No standing duties for now', recommended: false },
];

function withEngine(
  r: Rig,
  decide?: (id: string, set: string) => ProposalOutcome | Error | undefined,
) {
  const calls: Array<{ proposalId: string; setId: string; caller?: string }> = [];
  const applied = new Map<string, string>();
  r.host.proposals = {
    decide: async (decision) => {
      calls.push(decision);
      const scripted = decide?.(decision.proposalId, decision.setId);
      if (scripted instanceof Error) throw scripted;
      if (scripted) return scripted;
      const earlier = applied.get(decision.proposalId);
      if (earlier === undefined) {
        applied.set(decision.proposalId, decision.setId);
        return { accepted: true, duplicate: false };
      }
      return earlier === decision.setId
        ? { accepted: true, duplicate: true }
        : { accepted: false, reason: 'conflict' };
    },
  };
  return { calls, applied };
}

const raise = (r: Rig, proposalId = 'prp_1') =>
  r.supervisor.raiseProposal({
    conversationId: CONVERSATION,
    proposalId,
    ask: 'Set up standing duties for a/b?',
    sets: SETS,
  });

const answer = async (r: Rig, optionId: string, caller = 'inv_a') => {
  const [item] = r.supervisor.listItems({ state: 'open' }).items;
  assert.ok(item, 'an item is open');
  return r.supervisor.answer({
    itemId: item.itemId,
    answerId: `ans_${randomUUID().replaceAll('-', '')}`,
    optionId,
    preconditionHash: item.preconditionHash,
    caller,
  });
};

test('without a duties engine no proposal item is raised', async () => {
  const r = await rig();
  assert.equal(raise(r), false);
  await r.supervisor.settled();
  assert.equal(r.supervisor.listItems({ state: 'all' }).items.length, 0);
  await r.stop();
});

test('a proposal raises one decision item that interrupts, recommended option first, however often it is raised', async () => {
  const r = await rig();
  withEngine(r);
  assert.equal(raise(r), true);
  assert.equal(raise(r), true);
  await r.supervisor.settled();
  const items = r.supervisor.listItems({ state: 'open' }).items;
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, 'decision');
  assert.equal(items[0]?.interrupts, true);
  assert.deepEqual(
    items[0]?.options.map((option) => [option.id, option.recommended]),
    [
      ['set-recommended', true],
      ['set-read-only', false],
      ['set-none', false],
    ],
  );
  assert.equal(r.host.interrupts.length, 1, 'the human is told once');
  // Another proposal is another item.
  raise(r, 'prp_2');
  await r.supervisor.settled();
  assert.equal(r.supervisor.listItems({ state: 'open' }).items.length, 2);
  await r.stop();
});

test('choosing a set tells the engine that set for that proposal once, and closes the item', async () => {
  const r = await rig();
  const engine = withEngine(r);
  raise(r);
  await r.supervisor.settled();
  const result = await answer(r, 'set-read-only');
  assert.equal(result.ok && result.item.state, 'closed');
  assert.equal(result.ok && result.item.closeReason, 'answered');
  assert.deepEqual(engine.calls, [{ proposalId: 'prp_1', setId: 'read-only', caller: 'inv_a' }]);
  assert.equal(r.host.posted.length + r.host.deliveries.length, 0, 'nothing goes to the conductor');
  await r.stop();
});

test('a decision that failed in delivery is retried after its backoff and the engine applies it once', async () => {
  const r = await rig();
  let attempts = 0;
  const engine = withEngine(r, () => {
    attempts += 1;
    return attempts === 1 ? new Error('the engine is restarting') : undefined;
  });
  raise(r);
  await r.supervisor.settled();
  const first = await answer(r, 'set-recommended');
  assert.equal(first.ok && first.item.state, 'answering');
  await r.supervisor.tick();
  assert.equal(engine.calls.length, 1, 'the retry waits for its backoff');
  r.clock.advance(5 * MINUTE);
  await r.supervisor.tick();
  assert.equal(engine.calls.length, 2);
  assert.equal(engine.applied.get('prp_1'), 'recommended');
  const [item] = r.supervisor.listItems({ state: 'closed' }).items;
  assert.equal(item?.closeReason, 'answered');
  await r.stop();
});

test('a proposal already decided differently elsewhere closes the item as handled elsewhere', async () => {
  const r = await rig();
  withEngine(r, () => ({ accepted: false, reason: 'conflict' }));
  raise(r);
  await r.supervisor.settled();
  const result = await answer(r, 'set-none');
  assert.equal(result.ok && result.item.closeReason, 'handled_elsewhere');
  await r.stop();
});

test('a second answer is refused while the first is being delivered, and the engine is asked once', async () => {
  const r = await rig();
  const gate = new Gate();
  const entered = new Gate();
  const engine = withEngine(r);
  const real = r.host.proposals?.decide;
  r.host.proposals = {
    decide: async (decision, signal) => {
      entered.resolve();
      await gate.promise;
      return (real as NonNullable<typeof real>)(decision, signal);
    },
  };
  raise(r);
  await r.supervisor.settled();
  const one = answer(r, 'set-recommended');
  await entered.promise;
  const two = await answer(r, 'set-none');
  assert.equal(two.ok, false);
  assert.equal(!two.ok && two.reason, 'already_answered');
  gate.resolve();
  const first = await one;
  assert.equal(first.ok && first.item.state, 'closed');
  assert.equal(engine.calls.length, 1);
  await r.stop();
});

test("another caller's conversation cannot answer the item", async () => {
  const r = await rig();
  const engine = withEngine(r);
  raise(r);
  await r.supervisor.settled();
  const [item] = r.supervisor.listItems({ state: 'open' }).items;
  const result = await r.supervisor.answer({
    itemId: item?.itemId ?? '',
    answerId: `ans_${randomUUID().replaceAll('-', '')}`,
    optionId: 'set-recommended',
    preconditionHash: item?.preconditionHash ?? '',
    conversations: ['cnv_other'],
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'not_found');
  assert.equal(engine.calls.length, 0);
  await r.stop();
});

test('a proposal item survives a restart, and a pending decision is delivered after it', async () => {
  const { tmpDb, FakeHost } = await import('./harness.js');
  const dbPath = tmpDb();
  const host = new FakeHost();
  const first = await rig({ host, dbPath });
  withEngine(first);
  raise(first);
  await first.supervisor.settled();
  await first.stop();
  const second = await rig({ host, dbPath });
  const engine = withEngine(second);
  assert.equal(second.supervisor.listItems({ state: 'open' }).items.length, 1);
  assert.equal(raise(second), true, 'raising it again after the restart adds nothing');
  await second.supervisor.settled();
  assert.equal(second.supervisor.listItems({ state: 'open' }).items.length, 1);
  const result = await answer(second, 'set-recommended');
  assert.equal(result.ok && result.item.state, 'closed');
  assert.equal(engine.calls.length, 1);
  await second.stop();
});
