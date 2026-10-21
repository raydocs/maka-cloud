import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { SuggestionCheck, SuggestionOutcome } from '../host.js';
import type { SuggestionChoice } from '../rules.js';
import { CONVERSATION, Gate, MINUTE, type Rig, rig } from './harness.js';

const choice = (over: Partial<SuggestionChoice> = {}): SuggestionChoice => ({
  lineage: 'proj_1:rebase_pr:pr:12',
  conversationId: CONVERSATION,
  cardId: 'card_1',
  title: 'Rebase PR #12, it conflicts with main',
  facts: {
    kind: 'rebase_pr',
    mode: 'quick',
    estimateUsd: 1,
    repo: 'acme/widgets',
    detail: 'PR #12 "Add retries" cannot be merged as it is.',
    external: true,
  },
  ...over,
});

/** A cards service that records what it is asked and answers as scripted. */
function withCards(
  r: Rig,
  script: {
    verify?: (cardId: string) => SuggestionCheck | Error;
    decide?: (cardId: string, action: string) => SuggestionOutcome | Error | undefined;
  } = {},
) {
  const verified: string[] = [];
  const decided: Array<{ cardId: string; action: string; caller?: string }> = [];
  const accepted = new Set<string>();
  r.host.suggestions = {
    verify: async (request) => {
      verified.push(request.cardId);
      const scripted = script.verify?.(request.cardId);
      if (scripted instanceof Error) throw scripted;
      return scripted ?? { state: 'fresh' };
    },
    decide: async (decision) => {
      decided.push(decision);
      const scripted = script.decide?.(decision.cardId, decision.action);
      if (scripted instanceof Error) throw scripted;
      if (scripted) return scripted;
      if (decision.action === 'accept') {
        const duplicate = accepted.has(decision.cardId);
        accepted.add(decision.cardId);
        return { accepted: true, duplicate };
      }
      return { accepted: true, duplicate: false };
    },
  };
  return { verified, decided, accepted };
}

const open = (r: Rig) => r.supervisor.listItems({ state: 'open' }).items;
const tap = (
  r: Rig,
  optionId: string,
  over: { answerId?: string; hash?: string; caller?: string } = {},
) => {
  const [item] = open(r);
  assert.ok(item, 'an item is open');
  return r.supervisor.answer({
    itemId: item.itemId,
    answerId: over.answerId ?? `ans_${randomUUID().replaceAll('-', '')}`,
    optionId,
    preconditionHash: over.hash ?? item.preconditionHash,
    caller: over.caller ?? 'inv_a',
  });
};

test('without a cards service no suggestion item is raised', async () => {
  const r = await rig();
  assert.equal(r.supervisor.raiseSuggestion(choice()), false);
  await r.supervisor.settled();
  assert.equal(r.supervisor.listItems({ state: 'all' }).items.length, 0);
  await r.stop();
});

test('a suggestion is one item that never interrupts, shows its title and facts, and is one item however often it is raised', async () => {
  const r = await rig();
  withCards(r);
  assert.equal(r.supervisor.raiseSuggestion(choice()), true);
  assert.equal(r.supervisor.raiseSuggestion(choice()), true);
  await r.supervisor.settled();
  const items = open(r);
  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item?.kind, 'suggestion');
  assert.equal(item?.interrupts, false);
  assert.equal(item?.ask, 'Rebase PR #12, it conflicts with main');
  assert.deepEqual(
    item?.options.map((o) => [o.id, o.label, o.recommended]),
    [
      ['do', 'Do it', true],
      ['later', 'Not now', false],
    ],
  );
  assert.deepEqual(item?.suggestion, choice().facts);
  assert.equal(item?.allowText, false);
  assert.equal(r.host.interrupts.length, 0, 'nobody is pushed');
  await r.stop();
});

test('a refreshed card updates the same item in place, with a new hash and version', async () => {
  const r = await rig();
  withCards(r);
  r.supervisor.raiseSuggestion(choice());
  await r.supervisor.settled();
  const [before] = open(r);
  r.supervisor.raiseSuggestion(choice({ cardId: 'card_2', title: 'Rebase PR #12 again' }));
  await r.supervisor.settled();
  const after = open(r);
  assert.equal(after.length, 1);
  assert.equal(after[0]?.itemId, before?.itemId);
  assert.equal(after[0]?.ask, 'Rebase PR #12 again');
  assert.notEqual(after[0]?.preconditionHash, before?.preconditionHash);
  assert.ok((after[0]?.version ?? 0) > (before?.version ?? 0));
  await r.stop();
});

test('"Do it" checks the card first, accepts it once and closes the item', async () => {
  const r = await rig();
  const cards = withCards(r);
  r.supervisor.raiseSuggestion(choice());
  await r.supervisor.settled();
  const answerId = `ans_${randomUUID().replaceAll('-', '')}`;
  const result = await tap(r, 'do', { answerId });
  assert.equal(result.ok && result.item.state, 'closed');
  assert.equal(result.ok && result.item.closeReason, 'answered');
  assert.deepEqual(cards.verified, ['card_1']);
  assert.deepEqual(cards.decided, [{ cardId: 'card_1', action: 'accept', caller: 'inv_a' }]);
  assert.equal(r.host.posted.length + r.host.deliveries.length, 0, 'nothing goes to the conductor');
  // The same tap again (a retry) is a duplicate and starts nothing.
  const [closed] = r.supervisor.listItems({ state: 'closed' }).items;
  const again = await r.supervisor.answer({
    itemId: closed?.itemId ?? '',
    answerId,
    optionId: 'do',
    preconditionHash: closed?.preconditionHash ?? '',
    caller: 'inv_a',
  });
  assert.equal(again.ok && again.duplicate, true);
  assert.equal(cards.decided.length, 1);
  await r.stop();
});

test('a card whose state moved is replaced in the item and the tap is refused as stale, not acted on', async () => {
  const r = await rig();
  let moved = true;
  const cards = withCards(r, {
    verify: () =>
      moved
        ? {
            state: 'refreshed',
            card: {
              ...choice({
                cardId: 'card_2',
                title: 'Rebase PR #12, it conflicts with main (moved)',
              }),
            },
          }
        : { state: 'fresh' },
  });
  r.supervisor.raiseSuggestion(choice());
  await r.supervisor.settled();
  const [seen] = open(r);
  const refused = await tap(r, 'do');
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.reason, 'stale');
  const shown = !refused.ok ? refused.item : undefined;
  assert.equal(shown?.ask, 'Rebase PR #12, it conflicts with main (moved)');
  assert.notEqual(shown?.preconditionHash, seen?.preconditionHash);
  assert.equal(shown?.state, 'open');
  assert.equal(cards.decided.length, 0, 'nothing was accepted');
  // The owner taps the refreshed card and it goes through.
  moved = false;
  const second = await tap(r, 'do', { hash: shown?.preconditionHash });
  assert.equal(second.ok && second.item.closeReason, 'answered');
  assert.deepEqual(
    cards.decided.map((d) => d.cardId),
    ['card_2'],
  );
  await r.stop();
});

test('a card whose work is gone closes the item and the tap does nothing', async () => {
  const r = await rig();
  const cards = withCards(r, { verify: () => ({ state: 'gone' }) });
  r.supervisor.raiseSuggestion(choice());
  await r.supervisor.settled();
  const result = await tap(r, 'do');
  assert.equal(!result.ok && result.reason, 'stale');
  assert.equal(!result.ok && result.item?.state, 'closed');
  assert.equal(!result.ok && result.item?.closeReason, 'condition_cleared');
  assert.equal(cards.decided.length, 0);
  assert.equal(open(r).length, 0);
  await r.stop();
});

test('a check that cannot be made refuses the tap and changes nothing, and the next tap works', async () => {
  const r = await rig();
  let down = true;
  const cards = withCards(r, {
    verify: () => (down ? new Error('GitHub is down') : { state: 'fresh' }),
  });
  r.supervisor.raiseSuggestion(choice());
  await r.supervisor.settled();
  const refused = await tap(r, 'do');
  assert.equal(!refused.ok && refused.reason, 'unavailable');
  assert.equal(open(r).length, 1, 'the item is still there');
  assert.equal(cards.decided.length, 0);
  assert.equal(r.host.warnings.length, 1);
  down = false;
  const ok = await tap(r, 'do');
  assert.equal(ok.ok && ok.item.closeReason, 'answered');
  assert.equal(cards.decided.length, 1);
  await r.stop();
});

test('"Not now" is not checked against the repository, and is told to the cards service once', async () => {
  const r = await rig();
  const cards = withCards(r, { verify: () => new Error('must not be called') });
  r.supervisor.raiseSuggestion(choice());
  await r.supervisor.settled();
  const result = await tap(r, 'later');
  assert.equal(result.ok && result.item.closeReason, 'answered');
  assert.deepEqual(cards.verified, []);
  assert.deepEqual(cards.decided, [{ cardId: 'card_1', action: 'dismiss', caller: 'inv_a' }]);
  await r.stop();
});

test('a tap on a hash the owner no longer sees is stale before anything is read', async () => {
  const r = await rig();
  const cards = withCards(r);
  r.supervisor.raiseSuggestion(choice());
  await r.supervisor.settled();
  const result = await tap(r, 'do', { hash: 'not-the-hash' });
  assert.equal(!result.ok && result.reason, 'stale');
  assert.deepEqual(cards.verified, []);
  assert.equal(cards.decided.length, 0);
  await r.stop();
});

test('a refusal from the cards service closes the item without applying anything; a failure is retried and applied once', async () => {
  const r = await rig();
  withCards(r, { decide: () => ({ accepted: false, reason: 'stale' }) });
  r.supervisor.raiseSuggestion(choice());
  await r.supervisor.settled();
  const refused = await tap(r, 'do');
  assert.equal(refused.ok && refused.item.closeReason, 'condition_cleared');
  await r.stop();

  const retry = await rig();
  let attempts = 0;
  const cards = withCards(retry, {
    decide: () => {
      attempts += 1;
      return attempts === 1 ? new Error('restarting') : undefined;
    },
  });
  retry.supervisor.raiseSuggestion(choice());
  await retry.supervisor.settled();
  const first = await tap(retry, 'do');
  assert.equal(first.ok && first.item.state, 'answering');
  retry.clock.advance(5 * MINUTE);
  await retry.supervisor.tick();
  assert.equal(cards.decided.length, 2);
  assert.deepEqual(cards.verified, ['card_1'], 'the retry does not check again');
  const [done] = retry.supervisor.listItems({ state: 'closed' }).items;
  assert.equal(done?.closeReason, 'answered');
  await retry.stop();
});

test('two taps at once check twice but accept once, and the second is refused', async () => {
  const r = await rig();
  const gate = new Gate();
  const entered = new Gate();
  let verifies = 0;
  const cards = withCards(r);
  const realVerify = r.host.suggestions?.verify;
  r.host.suggestions = {
    ...(r.host.suggestions as NonNullable<typeof r.host.suggestions>),
    verify: async (request, signal) => {
      verifies += 1;
      if (verifies === 2) entered.resolve();
      await gate.promise;
      return (realVerify as NonNullable<typeof realVerify>)(request, signal);
    },
  };
  r.supervisor.raiseSuggestion(choice());
  await r.supervisor.settled();
  const one = tap(r, 'do');
  const two = tap(r, 'do');
  await entered.promise;
  gate.resolve();
  const results = await Promise.all([one, two]);
  assert.equal(results.filter((x) => x.ok).length, 1);
  assert.equal(
    results.find((x) => !x.ok && x.reason === 'already_answered') !== undefined ||
      results.find((x) => !x.ok && x.reason === 'closed') !== undefined,
    true,
  );
  assert.equal(cards.decided.length, 1);
  await r.stop();
});

test("another caller's conversation cannot tap the item, and nothing is read for it", async () => {
  const r = await rig();
  const cards = withCards(r);
  r.supervisor.raiseSuggestion(choice());
  await r.supervisor.settled();
  const [item] = open(r);
  const result = await r.supervisor.answer({
    itemId: item?.itemId ?? '',
    answerId: `ans_${randomUUID().replaceAll('-', '')}`,
    optionId: 'do',
    preconditionHash: item?.preconditionHash ?? '',
    conversations: ['cnv_other'],
  });
  assert.equal(!result.ok && result.reason, 'not_found');
  assert.deepEqual(cards.verified, []);
  assert.equal(cards.decided.length, 0);
  await r.stop();
});

test('a card that ended without an answer takes its item down, but not one being answered', async () => {
  const r = await rig();
  const gate = new Gate();
  const entered = new Gate();
  withCards(r);
  const real = r.host.suggestions?.decide;
  r.host.suggestions = {
    ...(r.host.suggestions as NonNullable<typeof r.host.suggestions>),
    decide: async (decision, signal) => {
      entered.resolve();
      await gate.promise;
      return (real as NonNullable<typeof real>)(decision, signal);
    },
  };
  r.supervisor.raiseSuggestion(choice());
  r.supervisor.raiseSuggestion(
    choice({
      lineage: 'proj_1:triage_issue:issue:9',
      cardId: 'card_9',
      title: 'Look into issue #9',
    }),
  );
  await r.supervisor.settled();
  const pending = tap(r, 'do');
  await entered.promise;
  assert.equal(
    r.supervisor.closeSuggestion('proj_1:rebase_pr:pr:12'),
    false,
    'an answer is on its way',
  );
  assert.equal(r.supervisor.closeSuggestion('proj_1:triage_issue:issue:9'), true);
  assert.equal(r.supervisor.closeSuggestion('proj_1:triage_issue:issue:9'), false, 'once');
  assert.equal(r.supervisor.closeSuggestion('proj_1:nothing'), false);
  gate.resolve();
  await pending;
  const closed = r.supervisor.listItems({ state: 'closed' }).items;
  assert.deepEqual(closed.map((i) => i.closeReason).sort(), ['answered', 'condition_cleared']);
  await r.stop();
});

test('suggestions are not in the digest, and a kind can be muted', async () => {
  const r = await rig();
  withCards(r);
  r.supervisor.raiseSuggestion(choice());
  await r.supervisor.settled();
  const digest = await r.supervisor.digest();
  assert.deepEqual(digest.items, []);
  assert.equal(digest.counts.open, 0);
  assert.ok(r.supervisor.setMute('suggestion', true).mutedKinds.includes('suggestion'));
  await r.stop();
});
