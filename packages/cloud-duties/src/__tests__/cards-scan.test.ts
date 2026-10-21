import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyRanking, type CardRanker, CardScanner } from '../cards/scan.js';
import { GitHubSignalReader, type RepoSignals, type SignalReader } from '../cards/signals.js';
import { busyRoutes, fakeGitHub, NOW, type Routes } from './cards-fixtures.js';
import { DAY, OWNER, rig } from './harness.js';

const EMPTY: RepoSignals = {
  failingOnDefault: [],
  flaky: [],
  advisories: [],
  ownPulls: [],
  newIssues: [],
};

function githubReader(routes: Routes) {
  const github = fakeGitHub(routes);
  return {
    ...github,
    reader: new GitHubSignalReader({
      baseUrl: 'https://api.github.test',
      fetch: github.fetch,
      token: () => 'ghs_test',
      now: () => NOW,
    }),
  };
}

const kinds = (cards: ReadonlyArray<{ kind: string }>) => cards.map((c) => c.kind);

test('a scan proposes up to three cards, most important first, and writes nothing else', async () => {
  const r = await rig();
  const [duty] = await r.activate({
    name: 'Own PRs',
    trigger: { kind: 'ci_failed_own_pr' },
    instruction: 'Fix.',
    authority: 'open-pr',
    runBudgetUsd: 1,
    dailyCapUsd: 3,
  });
  const { reader, calls } = githubReader(busyRoutes());
  const scanner = new CardScanner(r.engine, { reader });
  const result = await scanner.scan(OWNER, r.projectId);
  assert.ok(result.ok);
  assert.deepEqual(kinds(result.outcome.created), [
    'fix_main_ci',
    'update_dependencies',
    'fix_pr_checks',
  ]);
  assert.equal(result.outcome.ranked, 'fixed');
  assert.deepEqual(
    result.outcome.skipped.map((s) => s.reason),
    ['daily_cap'],
    "it stops at the day's cap",
  );
  // Read-only: only GETs went out, and no run was requested or started.
  assert.ok(calls.length > 0 && calls.every((c) => c.method === 'GET'));
  assert.deepEqual(r.engine.requestsOf(duty as string), []);
  assert.equal(r.engine.due().length, 0);
  assert.equal(r.engine.cards.list(OWNER, r.projectId).length, 3);
  r.cleanup();
});

test('scanning again keeps the open cards and adds the rest the next day', async () => {
  const r = await rig();
  const { reader } = githubReader(busyRoutes());
  const scanner = new CardScanner(r.engine, { reader });
  const first = await scanner.scan(OWNER, r.projectId);
  assert.ok(first.ok);
  const again = await scanner.scan(OWNER, r.projectId);
  assert.ok(again.ok);
  assert.deepEqual(again.outcome.created, []);
  assert.deepEqual(again.outcome.refreshed, []);
  assert.deepEqual(again.outcome.retired, []);
  r.clock.advance(DAY);
  const next = await scanner.scan(OWNER, r.projectId);
  assert.ok(next.ok);
  assert.deepEqual(kinds(next.outcome.created), ['answer_review', 'rebase_pr', 'stabilise_flaky']);
  assert.equal(r.engine.cards.list(OWNER, r.projectId, ['open']).length, 6);
  r.cleanup();
});

test('a dismissed suggestion is not proposed by the next scan', async () => {
  const r = await rig();
  const { reader } = githubReader(busyRoutes());
  const scanner = new CardScanner(r.engine, { reader });
  const first = await scanner.scan(OWNER, r.projectId);
  assert.ok(first.ok);
  const [main] = first.outcome.created;
  assert.ok(main);
  r.engine.cards.dismiss(OWNER, main.cardId);
  r.clock.advance(DAY);
  const next = await scanner.scan(OWNER, r.projectId);
  assert.ok(next.ok);
  assert.ok(!next.outcome.created.some((c) => c.kind === 'fix_main_ci'));
  assert.ok(
    next.outcome.skipped.some((s) => s.kind === 'fix_main_ci' && s.reason === 'recently_decided'),
  );
  r.cleanup();
});

test('an open card is refreshed when its state moved and taken down when the work is gone', async () => {
  const r = await rig();
  const routes = busyRoutes();
  const { reader } = githubReader(routes);
  const scanner = new CardScanner(r.engine, { reader });
  const first = await scanner.scan(OWNER, r.projectId);
  assert.ok(first.ok);
  const checks = first.outcome.created.find((c) => c.kind === 'fix_pr_checks');
  assert.ok(checks);

  // Someone pushed to PR 14: a new head commit with the same failing check.
  const moved = '8'.repeat(40);
  routes['/pulls/14'] = { mergeable_state: 'blocked', head: { sha: moved } };
  routes[`/commits/${moved}/check-runs`] = {
    check_runs: [{ name: 'unit', conclusion: 'failure' }],
  };
  const second = await scanner.scan(OWNER, r.projectId);
  assert.ok(second.ok);
  assert.equal(second.outcome.refreshed.length, 1);
  assert.equal(second.outcome.refreshed[0]?.old.cardId, checks.cardId);
  const fresh = second.outcome.refreshed[0]?.card;
  assert.equal(fresh?.replaces, checks.cardId);
  assert.notEqual(fresh?.preconditionHash, checks.preconditionHash);
  assert.equal(r.engine.cards.get(OWNER, checks.cardId)?.state, 'stale');

  // The checks pass now: the card is taken down, and it was not answered.
  routes[`/commits/${moved}/check-runs`] = {
    check_runs: [{ name: 'unit', conclusion: 'success' }],
  };
  const third = await scanner.scan(OWNER, r.projectId);
  assert.ok(third.ok);
  assert.deepEqual(
    third.outcome.retired.map((c) => c.cardId),
    [fresh?.cardId],
  );
  assert.equal(r.engine.cards.get(OWNER, fresh?.cardId ?? '')?.state, 'stale');
  const stats = r.engine.cards.stats(OWNER, r.projectId).find((s) => s.kind === 'fix_pr_checks');
  assert.deepEqual([stats?.dismissed, stats?.ignored, stats?.accepted], [0, 0, 0]);
  r.cleanup();
});

test('a card for work outside the first three is not taken down because newer work arrived', async () => {
  const r = await rig();
  let issues = [{ number: 1, title: 'one' }];
  const reader: SignalReader = { read: async () => ({ ...EMPTY, newIssues: issues }) };
  const scanner = new CardScanner(r.engine, { reader });
  await scanner.scan(OWNER, r.projectId);
  issues = [5, 4, 3, 2, 1].map((number) => ({ number, title: `issue ${number}` }));
  const result = await scanner.scan(OWNER, r.projectId);
  assert.ok(result.ok);
  assert.deepEqual(result.outcome.retired, []);
  assert.equal(
    r.engine.cards.list(OWNER, r.projectId, ['open']).find((c) => c.subjectKey === 'issue:1')
      ?.state,
    'open',
  );
  r.cleanup();
});

test('a switched-off kind gets no card, and an issue duty already answers issues', async () => {
  const r = await rig();
  const reader: SignalReader = {
    read: async () => ({
      ...EMPTY,
      newIssues: [{ number: 1, title: 'x' }],
      failingOnDefault: [{ name: 'CI', runId: 1, headSha: 'a'.repeat(40) }],
    }),
  };
  r.engine.cards.setKindEnabled(OWNER, r.projectId, 'fix_main_ci', false);
  const scanner = new CardScanner(r.engine, { reader });
  const result = await scanner.scan(OWNER, r.projectId);
  assert.ok(result.ok);
  assert.deepEqual(kinds(result.outcome.created), ['triage_issue']);
  r.cleanup();
  const covered = await rig();
  await covered.activate({
    name: 'Triage',
    trigger: { kind: 'issue_opened' },
    instruction: 'Look.',
    authority: 'read-only',
    runBudgetUsd: 1,
    dailyCapUsd: 3,
  });
  const second = await new CardScanner(covered.engine, { reader }).scan(OWNER, covered.projectId);
  assert.ok(second.ok);
  assert.deepEqual(kinds(second.outcome.created), ['fix_main_ci']);
  covered.cleanup();
});

test('what the employee left out becomes a card; a failing finished-task read does not stop the scan', async () => {
  const r = await rig();
  const warnings: string[] = [];
  const reader: SignalReader = { read: async () => EMPTY };
  const ok = new CardScanner(r.engine, {
    reader,
    ownResults: () => [{ taskNumber: 31, skippedTests: 2, followUps: 1 }],
  });
  const result = await ok.scan(OWNER, r.projectId);
  assert.ok(result.ok);
  assert.equal(
    result.outcome.created[0]?.title,
    'Finish what task #31 left out (2 skipped tests, 1 follow-up)',
  );
  const failing = new CardScanner(r.engine, {
    reader: { read: async () => ({ ...EMPTY, newIssues: [{ number: 2, title: 'x' }] }) },
    ownResults: () => {
      throw new Error('store down');
    },
    onWarning: (m) => warnings.push(m),
  });
  const second = await failing.scan(OWNER, r.projectId);
  assert.ok(second.ok);
  assert.deepEqual(kinds(second.outcome.created), ['triage_issue']);
  assert.equal(warnings.length, 1);
  r.cleanup();
});

test('a project that is not the owner’s is not scanned, and a failed read proposes nothing', async () => {
  const r = await rig();
  let reads = 0;
  const reader: SignalReader = {
    read: async () => {
      reads += 1;
      throw new Error('GitHub is down');
    },
  };
  const warnings: string[] = [];
  const scanner = new CardScanner(r.engine, { reader, onWarning: (m) => warnings.push(m) });
  assert.deepEqual(await scanner.scan('inv_other', r.projectId), {
    ok: false,
    reason: 'not_found',
  });
  assert.deepEqual(await scanner.scan(OWNER, 'proj_missing'), { ok: false, reason: 'not_found' });
  assert.equal(reads, 0, 'nothing is read for a project that is not theirs');
  assert.deepEqual(await scanner.scan(OWNER, r.projectId), { ok: false, reason: 'read_failed' });
  assert.equal(r.engine.cards.list(OWNER, r.projectId).length, 0);
  assert.equal(warnings.length, 1);
  assert.equal(scanner.scanning, 0);
  r.cleanup();
});

// ---- the ranker

const orderOf = async (answer: (ids: string[]) => unknown) => {
  const r = await rig();
  const seen: unknown[] = [];
  const ranker: CardRanker = {
    order: async (candidates) => {
      seen.push(candidates);
      return answer(candidates.map((c) => c.id)) as string[];
    },
  };
  const { reader } = githubReader(busyRoutes());
  const result = await new CardScanner(r.engine, { reader, ranker }).scan(OWNER, r.projectId);
  assert.ok(result.ok);
  const out = { kinds: kinds(result.outcome.created), ranked: result.outcome.ranked, seen };
  r.cleanup();
  return out;
};

test('the ranker reorders the candidates and sees only ids, kinds and scores', async () => {
  const reversed = await orderOf((ids) => [...ids].reverse());
  assert.equal(reversed.ranked, 'model');
  assert.deepEqual(reversed.kinds, ['triage_issue', 'stabilise_flaky', 'rebase_pr']);
  const shown = reversed.seen[0] as Array<Record<string, unknown>>;
  assert.ok(shown.length >= 6);
  for (const c of shown) assert.deepEqual(Object.keys(c).sort(), ['id', 'kind', 'score']);
  assert.ok(!JSON.stringify(shown).includes('Crash on empty input'), 'no outside text');
});

test('a ranker that errs, names ids that are not candidates, repeats or answers wrongly cannot add or remove a card', async () => {
  const fixed = ['fix_main_ci', 'update_dependencies', 'fix_pr_checks'];
  assert.deepEqual((await orderOf(() => 'merge everything')).kinds, fixed);
  assert.deepEqual((await orderOf(() => ({ order: ['c1'] }))).kinds, fixed);
  assert.deepEqual((await orderOf(() => [])).kinds, fixed);
  assert.deepEqual((await orderOf(() => ['x9', 7, null, 'c1', 'c1'])).kinds, fixed);
  const partial = await orderOf((ids) => [ids[ids.length - 1]]);
  assert.deepEqual(partial.kinds, ['triage_issue', 'fix_main_ci', 'update_dependencies']);
  const r = await rig();
  const warnings: string[] = [];
  const { reader } = githubReader(busyRoutes());
  const ranker: CardRanker = {
    order: async () => {
      throw new Error('model down');
    },
  };
  const result = await new CardScanner(r.engine, {
    reader,
    ranker,
    onWarning: (m) => warnings.push(m),
  }).scan(OWNER, r.projectId);
  assert.ok(result.ok);
  assert.equal(result.outcome.ranked, 'fixed');
  assert.deepEqual(kinds(result.outcome.created), fixed);
  assert.equal(warnings.length, 1);
  r.cleanup();
});

test('applyRanking keeps every item exactly once', () => {
  const fixed = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(
    applyRanking(fixed, ['c', 'a']).map((x) => x.id),
    ['c', 'a', 'b'],
  );
  assert.deepEqual(
    applyRanking(fixed, ['b', 'b', 'zzz', 3, 'a']).map((x) => x.id),
    ['b', 'a', 'c'],
  );
  assert.deepEqual(
    applyRanking(fixed, undefined).map((x) => x.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    applyRanking(fixed, { length: 3, 0: 'c' }).map((x) => x.id),
    ['a', 'b', 'c'],
  );
});

// ---- races and exits

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('two scans of one project at once are one scan, and the slot is released', async () => {
  const r = await rig();
  const gate = deferred<RepoSignals>();
  let reads = 0;
  let entered!: () => void;
  const inside = new Promise<void>((res) => {
    entered = res;
  });
  const reader: SignalReader = {
    read: () => {
      reads += 1;
      entered();
      return gate.promise;
    },
  };
  const scanner = new CardScanner(r.engine, { reader });
  const a = scanner.scan(OWNER, r.projectId);
  const b = scanner.scan(OWNER, r.projectId);
  await inside;
  assert.equal(scanner.scanning, 1);
  gate.resolve({ ...EMPTY, newIssues: [{ number: 1, title: 'x' }] });
  const [first, second] = await Promise.all([a, b]);
  assert.equal(reads, 1);
  assert.strictEqual(first, second);
  assert.equal(scanner.scanning, 0);
  // A later scan is a new one.
  await scanner.scan(OWNER, r.projectId).catch(() => undefined);
  assert.equal(reads, 2, 'the gate is already open, so this one reads again');
  r.cleanup();
});

test('the slot is released when the read fails, is aborted or times out', async () => {
  const r = await rig();
  const never: SignalReader = {
    read: (_target, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  };
  // A caller's abort.
  const scanner = new CardScanner(r.engine, { reader: never });
  const controller = new AbortController();
  const pending = scanner.scan(OWNER, r.projectId, controller.signal);
  assert.equal(scanner.scanning, 1);
  controller.abort();
  assert.deepEqual(await pending, { ok: false, reason: 'aborted' });
  assert.equal(scanner.scanning, 0);
  // Already aborted before it starts.
  assert.deepEqual(await scanner.scan(OWNER, r.projectId, AbortSignal.abort()), {
    ok: false,
    reason: 'aborted',
  });
  assert.equal(scanner.scanning, 0);
  // Its own time limit.
  const slow = new CardScanner(r.engine, { reader: never, timeoutMs: 20 });
  assert.deepEqual(await slow.scan(OWNER, r.projectId), { ok: false, reason: 'aborted' });
  assert.equal(slow.scanning, 0);
  // A reader that throws.
  const broken = new CardScanner(r.engine, {
    reader: {
      read: async () => {
        throw new Error('boom');
      },
    },
    onWarning: () => undefined,
  });
  assert.deepEqual(await broken.scan(OWNER, r.projectId), { ok: false, reason: 'read_failed' });
  assert.equal(broken.scanning, 0);
  // And the same project can be scanned again afterwards.
  const fine = new CardScanner(r.engine, { reader: { read: async () => EMPTY } });
  assert.ok((await fine.scan(OWNER, r.projectId)).ok);
  r.cleanup();
});

test('a project removed while its scan is reading gets no card', async () => {
  const r = await rig();
  const gate = deferred<RepoSignals>();
  let entered!: () => void;
  const inside = new Promise<void>((res) => {
    entered = res;
  });
  const scanner = new CardScanner(r.engine, {
    reader: {
      read: () => {
        entered();
        return gate.promise;
      },
    },
  });
  const pending = scanner.scan(OWNER, r.projectId);
  await inside;
  assert.ok(r.engine.removeProject(OWNER, r.projectId));
  gate.resolve({ ...EMPTY, newIssues: [{ number: 1, title: 'x' }] });
  const result = await pending;
  assert.ok(result.ok);
  assert.deepEqual(result.outcome.created, []);
  assert.ok(result.outcome.skipped.every((s) => s.reason === 'not_found'));
  r.cleanup();
});

// ---- the check before a tap acts

test('a card whose project did not change is fresh, and checking writes nothing', async () => {
  const r = await rig();
  const { reader, calls } = githubReader(busyRoutes());
  const scanner = new CardScanner(r.engine, { reader });
  const first = await scanner.scan(OWNER, r.projectId);
  assert.ok(first.ok);
  const [card] = first.outcome.created;
  assert.ok(card);
  const before = r.engine.cards.list(OWNER, r.projectId);
  const seen = calls.length;
  const verdict = await scanner.verify(OWNER, card.cardId);
  assert.ok(verdict.ok && verdict.state === 'fresh');
  assert.ok(calls.length > seen && calls.every((c) => c.method === 'GET'));
  assert.deepEqual(r.engine.cards.list(OWNER, r.projectId), before);
  r.cleanup();
});

test('a card whose state moved is replaced when checked, and the old one cannot be accepted', async () => {
  const r = await rig();
  const routes = busyRoutes();
  const { reader } = githubReader(routes);
  const scanner = new CardScanner(r.engine, { reader });
  const first = await scanner.scan(OWNER, r.projectId);
  assert.ok(first.ok);
  const main = first.outcome.created.find((c) => c.kind === 'fix_main_ci');
  assert.ok(main);
  // CI failed again on a newer run.
  routes['/actions/runs'] = {
    workflow_runs: [
      {
        id: 901,
        workflow_id: 1,
        name: 'CI',
        head_sha: 'd'.repeat(40),
        conclusion: 'failure',
        run_attempt: 1,
      },
    ],
  };
  const verdict = await scanner.verify(OWNER, main.cardId);
  assert.ok(verdict.ok && verdict.state === 'refreshed');
  assert.equal(verdict.card.replaces, main.cardId);
  assert.equal(r.engine.cards.get(OWNER, main.cardId)?.state, 'stale');
  assert.deepEqual(r.engine.cards.accept(OWNER, main.cardId), { ok: false, reason: 'stale' });
  // Asking again about the old card points at the fresh one; about the fresh one, that it is fresh.
  const again = await scanner.verify(OWNER, main.cardId);
  assert.ok(again.ok && again.state === 'refreshed' && again.card.cardId === verdict.card.cardId);
  const fresh = await scanner.verify(OWNER, verdict.card.cardId);
  assert.ok(fresh.ok && fresh.state === 'fresh');
  r.cleanup();
});

test('a card whose work is gone is taken down when checked', async () => {
  const r = await rig();
  const routes = busyRoutes();
  const { reader } = githubReader(routes);
  const scanner = new CardScanner(r.engine, { reader });
  const first = await scanner.scan(OWNER, r.projectId);
  assert.ok(first.ok);
  const main = first.outcome.created.find((c) => c.kind === 'fix_main_ci');
  assert.ok(main);
  routes['/actions/runs'] = {
    workflow_runs: [
      { id: 902, workflow_id: 1, name: 'CI', head_sha: 'e'.repeat(40), conclusion: 'success' },
    ],
  };
  const verdict = await scanner.verify(OWNER, main.cardId);
  assert.ok(verdict.ok && verdict.state === 'gone');
  assert.equal(r.engine.cards.get(OWNER, main.cardId)?.state, 'stale');
  // Checked again, it is still gone, not an error.
  const again = await scanner.verify(OWNER, main.cardId);
  assert.ok(again.ok && again.state === 'gone');
  r.cleanup();
});

test('a check of a card that is not the owner’s, is answered already, or cannot be read changes nothing', async () => {
  const r = await rig();
  const { reader } = githubReader(busyRoutes());
  const scanner = new CardScanner(r.engine, { reader });
  const first = await scanner.scan(OWNER, r.projectId);
  assert.ok(first.ok);
  const [card, other] = first.outcome.created;
  assert.ok(card && other);
  assert.deepEqual(await scanner.verify('inv_other', card.cardId), {
    ok: false,
    reason: 'not_found',
  });
  assert.deepEqual(await scanner.verify(OWNER, 'card_missing'), { ok: false, reason: 'not_found' });
  r.engine.cards.accept(OWNER, card.cardId);
  assert.deepEqual(await scanner.verify(OWNER, card.cardId), { ok: false, reason: 'closed' });
  r.engine.cards.dismiss(OWNER, other.cardId);
  assert.deepEqual(await scanner.verify(OWNER, other.cardId), { ok: false, reason: 'closed' });
  const third = r.engine.cards.list(OWNER, r.projectId, ['open'])[0];
  assert.ok(third);
  const down = new CardScanner(r.engine, {
    reader: {
      read: async () => {
        throw new Error('down');
      },
    },
    onWarning: () => undefined,
  });
  assert.deepEqual(await down.verify(OWNER, third.cardId), { ok: false, reason: 'read_failed' });
  assert.equal(r.engine.cards.get(OWNER, third.cardId)?.state, 'open');
  const hang = new CardScanner(r.engine, {
    reader: { read: () => new Promise(() => undefined) },
    timeoutMs: 20,
  });
  assert.deepEqual(await hang.verify(OWNER, third.cardId), { ok: false, reason: 'aborted' });
  assert.deepEqual(await scanner.verify(OWNER, third.cardId, AbortSignal.abort()), {
    ok: false,
    reason: 'aborted',
  });
  r.cleanup();
});

test('a kind the owner switched off takes its open card down when checked', async () => {
  const r = await rig();
  const { reader } = githubReader(busyRoutes());
  const scanner = new CardScanner(r.engine, { reader });
  const first = await scanner.scan(OWNER, r.projectId);
  assert.ok(first.ok);
  const main = first.outcome.created.find((c) => c.kind === 'fix_main_ci');
  assert.ok(main);
  r.engine.cards.setKindEnabled(OWNER, r.projectId, 'fix_main_ci', false);
  const verdict = await scanner.verify(OWNER, main.cardId);
  assert.ok(verdict.ok && verdict.state === 'gone');
  r.cleanup();
});

test('a card shows what finished tasks of its kind typically cost, and the table’s estimate until then', async () => {
  const r = await rig();
  const { reader } = githubReader(busyRoutes());
  const scanner = new CardScanner(r.engine, { reader });
  const first = await scanner.scan(OWNER, r.projectId);
  assert.ok(first.ok);
  const main = first.outcome.created.find((c) => c.kind === 'fix_main_ci');
  assert.equal(main?.estimateUsd, 3);
  assert.equal(main?.typical, false);
  // Three finished tasks of the kind that spent 1, 2 and 6 dollars.
  for (const [n, spent] of [1, 2, 6].entries()) {
    r.clock.advance(DAY);
    const made = r.engine.cards.propose(OWNER, r.projectId, {
      kind: 'fix_main_ci',
      subjectKey: `old${n}`,
      title: `Fix old failure ${n}`,
      detail: 'd',
      brief: 'b',
      estimateUsd: 3,
      preconditionHash: 'a'.repeat(64),
      external: false,
    });
    assert.ok(made.ok);
    r.engine.cards.accept(OWNER, made.card.cardId);
    r.engine.cards.attachConversation(OWNER, made.card.cardId, `cnv_${n}`);
    assert.equal(r.engine.cards.settle(made.card.cardId, 'completed', spent), true);
  }
  // The open card keeps what it said; a card made after the history shows the typical cost.
  r.clock.advance(DAY);
  r.engine.cards.dismiss(OWNER, main?.cardId as string);
  r.clock.advance(8 * DAY);
  const later = await scanner.scan(OWNER, r.projectId);
  assert.ok(later.ok);
  const next = later.outcome.created.find((c) => c.kind === 'fix_main_ci');
  assert.equal(next?.estimateUsd, 2);
  assert.equal(next?.typical, true);
  // Another kind has no history and keeps the table's number.
  const other = later.outcome.created.find((c) => c.kind === 'update_dependencies');
  assert.equal(other?.typical ?? false, false);
  r.cleanup();
});
