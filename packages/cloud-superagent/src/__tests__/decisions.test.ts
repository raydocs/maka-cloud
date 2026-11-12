import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DecisionBook,
  consultDecisions,
  loadDecisionSnapshot,
  programmaticMatch,
  recordFromCardResolution,
  sequentialDecisionIds,
} from '../decisions.js';
import { actMandate } from '../types.js';
import { github, issuePayload, REPO, rig, TENANT } from './harness.js';

function scope(
  category: string,
  extras: Partial<{ object: string; path: string; tags: string[]; repo: string }> = {},
) {
  return {
    tenantId: TENANT,
    repo: extras.repo ?? REPO,
    category,
    ...(extras.object ? { object: extras.object } : {}),
    ...(extras.path ? { path: extras.path } : {}),
    ...(extras.tags ? { tags: extras.tags } : {}),
  };
}

test('only a human user can write a standing decision', () => {
  const book = new DecisionBook({ ids: sequentialDecisionIds() });
  const agent = book.record({
    polarity: 'decided',
    verbatim: 'always rebase',
    sourceEventId: 'evt_1',
    actor: { login: 'bot', kind: 'bot' },
    scope: scope('product_direction'),
    at: 1,
  });
  assert.equal(agent.ok, false);
  if (agent.ok) return;
  assert.equal(agent.reason, 'human_only');
  const inferred = book.record({
    polarity: 'decided',
    verbatim: 'I inferred we should rebase',
    sourceEventId: 'evt_2',
    actor: { login: 'router', kind: 'system' },
    scope: scope('product_direction'),
    at: 2,
  });
  assert.equal(inferred.ok, false);
  const human = book.record({
    polarity: 'decided',
    verbatim: 'Always rebase this repo',
    sourceEventId: 'evt_3',
    actor: { login: 'alice', kind: 'user' },
    scope: scope('product_direction', { object: 'pr:inv_test:acme/app#12' }),
    at: 3,
  });
  assert.equal(human.ok, true);
  if (!human.ok) return;
  assert.equal(human.entry.origin, 'human');
  assert.equal(human.entry.verbatim, 'Always rebase this repo');
  assert.equal(human.entry.sourceEventId, 'evt_3');
  assert.equal(human.entry.entryId, 'dec_0001');
});

test('exact category+object match applies; fuzzy same-category is a hint only', () => {
  const book = new DecisionBook({ ids: sequentialDecisionIds() });
  const written = book.record({
    polarity: 'refused',
    verbatim: 'Do not comment on customer threads',
    sourceEventId: 'evt_9',
    actor: { login: 'alice', kind: 'user' },
    scope: scope('outbound_message', { object: 'issue:inv_test:acme/app#4' }),
    at: 9,
  });
  assert.equal(written.ok, true);
  const exact = book.consult(scope('outbound_message', { object: 'issue:inv_test:acme/app#4' }));
  assert.equal(exact.kind, 'exact');
  if (exact.kind !== 'exact') return;
  assert.equal(exact.entry.polarity, 'refused');
  const fuzzy = book.consult(scope('outbound_message', { object: 'issue:inv_test:acme/app#99' }));
  assert.equal(fuzzy.kind, 'fuzzy');
  if (fuzzy.kind !== 'fuzzy') return;
  assert.equal(fuzzy.hints[0]?.entryId, 'dec_0001');
  assert.equal(consultDecisions(book.list(TENANT), scope('deploy')).kind, 'none');
});

test('path and tag matches are programmatic; newest overrides', () => {
  const book = new DecisionBook({ ids: sequentialDecisionIds() });
  book.record({
    polarity: 'decided',
    verbatim: 'migrate src/db',
    sourceEventId: 'evt_a',
    actor: { login: 'alice', kind: 'user' },
    scope: scope('db_migration', { path: 'src/db' }),
    at: 10,
  });
  book.record({
    polarity: 'refused',
    verbatim: 'stop, no more migrations under src/db',
    sourceEventId: 'evt_b',
    actor: { login: 'alice', kind: 'user' },
    scope: scope('db_migration', { path: 'src/db' }),
    at: 20,
  });
  const hit = book.consult(scope('db_migration', { path: 'src/db/users.sql' }));
  assert.equal(hit.kind, 'exact');
  if (hit.kind !== 'exact') return;
  assert.equal(hit.entry.polarity, 'refused');
  assert.equal(hit.entry.verbatim, 'stop, no more migrations under src/db');
  assert.equal(
    book.list(TENANT).find((row) => row.entryId === 'dec_0001')?.supersededBy,
    'dec_0002',
  );
  book.record({
    polarity: 'decided',
    verbatim: 'ci label is fine to notify',
    sourceEventId: 'evt_c',
    actor: { login: 'alice', kind: 'user' },
    scope: scope('outbound_message', { tags: ['ci'] }),
    at: 30,
  });
  const tagged = book.consult(scope('outbound_message', { tags: ['CI', 'urgent'] }));
  assert.equal(tagged.kind, 'exact');
});

test('revoke stops auto-apply; tenant B cannot see tenant A', () => {
  const book = new DecisionBook({ ids: sequentialDecisionIds() });
  const written = book.record({
    polarity: 'decided',
    verbatim: 'deploy staging',
    sourceEventId: 'evt_d',
    actor: { login: 'alice', kind: 'user' },
    scope: scope('deploy'),
    at: 1,
  });
  assert.equal(written.ok, true);
  if (!written.ok) return;
  const other = book.consult({ tenantId: 'inv_other', repo: REPO, category: 'deploy' });
  assert.equal(other.kind, 'none');
  assert.equal(book.list('inv_other').length, 0);
  const bot = book.revoke(TENANT, written.entry.entryId, { login: 'bot', kind: 'bot' }, 2);
  assert.equal(bot.ok, false);
  const revoked = book.revoke(TENANT, written.entry.entryId, { login: 'alice', kind: 'user' }, 3);
  assert.equal(revoked.ok, true);
  assert.equal(book.consult(scope('deploy')).kind, 'none');
});

test('a prior refused decision is followed and cited instead of asking again', async () => {
  const book = new DecisionBook({ ids: sequentialDecisionIds(50) });
  book.record({
    polarity: 'refused',
    verbatim: 'Do not comment on this issue',
    sourceEventId: 'evt_old',
    actor: { login: 'alice', kind: 'user' },
    scope: scope('outbound_message', { object: `issue:${TENANT}:${REPO}#7` }),
    at: 1,
  });
  const { agent, handler, judge } = rig({ decisions: book });
  judge.inner = {
    async decide() {
      return { action: 'spawn', mandate: actMandate([REPO]), title: 'work' };
    },
  };
  handler.script = () => ({
    progress: true,
    action: {
      kind: 'other_irreversible',
      boundText: 'comment on the customer thread',
      category: 'outbound_message',
      object: `issue:${TENANT}:${REPO}#7`,
    },
  });
  const opened = await agent.ingest(github(TENANT, 'dec-ref', 'issues', issuePayload('opened', 7)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const worker = agent.worker(TENANT, opened.workerId);
  assert.notEqual(worker?.state, 'awaiting_approval');
  assert.equal(agent.store.pendingApprovals(TENANT, opened.workerId).length, 0);
  assert.equal(
    agent.store
      .audit(TENANT)
      .some((row) => row.kind === 'action_refused' && row.detail.reason === 'decision_refused'),
    true,
  );
  assert.match(worker?.progress?.lastActivity ?? '', /followed decision dec_/);
});

test('approve writes a standing decided row; hydrate from audit after restart', async () => {
  const { agent, handler, judge, store } = rig();
  judge.inner = {
    async decide() {
      return { action: 'spawn', mandate: actMandate([REPO]), title: 'ship' };
    },
  };
  handler.script = (event) => {
    if (event.type === 'approval_granted') return { progress: true };
    return { action: { kind: 'deploy', boundText: 'Deploy staging for acme/app' } };
  };
  const opened = await agent.ingest(github(TENANT, 'dec-ap', 'issues', issuePayload('opened', 8)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const pending = agent.store.pendingApprovals(TENANT, opened.workerId);
  assert.equal(pending.length, 1);
  const ok = await agent.approve(
    TENANT,
    pending[0]?.approvalId as string,
    'Deploy staging for acme/app',
  );
  assert.equal(ok.ok, true);
  const rows = agent.decisionBook().active(TENANT, REPO);
  assert.equal(
    rows.some(
      (row) => row.polarity === 'decided' && row.verbatim === 'Deploy staging for acme/app',
    ),
    true,
  );
  const restored = new DecisionBook({ ids: sequentialDecisionIds(80) });
  restored.hydrateFromAudit(store.audit(TENANT));
  assert.equal(
    restored.consult(scope('deploy', { object: `issue:${TENANT}:${REPO}#8` })).kind,
    'exact',
  );
});

test('#477 card accept/reject write the ledger; archive does not', () => {
  const book = new DecisionBook({ ids: sequentialDecisionIds() });
  const accept = recordFromCardResolution(book, {
    card: {
      cardId: 'crd_1',
      tenantId: TENANT,
      eventId: 'evt_card',
      title: 'Escalate deploy',
      reason: 'high risk',
      threadId: 'issue:1',
    },
    option: 'accept',
    actor: { login: 'alice', kind: 'user' },
    verbatim: 'yes, deploy staging',
    at: 4,
    repo: REPO,
    category: 'deploy',
    object: 'issue:1',
  });
  assert.equal(accept.ok, true);
  if (!accept.ok) return;
  assert.equal(accept.entry.polarity, 'decided');
  const archived = recordFromCardResolution(book, {
    card: {
      cardId: 'crd_2',
      tenantId: TENANT,
      eventId: 'evt_card2',
      title: 'noise',
      reason: 'low',
    },
    option: 'archive',
    actor: { login: 'alice', kind: 'user' },
    verbatim: 'later',
    at: 5,
    category: 'deploy',
  });
  assert.equal(archived.ok, false);
  if (archived.ok) return;
  assert.equal(archived.reason, 'archive_not_standing');
});

test('file snapshot round-trips entries without a sqlite bump', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sa-dec-'));
  const path = join(dir, 'decisions.json');
  const book = new DecisionBook({ ids: sequentialDecisionIds() });
  book.record({
    polarity: 'decided',
    verbatim: 'keep the API public',
    sourceEventId: 'evt_f',
    actor: { login: 'alice', kind: 'user' },
    scope: scope('product_direction'),
    at: 1,
  });
  book.persistTo(path);
  const loaded = DecisionBook.fromFile(path, sequentialDecisionIds(10));
  assert.equal(loaded.active(TENANT, REPO)[0]?.verbatim, 'keep the API public');
  const empty = loadDecisionSnapshot(join(dir, 'missing.json'));
  assert.equal(empty.entries.length, 0);
  await writeFile(path, '{not json');
  assert.equal(loadDecisionSnapshot(path).entries.length, 0);
  await rm(dir, { recursive: true, force: true });
});

test('programmaticMatch requires the same tenant and category', () => {
  const book = new DecisionBook({ ids: sequentialDecisionIds() });
  book.record({
    polarity: 'decided',
    verbatim: 'ok',
    sourceEventId: 'e',
    actor: { login: 'a', kind: 'user' },
    scope: scope('deploy', { object: 'prod' }),
    at: 1,
  });
  const [entry] = book.list(TENANT);
  assert.ok(entry);
  assert.equal(programmaticMatch(entry, scope('deploy', { object: 'prod' })), true);
  assert.equal(
    programmaticMatch(entry, scope('deploy', { object: 'prod', repo: 'other/r' })),
    false,
  );
});
