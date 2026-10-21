import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stableHash } from '../cards/hash.js';
import { MIN_TASKS_FOR_TYPICAL, TASKS_FOR_TYPICAL } from '../cards/store.js';
import { DAY, OWNER, rig } from './harness.js';

const card = (n: number, over: Record<string, unknown> = {}) => ({
  kind: 'fix_main_ci',
  subjectKey: `s${n}`,
  title: `Fix the failing test ${n}`,
  detail: 'CI has failed.',
  brief: 'Fix it.',
  estimateUsd: 3,
  preconditionHash: stableHash({ n }),
  external: false,
  ...over,
});

/** Proposes, accepts, attaches a conversation and settles one card on a day of its own. */
async function finished(
  r: Awaited<ReturnType<typeof rig>>,
  n: number,
  outcome: 'completed' | 'failed' | 'stopped' | 'abandoned',
  spent: number,
  kind = 'fix_main_ci',
) {
  r.clock.t += DAY;
  const made = r.engine.cards.propose(OWNER, r.projectId, card(n, { kind }));
  assert.ok(made.ok);
  assert.ok(r.engine.cards.accept(OWNER, made.card.cardId).ok);
  assert.ok(r.engine.cards.attachConversation(OWNER, made.card.cardId, `cnv_${n}`));
  r.clock.t += 1000;
  assert.equal(r.engine.cards.settle(made.card.cardId, outcome, spent), true);
  return made.card;
}

test('a card is settled once, with what its task spent and how it ended', async () => {
  const r = await rig();
  const made = r.engine.cards.propose(OWNER, r.projectId, card(1));
  assert.ok(made.ok);
  const { cardId } = made.card;
  assert.deepEqual(r.engine.cards.unsettled(), [], 'an open card has no task');
  assert.deepEqual(r.engine.cards.unstarted(), []);
  r.engine.cards.accept(OWNER, cardId);
  assert.deepEqual(
    r.engine.cards.unstarted().map((c) => c.cardId),
    [cardId],
    'spent, no task yet',
  );
  r.engine.cards.attachConversation(OWNER, cardId, 'cnv_1');
  assert.deepEqual(r.engine.cards.unstarted(), []);
  assert.deepEqual(
    r.engine.cards.unsettled().map((c) => c.cardId),
    [cardId],
  );
  assert.equal(r.engine.cards.settle(cardId, 'completed', 2.5), true);
  assert.equal(
    r.engine.cards.settle(cardId, 'failed', 9),
    false,
    'the second answer changes nothing',
  );
  const after = r.engine.cards.get(OWNER, cardId);
  assert.equal(after?.spentUsd, 2.5);
  assert.equal(after?.outcome, 'completed');
  assert.ok(after?.settledAt);
  assert.deepEqual(r.engine.cards.unsettled(), []);
  r.cleanup();
});

test('only an accepted card can be settled, and not with a spend that makes no sense', async () => {
  const r = await rig();
  const made = r.engine.cards.propose(OWNER, r.projectId, card(1));
  assert.ok(made.ok);
  assert.equal(r.engine.cards.settle(made.card.cardId, 'completed', 1), false, 'still open');
  r.engine.cards.accept(OWNER, made.card.cardId);
  assert.equal(r.engine.cards.settle(made.card.cardId, 'completed', -1), false);
  assert.equal(r.engine.cards.settle(made.card.cardId, 'completed', Number.NaN), false);
  assert.equal(r.engine.cards.settle('card_nope', 'completed', 1), false);
  assert.equal(r.engine.cards.get(OWNER, made.card.cardId)?.outcome, null);
  r.cleanup();
});

test('the typical cost is the median of the last five tasks that ran, once three have', async () => {
  const r = await rig();
  assert.equal(r.engine.cards.typicalUsd(OWNER, 'fix_main_ci'), undefined);
  await finished(r, 1, 'completed', 1);
  await finished(r, 2, 'completed', 5);
  assert.equal(r.engine.cards.typicalUsd(OWNER, 'fix_main_ci'), undefined, 'two say too little');
  await finished(r, 3, 'failed', 2);
  assert.equal(MIN_TASKS_FOR_TYPICAL, 3);
  assert.equal(
    r.engine.cards.typicalUsd(OWNER, 'fix_main_ci'),
    2,
    'a failed task still cost money',
  );
  await finished(r, 4, 'completed', 4);
  assert.equal(r.engine.cards.typicalUsd(OWNER, 'fix_main_ci'), 3, 'the middle two, averaged');
  // A stopped task, an abandoned one and a free one say nothing about cost.
  await finished(r, 5, 'stopped', 100);
  await finished(r, 6, 'abandoned', 0);
  await finished(r, 7, 'completed', 0);
  assert.equal(r.engine.cards.typicalUsd(OWNER, 'fix_main_ci'), 3);
  // Only the last five count: older, cheaper tasks move out of the window.
  await finished(r, 8, 'completed', 10);
  await finished(r, 9, 'completed', 10);
  await finished(r, 10, 'completed', 10);
  assert.equal(TASKS_FOR_TYPICAL, 5);
  assert.equal(r.engine.cards.typicalUsd(OWNER, 'fix_main_ci'), 10, 'last five: 2, 4, 10, 10, 10');
  // Another kind and another owner keep their own history.
  assert.equal(r.engine.cards.typicalUsd(OWNER, 'rebase_pr'), undefined);
  assert.equal(r.engine.cards.typicalUsd('inv_other', 'fix_main_ci'), undefined);
  r.cleanup();
});

test('a typical cost is capped at what a card may estimate and shown as typical', async () => {
  const r = await rig();
  for (let n = 1; n <= 3; n += 1) await finished(r, n, 'completed', 80);
  assert.equal(r.engine.cards.typicalUsd(OWNER, 'fix_main_ci'), 50);
  r.clock.t += DAY;
  const made = r.engine.cards.propose(
    OWNER,
    r.projectId,
    card(20, { typical: true, estimateUsd: 4 }),
  );
  assert.ok(made.ok);
  assert.equal(made.card.typical, true);
  const plain = r.engine.cards.propose(OWNER, r.projectId, card(21));
  assert.ok(plain.ok);
  assert.equal(plain.card.typical, false);
  r.cleanup();
});

test('the last scan of a project is remembered, and only the projects not removed are walked', async () => {
  const r = await rig();
  assert.equal(r.engine.cards.lastScan(r.projectId), undefined);
  r.engine.cards.markScanned(r.projectId);
  assert.equal(r.engine.cards.lastScan(r.projectId), r.clock.now());
  r.clock.advance(DAY);
  r.engine.cards.markScanned(r.projectId);
  assert.equal(r.engine.cards.lastScan(r.projectId), r.clock.now(), 'it moves forward');
  assert.deepEqual(r.engine.activeProjects(), [{ owner: OWNER, projectId: r.projectId }]);
  assert.ok(r.engine.removeProject(OWNER, r.projectId));
  assert.deepEqual(r.engine.activeProjects(), []);
  r.cleanup();
});
