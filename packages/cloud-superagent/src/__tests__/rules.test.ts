import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { DecisionBook, sequentialDecisionIds } from '../decisions.js';
import {
  applyConcurrency,
  envelopeOf,
  parseRulesFile,
  RulesEngine,
  RulesFileSchema,
} from '../rules.js';
import { actMandate } from '../types.js';
import { github, issuePayload, prPayload, REPO, rig, TENANT } from './harness.js';

const SCHEMA = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../superagent.rules.schema.json',
);

function fileOf(rules: unknown): string {
  return JSON.stringify({ version: 1, rules });
}

test('JSON schema and zod reject a bad rules file', () => {
  const schema = JSON.parse(readFileSync(SCHEMA, 'utf8')) as { required: string[] };
  assert.deepEqual(schema.required, ['version', 'rules']);
  assert.equal(parseRulesFile('{').ok, false);
  assert.equal(parseRulesFile(JSON.stringify({ version: 2, rules: [] })).ok, false);
  const dup = parseRulesFile(
    fileOf([
      { id: 'ci-fix', match: { type: 'ci_failed' } },
      { id: 'ci-fix', match: { type: 'ci_passed' } },
    ]),
  );
  assert.equal(dup.ok, false);
  if (dup.ok) return;
  assert.match(dup.reason, /duplicate_rule/);
  const ok = parseRulesFile(
    fileOf([
      {
        id: 'ci-fix-app',
        match: {
          source: 'github',
          type: ['ci_failed'],
          object: { repo: 'acme/app' },
          tags: ['ci'],
        },
        model: 'claude-haiku-5-5',
        reasoning: 'low',
        skills: ['fix-ci'],
        oneRunPerObject: true,
        maxParallel: 2,
        notifyHuman: 'on_ask',
      },
    ]),
  );
  assert.equal(ok.ok, true);
  assert.equal(RulesFileSchema.safeParse({ version: 1, rules: [] }).success, true);
});

test('envelope is source, type, object, one-line summary, backlink', () => {
  const envelope = envelopeOf({
    eventId: 'evt_1',
    tenantId: TENANT,
    source: 'github',
    type: 'review_comment',
    subject: {
      kind: 'pull_request',
      tenantId: TENANT,
      key: `pr:${TENANT}:${REPO}#12`,
      repo: REPO,
      number: 12,
    },
    idempotencyKey: 'k',
    actor: { login: 'bob', kind: 'user' },
    occurredAt: 1,
    receivedAt: 1,
    summary: 'A review comment was added to pull request #12.',
    fields: [
      ['file', 'src/a.ts'],
      ['html_url', 'https://github.com/acme/app/pull/12'],
      ['labels', 'ci,automerge'],
    ],
    closesSubject: false,
  });
  assert.equal(envelope.source, 'github');
  assert.equal(envelope.type, 'review_comment');
  assert.equal(envelope.object.repo, REPO);
  assert.equal(envelope.object.path, 'src/a.ts');
  assert.deepEqual(envelope.object.tags, ['ci', 'automerge']);
  assert.equal(envelope.summary, 'A review comment was added to pull request #12.');
  assert.equal(envelope.backlink, 'https://github.com/acme/app/pull/12');
});

test('hot reload keeps the last good file when the next version is invalid', () => {
  let raw = fileOf([{ id: 'keep-me', match: { type: 'issue_opened' }, model: 'haiku' }]);
  let mtime = 1;
  const engine = new RulesEngine({
    path: '/tmp/superagent.rules.json',
    readFile: () => raw,
    stat: () => ({ mtimeMs: mtime }),
    now: () => 100,
  });
  assert.equal(engine.maybeReload(100), 'reloaded');
  assert.equal(engine.snapshot().rules[0]?.id, 'keep-me');
  raw = '{nope';
  mtime = 2;
  assert.equal(engine.maybeReload(200), 'kept_previous');
  assert.equal(engine.snapshot().rules[0]?.id, 'keep-me');
  assert.match(engine.lastError?.message ?? '', /invalid_json/);
  mtime = 2;
  assert.equal(engine.maybeReload(300), 'unchanged');
});

test('a matching rule spawns without the Router judge and records the hit', async () => {
  const engine = new RulesEngine({
    path: 'memory',
    readFile: () =>
      fileOf([
        {
          id: 'issue-app',
          match: { source: 'github', type: 'issue_opened', object: { repo: REPO } },
          model: 'claude-haiku-5-5',
          reasoning: 'medium',
          skills: ['triage'],
          intensity: 'act',
        },
      ]),
    stat: () => ({ mtimeMs: 1 }),
  });
  const { agent, judge } = rig({ rules: engine });
  const opened = await agent.ingest(github(TENANT, 'rule-1', 'issues', issuePayload('opened', 50)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  assert.equal(opened.judgeCalls, 0);
  assert.equal(judge.calls.length, 0);
  const worker = agent.worker(TENANT, opened.workerId);
  assert.equal(worker?.routeRule?.ruleId, 'issue-app');
  assert.equal(worker?.routeRule?.model, 'claude-haiku-5-5');
  assert.deepEqual(worker?.routeRule?.skills, ['triage']);
  assert.equal(agent.decisionBook().ruleHits(TENANT, REPO)[0]?.ruleId, 'issue-app');
  assert.equal(
    agent.store
      .audit(TENANT)
      .some((row) => row.kind === 'rule_matched' && row.detail.ruleId === 'issue-app'),
    true,
  );
});

test('no rule match falls through to the existing Router', async () => {
  const engine = new RulesEngine({
    path: 'memory',
    readFile: () => fileOf([{ id: 'only-prs', match: { type: 'pr_opened' } }]),
    stat: () => ({ mtimeMs: 1 }),
  });
  const { agent, judge } = rig({ rules: engine });
  const opened = await agent.ingest(
    github(TENANT, 'rule-miss', 'issues', issuePayload('opened', 51)),
  );
  assert.equal(opened.result, 'spawned');
  assert.equal(judge.calls.length, 1);
});

test('applyConcurrency refuses a second live worker on the same object', () => {
  const rule = { id: 'one', match: {}, oneRunPerObject: true as const };
  const envelope = envelopeOf({
    eventId: 'evt_x',
    tenantId: TENANT,
    source: 'github',
    type: 'issue_opened',
    subject: { kind: 'issue', tenantId: TENANT, key: 'issue:1', repo: REPO, number: 1 },
    idempotencyKey: 'k',
    actor: { login: 'a', kind: 'user' },
    occurredAt: 1,
    receivedAt: 1,
    summary: 'Issue #1 opened.',
    fields: [],
    closesSubject: false,
  });
  const live = {
    workerId: 'wrk',
    tenantId: TENANT,
    subject: { kind: 'issue' as const, tenantId: TENANT, key: 'issue:1', repo: REPO, number: 1 },
    state: 'running' as const,
    generation: 1,
    mandate: actMandate([REPO]),
    memory: '',
    spills: [],
    plan: '',
    transcriptPointer: null,
    sandboxRef: null,
    workspaceRef: null,
    lastEventId: null,
    lastProgressAt: 1,
    lastHeartbeatAt: 1,
    lastStepSignature: null,
    stepRepeats: 0,
    usage: { tokens: 0, usdMicros: 0, wallMs: 0 },
    evidence: [],
    createdAt: 1,
    updatedAt: 1,
    retiredAt: null,
    routeRule: { ruleId: 'one', objectId: 'issue:1' },
  };
  const blocked = applyConcurrency(rule, envelope, [live]);
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.equal(blocked.reason, 'one_run_per_object');
});

test('oneRunPerObject and maxParallel refuse a second live worker', async () => {
  const engine = new RulesEngine({
    path: 'memory',
    readFile: () =>
      fileOf([
        {
          id: 'one-pr',
          match: { type: 'pr_opened' },
          oneRunPerObject: true,
          maxParallel: 1,
          intensity: 'observe',
        },
      ]),
    stat: () => ({ mtimeMs: 1 }),
  });
  const { agent } = rig({ rules: engine });
  const first = await agent.ingest(
    github(TENANT, 'rule-pr-1', 'pull_request', prPayload('opened', 60)),
  );
  assert.equal(first.result, 'spawned');
  const again = await agent.ingest(
    github(TENANT, 'rule-pr-1b', 'pull_request', prPayload('opened', 60)),
  );
  assert.equal(again.result, 'passthrough');
  const second = await agent.ingest(
    github(TENANT, 'rule-pr-2', 'pull_request', prPayload('opened', 61)),
  );
  assert.equal(second.result, 'ignored');
  if (second.result !== 'ignored') return;
  assert.equal(second.reason, 'rule_parallel_cap');
  assert.equal(second.judgeCalls, 0);
});

test('notifyHuman always waits; resolveMustAsk records the person and may spawn', async () => {
  const engine = new RulesEngine({
    path: 'memory',
    readFile: () =>
      fileOf([
        {
          id: 'ask-first',
          match: { type: 'issue_opened', object: { repo: REPO } },
          notifyHuman: 'always',
        },
      ]),
    stat: () => ({ mtimeMs: 1 }),
  });
  const { agent } = rig({
    rules: engine,
    decisions: new DecisionBook({ ids: sequentialDecisionIds(90) }),
  });
  const opened = await agent.ingest(
    github(TENANT, 'rule-ask', 'issues', issuePayload('opened', 70)),
  );
  assert.equal(opened.result, 'must_ask');
  if (opened.result !== 'must_ask') return;
  assert.equal(opened.judgeCalls, 0);
  assert.equal(agent.workers(TENANT).length, 0);
  const resolved = await agent.resolveMustAsk(TENANT, opened.pendingId, 'accept', {
    verbatim: 'yes, take this issue',
    actor: { login: 'alice', kind: 'user' },
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.entry.polarity, 'decided');
  assert.ok(resolved.workerId);
  assert.equal(agent.worker(TENANT, resolved.workerId)?.state !== undefined, true);
});

test('an on-disk invalid first load leaves the existing Router in charge', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sa-rules-'));
  const path = join(dir, 'superagent.rules.json');
  await writeFile(path, '{"version":1,"rules":[');
  const { agent, judge } = rig({ rulesPath: path });
  const opened = await agent.ingest(
    github(TENANT, 'rule-bad', 'issues', issuePayload('opened', 80)),
  );
  assert.equal(opened.result, 'spawned');
  assert.equal(judge.calls.length, 1);
  await rm(dir, { recursive: true, force: true });
});
