import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DecisionBook, sequentialDecisionIds } from '../decisions.js';
import {
  ALWAYS_ASK,
  cardDraftFromMustAsk,
  classifyAction,
  consultBeforeAsk,
  DEFAULT_MUST_ASK,
  mergeMustAskPolicy,
  MUST_ASK_CATEGORIES,
  speculativeBlocksOutbound,
} from '../must-ask.js';
import { actMandate } from '../types.js';
import { github, issuePayload, REPO, rig, TENANT } from './harness.js';

test('default whitelist covers the product must-ask list and cannot be loosened', () => {
  for (const category of MUST_ASK_CATEGORIES) {
    assert.equal(DEFAULT_MUST_ASK.categories.includes(category), true, category);
  }
  assert.deepEqual([...ALWAYS_ASK], ['delete_data', 'rotate_secrets', 'spend_over_budget']);
  const loosened = mergeMustAskPolicy({ disable: ['deploy'] });
  assert.equal(loosened.ok, false);
  if (loosened.ok) return;
  assert.equal(loosened.reason, 'cannot_loosen');
  const dropAlways = mergeMustAskPolicy({ removeAlwaysAsk: ['delete_data'] });
  assert.equal(dropAlways.ok, false);
  const tighter = mergeMustAskPolicy({ extraAlwaysAsk: ['force_push'] });
  assert.equal(tighter.ok, true);
  if (!tighter.ok) return;
  assert.equal(tighter.policy.alwaysAsk.includes('force_push'), true);
  assert.equal(tighter.policy.alwaysAsk.includes('delete_data'), true);
});

test('classifyAction maps bound text and approval kinds onto the whitelist', () => {
  assert.equal(classifyAction({ kind: 'secrets', boundText: 'inject GH_TOKEN' }), 'rotate_secrets');
  assert.equal(classifyAction({ kind: 'spend', boundText: 'raise cap' }), 'spend_over_budget');
  assert.equal(classifyAction({ kind: 'deploy', boundText: 'Deploy prod' }), 'deploy');
  assert.equal(classifyAction({ kind: 'deploy', boundText: 'stop service api' }), 'stop_service');
  assert.equal(
    classifyAction({ kind: 'push_protected', boundText: 'git push --force origin main' }),
    'force_push',
  );
  assert.equal(
    classifyAction({ kind: 'push_protected', boundText: 'Push main on acme/app' }),
    undefined,
  );
  assert.equal(
    classifyAction({ kind: 'merge', boundText: 'Merge pull request #1 in r at abc' }),
    undefined,
  );
  assert.equal(
    classifyAction({ kind: 'other_irreversible', boundText: 'drop table users' }),
    'delete_data',
  );
  assert.equal(
    classifyAction({ kind: 'other_irreversible', boundText: 'delete branch maka/sa-1' }),
    'delete_branch',
  );
  assert.equal(
    classifyAction({
      kind: 'other_irreversible',
      boundText: 'run prisma migrate on prod',
    }),
    'db_migration',
  );
});

test('ledger decided skips a second ask except delete/secrets/spend', () => {
  const book = new DecisionBook({ ids: sequentialDecisionIds() });
  book.record({
    polarity: 'decided',
    verbatim: 'yes deploy staging',
    sourceEventId: 'evt_1',
    actor: { login: 'alice', kind: 'user' },
    scope: { tenantId: TENANT, repo: REPO, category: 'deploy', object: 'staging' },
    at: 1,
  });
  const skip = consultBeforeAsk({
    book,
    action: { kind: 'deploy', boundText: 'Deploy staging', object: 'staging' },
    tenantId: TENANT,
    repo: REPO,
  });
  assert.equal(skip.kind, 'apply_decided');
  book.record({
    polarity: 'decided',
    verbatim: 'ok to rotate last quarter',
    sourceEventId: 'evt_2',
    actor: { login: 'alice', kind: 'user' },
    scope: { tenantId: TENANT, repo: REPO, category: 'rotate_secrets', object: 'GH_TOKEN' },
    at: 2,
  });
  const stillAsk = consultBeforeAsk({
    book,
    action: { kind: 'secrets', boundText: 'rotate GH_TOKEN', object: 'GH_TOKEN' },
    tenantId: TENANT,
    repo: REPO,
  });
  assert.equal(stillAsk.kind, 'must_ask');
  if (stillAsk.kind !== 'must_ask') return;
  assert.equal(stillAsk.alwaysAsk, true);
  assert.equal(stillAsk.category, 'rotate_secrets');
});

test('speculative_blocked and an existing Safety hold are not a second card', () => {
  const book = new DecisionBook({ ids: sequentialDecisionIds() });
  const speculative = consultBeforeAsk({
    book,
    action: { kind: 'deploy', boundText: 'Deploy prod' },
    tenantId: TENANT,
    repo: REPO,
    worker: { speculative: { status: 'ready' } },
  });
  assert.deepEqual(speculative, { kind: 'already_blocked', reason: 'speculative_blocked' });
  const held = consultBeforeAsk({
    book,
    action: { kind: 'deploy', boundText: 'Deploy prod' },
    tenantId: TENANT,
    repo: REPO,
    gate: { allowed: false, reason: 'held' },
  });
  assert.deepEqual(held, { kind: 'already_blocked', reason: 'held' });
  assert.equal(
    speculativeBlocksOutbound(
      { speculative: { status: 'accepted' } },
      { kind: 'deploy', boundText: 'x' },
    ),
    false,
  );
});

test('an unlisted action proceeds; fuzzy hints do not auto-apply', () => {
  const book = new DecisionBook({ ids: sequentialDecisionIds() });
  book.record({
    polarity: 'decided',
    verbatim: 'comment on issue 1 only',
    sourceEventId: 'evt_1',
    actor: { login: 'alice', kind: 'user' },
    scope: { tenantId: TENANT, repo: REPO, category: 'outbound_message', object: 'issue-1' },
    at: 1,
  });
  const other = consultBeforeAsk({
    book,
    action: {
      kind: 'other_irreversible',
      boundText: 'comment on issue 2',
      category: 'outbound_message',
      object: 'issue-2',
    },
    tenantId: TENANT,
    repo: REPO,
  });
  assert.equal(other.kind, 'must_ask');
  if (other.kind !== 'must_ask') return;
  assert.equal(other.hints?.[0]?.entryId, 'dec_0001');
  const ordinary = consultBeforeAsk({
    book,
    action: { kind: 'merge', boundText: 'Merge pull request #1 in acme/app at abc' },
    tenantId: TENANT,
    repo: REPO,
  });
  assert.equal(ordinary.kind, 'agent_may');
});

test('must-ask delete_data holds through Safety without duplicating merge tests', async () => {
  const { agent, handler, judge } = rig();
  judge.inner = {
    async decide() {
      return { action: 'spawn', mandate: actMandate([REPO]), title: 'act' };
    },
  };
  handler.script = () => ({
    progress: true,
    action: { kind: 'other_irreversible', boundText: 'drop table sessions' },
  });
  const opened = await agent.ingest(
    github(TENANT, 'ask-del', 'issues', issuePayload('opened', 21)),
  );
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  assert.equal(agent.worker(TENANT, opened.workerId)?.state, 'awaiting_approval');
  assert.equal(
    agent.pendingMustAsks(TENANT).some((row) => row.category === 'delete_data'),
    true,
  );
  const snap = agent.statusSnapshot(TENANT);
  assert.equal(
    snap.mustAskPending?.some((row) => row.category === 'delete_data'),
    true,
  );
  const draft = cardDraftFromMustAsk(agent.pendingMustAsks(TENANT)[0]!);
  assert.equal(draft.band, 'high');
  assert.match(draft.reason, /drop table/);
});

test('a decided deploy is applied and cited on the progress line', async () => {
  const book = new DecisionBook({ ids: sequentialDecisionIds(30) });
  book.record({
    polarity: 'decided',
    verbatim: 'Deploy staging whenever CI is green',
    sourceEventId: 'evt_old',
    actor: { login: 'alice', kind: 'user' },
    scope: {
      tenantId: TENANT,
      repo: REPO,
      category: 'deploy',
      object: `issue:${TENANT}:${REPO}#22`,
    },
    at: 1,
  });
  const { agent, handler, judge } = rig({ decisions: book });
  judge.inner = {
    async decide() {
      return { action: 'spawn', mandate: actMandate([REPO]), title: 'act' };
    },
  };
  handler.script = () => ({
    progress: true,
    action: {
      kind: 'deploy',
      boundText: 'Deploy staging',
      object: `issue:${TENANT}:${REPO}#22`,
    },
  });
  const opened = await agent.ingest(
    github(TENANT, 'ask-dep', 'issues', issuePayload('opened', 22)),
  );
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const worker = agent.worker(TENANT, opened.workerId);
  assert.notEqual(worker?.state, 'awaiting_approval');
  assert.match(worker?.progress?.lastActivity ?? '', /followed decision/);
  assert.equal(
    agent.store.audit(TENANT).some((row) => row.kind === 'decision_applied'),
    true,
  );
});
