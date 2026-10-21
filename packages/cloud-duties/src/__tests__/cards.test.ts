import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BACKOFF_AFTER_IGNORED,
  BACKOFF_INTERVAL_MS,
  EXPIRE_AFTER_MS,
  MAX_CARDS_PER_DAY,
  SUPPRESS_AFTER_NO_MS,
  SUPPRESS_AFTER_YES_MS,
} from '../cards/store.js';
import { defaultEnabledKinds, KIND_SPECS } from '../cards/kinds.js';
import { stableHash } from '../cards/hash.js';
import { DAY, OWNER, rig } from './harness.js';

const card = (over: Record<string, unknown> = {}) => ({
  kind: 'fix_main_ci',
  subjectKey: 'main',
  title: 'Fix the failing test on main',
  detail: 'CI has failed on main since this morning.',
  brief: 'Fix the failing test on main.\nFollow the owner’s rules.',
  estimateUsd: 3,
  preconditionHash: stableHash({ run: 1 }),
  external: false,
  ...over,
});

test('a card takes its authority and mode from its kind, and a request that names them is refused', async () => {
  const r = await rig();
  const made = r.engine.cards.propose(OWNER, r.projectId, card());
  assert.ok(made.ok);
  assert.equal(made.card.authority, KIND_SPECS.fix_main_ci.authority);
  assert.equal(made.card.mode, KIND_SPECS.fix_main_ci.mode);
  assert.equal(made.card.state, 'open');
  for (const extra of [
    { authority: 'merge-when-green' },
    { mode: 'deep' },
    { owner: 'inv_other' },
    { state: 'accepted' },
  ]) {
    const refused = r.engine.cards.propose(OWNER, r.projectId, card({ subjectKey: 'x', ...extra }));
    assert.deepEqual(refused, { ok: false, reason: 'invalid' });
  }
  r.cleanup();
});

test('text that could show something other than what is stored is refused', async () => {
  const r = await rig();
  const refused = (over: Record<string, unknown>) =>
    r.engine.cards.propose(OWNER, r.projectId, card(over));
  assert.equal(refused({ title: 'Fix ‮tset the' }).ok, false, 'a direction override');
  assert.equal(refused({ title: 'Fix\nmerge it' }).ok, false, 'a line break in a title');
  assert.equal(refused({ detail: 'a​b' }).ok, false, 'a zero-width space');
  assert.equal(refused({ title: 'Fix “the” test' }).ok, false, 'a look-alike quote');
  assert.equal(refused({ brief: 'ok\n‮fdp' }).ok, false, 'a direction override in a brief');
  assert.equal(refused({ title: '' }).ok, false);
  assert.equal(refused({ title: 'x'.repeat(121) }).ok, false);
  assert.equal(refused({ kind: 'delete_everything' }).ok, false);
  assert.equal(refused({ preconditionHash: 'abc' }).ok, false);
  assert.equal(refused({ estimateUsd: 0 }).ok, false);
  assert.equal(refused({ estimateUsd: 51 }).ok, false);
  assert.equal(refused({ subjectKey: 'Main Branch' }).ok, false);
  assert.ok(refused({ brief: 'Line one.\nLine two.' }).ok, 'plain newlines in a brief are fine');
  r.cleanup();
});

test('a project that is not the owner’s, or is gone, takes no card', async () => {
  const r = await rig();
  assert.deepEqual(r.engine.cards.propose('inv_other', r.projectId, card()), {
    ok: false,
    reason: 'not_found',
  });
  assert.deepEqual(r.engine.cards.propose(OWNER, 'proj_missing', card()), {
    ok: false,
    reason: 'not_found',
  });
  const made = r.engine.cards.propose(OWNER, r.projectId, card());
  assert.ok(made.ok);
  assert.ok(r.engine.removeProject(OWNER, r.projectId));
  assert.equal(r.engine.cards.get(OWNER, made.card.cardId), undefined);
  assert.deepEqual(r.engine.cards.list(OWNER, r.projectId), []);
  assert.deepEqual(r.engine.cards.dismiss(OWNER, made.card.cardId), {
    ok: false,
    reason: 'not_found',
  });
  assert.deepEqual(r.engine.cards.propose(OWNER, r.projectId, card({ subjectKey: 'again' })), {
    ok: false,
    reason: 'not_found',
  });
  r.cleanup();
});

test('another owner sees, answers and switches nothing of a card or a project', async () => {
  const r = await rig();
  const made = r.engine.cards.propose(OWNER, r.projectId, card());
  assert.ok(made.ok);
  const other = 'inv_other';
  assert.equal(r.engine.cards.get(other, made.card.cardId), undefined);
  assert.deepEqual(r.engine.cards.list(other, r.projectId), []);
  assert.deepEqual(r.engine.cards.stats(other, r.projectId), []);
  assert.deepEqual(r.engine.cards.dismiss(other, made.card.cardId), {
    ok: false,
    reason: 'not_found',
  });
  assert.deepEqual(r.engine.cards.accept(other, made.card.cardId), {
    ok: false,
    reason: 'not_found',
  });
  assert.equal(r.engine.cards.setKindEnabled(other, r.projectId, 'fix_main_ci', false), false);
  assert.deepEqual(r.engine.cards.takeOffers(other, r.projectId), []);
  assert.equal(r.engine.cards.get(OWNER, made.card.cardId)?.state, 'open');
  r.cleanup();
});

test('at most three new cards a day per project, counted on the UTC day', async () => {
  const r = await rig();
  const subjects = ['main', 'pr:1', 'pr:2', 'pr:3'];
  const results = subjects.map((subjectKey) =>
    r.engine.cards.propose(OWNER, r.projectId, card({ kind: 'fix_pr_checks', subjectKey })),
  );
  assert.equal(MAX_CARDS_PER_DAY, 3);
  assert.deepEqual(
    results.map((x) => (x.ok ? 'ok' : x.reason)),
    ['ok', 'ok', 'ok', 'daily_cap'],
  );
  // A card answered the same day does not free a slot: the cap counts cards made, not cards open.
  const first = results[0];
  assert.ok(first?.ok);
  r.engine.cards.dismiss(OWNER, first.card.cardId);
  assert.deepEqual(
    r.engine.cards.propose(OWNER, r.projectId, card({ kind: 'fix_pr_checks', subjectKey: 'pr:9' })),
    { ok: false, reason: 'daily_cap' },
  );
  // The next UTC day starts again.
  r.clock.advance(DAY);
  assert.ok(
    r.engine.cards.propose(OWNER, r.projectId, card({ kind: 'fix_pr_checks', subjectKey: 'pr:9' }))
      .ok,
  );
  r.cleanup();
});

test('the cap is per project', async () => {
  const r = await rig();
  const second = r.engine.addProject(OWNER, {
    repo: 'acme/gadgets',
    installationId: 1,
    defaultBranch: 'main',
    selfLogins: ['maka-bot'],
  });
  assert.ok(second.ok);
  for (const n of [1, 2, 3]) {
    assert.ok(r.engine.cards.propose(OWNER, r.projectId, card({ subjectKey: `pr:${n}` })).ok);
  }
  assert.ok(
    r.engine.cards.propose(OWNER, second.project.projectId, card({ subjectKey: 'pr:1' })).ok,
  );
  r.cleanup();
});

test('the same suggestion is not open twice', async () => {
  const r = await rig();
  assert.ok(r.engine.cards.propose(OWNER, r.projectId, card()).ok);
  assert.deepEqual(r.engine.cards.propose(OWNER, r.projectId, card()), {
    ok: false,
    reason: 'already_open',
  });
  r.cleanup();
});

test('a dismissed suggestion is not shown again for a week, but another subject is', async () => {
  const r = await rig();
  const made = r.engine.cards.propose(OWNER, r.projectId, card());
  assert.ok(made.ok);
  assert.ok(r.engine.cards.dismiss(OWNER, made.card.cardId).ok);
  // Same day, next days: still silent. Different subject: allowed.
  assert.deepEqual(r.engine.cards.propose(OWNER, r.projectId, card()), {
    ok: false,
    reason: 'recently_decided',
  });
  r.clock.advance(SUPPRESS_AFTER_NO_MS - 1);
  assert.deepEqual(r.engine.cards.propose(OWNER, r.projectId, card()), {
    ok: false,
    reason: 'recently_decided',
  });
  assert.ok(r.engine.cards.propose(OWNER, r.projectId, card({ subjectKey: 'pr:4' })).ok);
  r.clock.advance(2);
  assert.ok(r.engine.cards.propose(OWNER, r.projectId, card()).ok);
  r.cleanup();
});

test('an accepted suggestion is not proposed again while its task may be running', async () => {
  const r = await rig();
  const made = r.engine.cards.propose(OWNER, r.projectId, card());
  assert.ok(made.ok);
  assert.ok(r.engine.cards.accept(OWNER, made.card.cardId).ok);
  assert.deepEqual(r.engine.cards.propose(OWNER, r.projectId, card()), {
    ok: false,
    reason: 'recently_decided',
  });
  r.clock.advance(SUPPRESS_AFTER_YES_MS + 1);
  assert.ok(r.engine.cards.propose(OWNER, r.projectId, card()).ok);
  r.cleanup();
});

test('accepting is once: a second tap or a retry returns the same card as a duplicate', async () => {
  const r = await rig();
  const made = r.engine.cards.propose(OWNER, r.projectId, card());
  assert.ok(made.ok);
  const first = r.engine.cards.accept(OWNER, made.card.cardId);
  const second = r.engine.cards.accept(OWNER, made.card.cardId);
  assert.ok(first.ok && second.ok);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.card.cardId, made.card.cardId);
  assert.equal(
    r.engine.cards.stats(OWNER, r.projectId).find((s) => s.kind === 'fix_main_ci')?.accepted,
    1,
  );
  // The other answer after one is refused, not applied.
  assert.deepEqual(r.engine.cards.dismiss(OWNER, made.card.cardId), {
    ok: false,
    reason: 'closed',
  });
  assert.deepEqual(r.engine.cards.accept(OWNER, 'card_missing'), {
    ok: false,
    reason: 'not_found',
  });
  r.cleanup();
});

test('a conversation is attached to an accepted card once', async () => {
  const r = await rig();
  const made = r.engine.cards.propose(OWNER, r.projectId, card());
  assert.ok(made.ok);
  assert.equal(
    r.engine.cards.attachConversation(OWNER, made.card.cardId, 'conv_1'),
    false,
    'not accepted yet',
  );
  r.engine.cards.accept(OWNER, made.card.cardId);
  assert.equal(r.engine.cards.attachConversation(OWNER, made.card.cardId, 'conv_1'), true);
  assert.equal(r.engine.cards.attachConversation(OWNER, made.card.cardId, 'conv_2'), false);
  assert.equal(r.engine.cards.get(OWNER, made.card.cardId)?.conversationId, 'conv_1');
  assert.equal(r.engine.cards.attachConversation('inv_other', made.card.cardId, 'conv_3'), false);
  r.cleanup();
});

test('a card nobody answers expires after three days and counts as ignored, and is silent for a week', async () => {
  const r = await rig();
  const made = r.engine.cards.propose(OWNER, r.projectId, card());
  assert.ok(made.ok);
  r.clock.advance(EXPIRE_AFTER_MS - 1);
  assert.deepEqual(r.engine.cards.expire(), []);
  r.clock.advance(1);
  const expired = r.engine.cards.expire();
  assert.deepEqual(
    expired.map((c) => [c.cardId, c.state]),
    [[made.card.cardId, 'expired']],
  );
  assert.deepEqual(r.engine.cards.expire(), [], 'ended once');
  const stats = r.engine.cards.stats(OWNER, r.projectId).find((s) => s.kind === 'fix_main_ci');
  assert.equal(stats?.ignored, 1);
  assert.deepEqual(r.engine.cards.accept(OWNER, made.card.cardId), { ok: false, reason: 'closed' });
  assert.deepEqual(r.engine.cards.propose(OWNER, r.projectId, card()), {
    ok: false,
    reason: 'recently_decided',
  });
  r.cleanup();
});

test('after three ignored cards of one kind it backs off to one a week and offers to be turned off, once', async () => {
  const r = await rig();
  const cards = r.engine.cards;
  assert.equal(BACKOFF_AFTER_IGNORED, 3);
  for (const n of [1, 2, 3]) {
    const made = cards.propose(
      OWNER,
      r.projectId,
      card({ kind: 'rebase_pr', subjectKey: `pr:${n}` }),
    );
    assert.ok(made.ok);
    // Two dismissed and one left until it expires: both kinds of "no" count.
    if (n < 3) cards.dismiss(OWNER, made.card.cardId);
    r.clock.advance(1000);
  }
  assert.deepEqual(cards.takeOffers(OWNER, r.projectId), [], 'the third is still open');
  r.clock.advance(EXPIRE_AFTER_MS);
  assert.equal(cards.expire().length, 1);
  const stats = () => cards.stats(OWNER, r.projectId).find((s) => s.kind === 'rebase_pr');
  assert.equal(stats()?.ignoredInARow, 3);
  assert.equal(stats()?.backedOff, true);
  assert.equal(stats()?.offer, 'due');
  assert.deepEqual(cards.takeOffers(OWNER, r.projectId), ['rebase_pr']);
  assert.deepEqual(cards.takeOffers(OWNER, r.projectId), [], 'offered once');
  assert.equal(stats()?.offer, 'offered');
  // Other kinds are not slowed.
  assert.ok(
    cards.propose(OWNER, r.projectId, card({ kind: 'fix_pr_checks', subjectKey: 'pr:1' })).ok,
  );
  // The kind itself: the last card was made less than a week ago.
  assert.deepEqual(
    cards.propose(OWNER, r.projectId, card({ kind: 'rebase_pr', subjectKey: 'pr:7' })),
    {
      ok: false,
      reason: 'backed_off',
    },
  );
  r.clock.advance(BACKOFF_INTERVAL_MS);
  assert.ok(cards.propose(OWNER, r.projectId, card({ kind: 'rebase_pr', subjectKey: 'pr:7' })).ok);
  r.cleanup();
});

test('an accepted card ends the run of ignored ones', async () => {
  const r = await rig();
  const cards = r.engine.cards;
  for (const n of [1, 2]) {
    const made = cards.propose(OWNER, r.projectId, card({ subjectKey: `pr:${n}` }));
    assert.ok(made.ok);
    cards.dismiss(OWNER, made.card.cardId);
  }
  const yes = cards.propose(OWNER, r.projectId, card({ subjectKey: 'pr:3' }));
  assert.ok(yes.ok);
  cards.accept(OWNER, yes.card.cardId);
  r.clock.advance(DAY);
  const no = cards.propose(OWNER, r.projectId, card({ subjectKey: 'pr:4' }));
  assert.ok(no.ok);
  cards.dismiss(OWNER, no.card.cardId);
  const stats = cards.stats(OWNER, r.projectId).find((s) => s.kind === 'fix_main_ci');
  assert.equal(stats?.ignoredInARow, 1);
  assert.equal(stats?.backedOff, false);
  assert.equal(stats?.offer, 'none');
  assert.deepEqual(cards.takeOffers(OWNER, r.projectId), []);
  r.cleanup();
});

function ignoreThree(r: Awaited<ReturnType<typeof rig>>, kind: string) {
  for (const n of [1, 2, 3]) {
    const made = r.engine.cards.propose(OWNER, r.projectId, card({ kind, subjectKey: `pr:${n}` }));
    assert.ok(made.ok);
    r.engine.cards.dismiss(OWNER, made.card.cardId);
  }
}

test('turning a kind off stops its cards; keeping it ends the back-off', async () => {
  const r = await rig();
  const cards = r.engine.cards;
  ignoreThree(r, 'triage_issue');
  assert.deepEqual(cards.takeOffers(OWNER, r.projectId), ['triage_issue']);
  assert.deepEqual(cards.answerOffer(OWNER, r.projectId, 'triage_issue', 'keep'), {
    ok: true,
    duplicate: false,
  });
  assert.deepEqual(cards.answerOffer(OWNER, r.projectId, 'triage_issue', 'keep'), {
    ok: true,
    duplicate: true,
  });
  let stats = cards.stats(OWNER, r.projectId).find((s) => s.kind === 'triage_issue');
  assert.equal(stats?.backedOff, false);
  assert.equal(stats?.enabled, true);

  r.clock.advance(DAY);
  ignoreThree(r, 'rebase_pr');
  assert.deepEqual(cards.takeOffers(OWNER, r.projectId), ['rebase_pr']);
  assert.deepEqual(cards.answerOffer(OWNER, r.projectId, 'rebase_pr', 'off'), {
    ok: true,
    duplicate: false,
  });
  assert.deepEqual(cards.answerOffer(OWNER, r.projectId, 'rebase_pr', 'off'), {
    ok: true,
    duplicate: true,
  });
  assert.deepEqual(cards.answerOffer(OWNER, r.projectId, 'rebase_pr', 'keep'), {
    ok: false,
    reason: 'closed',
  });
  stats = cards.stats(OWNER, r.projectId).find((s) => s.kind === 'rebase_pr');
  assert.equal(stats?.enabled, false);
  r.clock.advance(SUPPRESS_AFTER_NO_MS + BACKOFF_INTERVAL_MS);
  assert.deepEqual(
    cards.propose(OWNER, r.projectId, card({ kind: 'rebase_pr', subjectKey: 'pr:50' })),
    {
      ok: false,
      reason: 'kind_off',
    },
  );
  assert.equal(cards.setKindEnabled(OWNER, r.projectId, 'rebase_pr', true), true);
  assert.ok(cards.propose(OWNER, r.projectId, card({ kind: 'rebase_pr', subjectKey: 'pr:50' })).ok);
  assert.equal(cards.answerOffer(OWNER, r.projectId, 'nonsense', 'off').ok, false);
  r.cleanup();
});

test('the owner can switch a kind off before any card of it exists', async () => {
  const r = await rig();
  const cards = r.engine.cards;
  assert.equal(cards.setKindEnabled(OWNER, r.projectId, 'fix_main_ci', false), true);
  assert.deepEqual(cards.propose(OWNER, r.projectId, card()), { ok: false, reason: 'kind_off' });
  assert.equal(cards.setKindEnabled(OWNER, r.projectId, 'not_a_kind', false), false);
  assert.equal(
    cards.stats(OWNER, r.projectId).find((s) => s.kind === 'fix_main_ci')?.enabled,
    false,
  );
  r.cleanup();
});

test('a kind whose tool does not exist is never proposed until it is named', async () => {
  const gated = Object.entries(KIND_SPECS)
    .filter(([, spec]) => spec.gated)
    .map(([kind]) => kind);
  assert.deepEqual(gated.sort(), ['close_issues', 'merge_pr']);
  const r = await rig();
  for (const kind of gated) {
    assert.deepEqual(r.engine.cards.propose(OWNER, r.projectId, card({ kind, subjectKey: 'x' })), {
      ok: false,
      reason: 'kind_unavailable',
    });
    assert.equal(r.engine.cards.setKindEnabled(OWNER, r.projectId, kind, true), false);
  }
  assert.ok(!r.engine.cards.stats(OWNER, r.projectId).some((s) => gated.includes(s.kind)));
  r.cleanup();
  const on = await rig({ cardKinds: new Set([...defaultEnabledKinds(), 'merge_pr' as const]) });
  assert.ok(
    on.engine.cards.propose(OWNER, on.projectId, card({ kind: 'merge_pr', subjectKey: 'pr:1' })).ok,
  );
  assert.equal(
    on.engine.cards.get(
      OWNER,
      (on.engine.cards.list(OWNER, on.projectId)[0] as { cardId: string }).cardId,
    )?.authority,
    'merge-when-green',
  );
  on.cleanup();
});

test('a stale card is replaced by a fresh one of the same suggestion, which is not a new card for the day', async () => {
  const r = await rig();
  const cards = r.engine.cards;
  const made = [1, 2, 3].map((n) =>
    cards.propose(OWNER, r.projectId, card({ subjectKey: `pr:${n}` })),
  );
  assert.ok(made.every((m) => m.ok));
  const [first] = made;
  assert.ok(first?.ok);
  const fresh = cards.refresh(
    OWNER,
    first.card.cardId,
    card({
      subjectKey: 'pr:1',
      preconditionHash: stableHash({ head: 'b' }),
      title: 'Fix the failing test on main, again',
    }),
  );
  assert.ok(fresh.ok);
  assert.equal(fresh.card.replaces, first.card.cardId);
  assert.equal(fresh.card.state, 'open');
  assert.equal(cards.get(OWNER, first.card.cardId)?.state, 'stale');
  // The day's cap still has the three it had; the refresh took none.
  assert.deepEqual(cards.propose(OWNER, r.projectId, card({ subjectKey: 'pr:9' })), {
    ok: false,
    reason: 'daily_cap',
  });
  // A tap on the stale card does nothing and says it is stale; the fresh card can be answered.
  assert.deepEqual(cards.accept(OWNER, first.card.cardId), { ok: false, reason: 'stale' });
  assert.deepEqual(cards.dismiss(OWNER, first.card.cardId), { ok: false, reason: 'stale' });
  assert.ok(cards.accept(OWNER, fresh.card.cardId).ok);
  // A stale card is neither a "no" nor an ignored card.
  const stats = cards.stats(OWNER, r.projectId).find((s) => s.kind === 'fix_main_ci');
  assert.equal(stats?.dismissed, 0);
  assert.equal(stats?.ignored, 0);
  // It cannot be refreshed into another suggestion, twice, or by someone else.
  assert.deepEqual(cards.refresh(OWNER, first.card.cardId, card({ subjectKey: 'pr:1' })), {
    ok: false,
    reason: 'closed',
  });
  const second = made[1];
  assert.ok(second?.ok);
  assert.deepEqual(cards.refresh(OWNER, second.card.cardId, card({ subjectKey: 'pr:other' })), {
    ok: false,
    reason: 'invalid',
  });
  assert.deepEqual(
    cards.refresh(OWNER, second.card.cardId, card({ subjectKey: 'pr:2', kind: 'rebase_pr' })),
    { ok: false, reason: 'invalid' },
  );
  assert.deepEqual(cards.refresh('inv_other', second.card.cardId, card({ subjectKey: 'pr:2' })), {
    ok: false,
    reason: 'not_found',
  });
  assert.equal(cards.get(OWNER, second.card.cardId)?.state, 'open');
  r.cleanup();
});

test('a card whose condition cleared is retired without counting as an answer', async () => {
  const r = await rig();
  const cards = r.engine.cards;
  const made = cards.propose(OWNER, r.projectId, card());
  assert.ok(made.ok);
  const first = cards.retire(OWNER, made.card.cardId);
  const again = cards.retire(OWNER, made.card.cardId);
  assert.ok(first.ok && again.ok);
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.equal(cards.get(OWNER, made.card.cardId)?.state, 'stale');
  assert.deepEqual(cards.retire('inv_other', made.card.cardId), { ok: false, reason: 'not_found' });
  const stats = cards.stats(OWNER, r.projectId).find((s) => s.kind === 'fix_main_ci');
  assert.deepEqual(
    [stats?.accepted, stats?.dismissed, stats?.ignored, stats?.ignoredInARow],
    [0, 0, 0, 0],
  );
  r.cleanup();
});

test('cards and counts survive a restart', async () => {
  const r = await rig({ file: true });
  const made = r.engine.cards.propose(OWNER, r.projectId, card());
  assert.ok(made.ok);
  r.engine.cards.dismiss(OWNER, made.card.cardId);
  const engine = r.reopen();
  assert.equal(engine.cards.get(OWNER, made.card.cardId)?.state, 'dismissed');
  assert.equal(
    engine.cards.stats(OWNER, r.projectId).find((s) => s.kind === 'fix_main_ci')?.dismissed,
    1,
  );
  assert.deepEqual(engine.cards.propose(OWNER, r.projectId, card()), {
    ok: false,
    reason: 'recently_decided',
  });
  r.cleanup();
});
