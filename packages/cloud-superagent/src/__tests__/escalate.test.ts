import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bandOf, compositeScore, heuristicScore, parseScore } from '../escalate.js';
import { FakeJudgeClient } from '../judge-client.js';
import { RecordingLead } from '../lead.js';
import { ModelJudge } from '../router.js';
import { FakeSandbox } from '../sandbox.js';
import { formatStatusText } from '../progress.js';
import { github, issuePayload, REPO, rig, TENANT } from './harness.js';
import { issueSubject } from '../subjects.js';

test('heuristic score splits work, urgent, and risk', () => {
  const base = {
    eventId: 'e',
    tenantId: TENANT,
    source: 'github' as const,
    type: 'issue_opened',
    subject: issueSubject(TENANT, REPO, 1),
    idempotencyKey: 'i',
    actor: { login: 'a', kind: 'user' as const },
    occurredAt: 1,
    receivedAt: 1,
    summary: 'Opened issue',
    fields: [['body', 'please fix the login']] as Array<[string, string]>,
    closesSubject: false,
  };
  const work = heuristicScore(base);
  assert.ok(work.value >= 0.7);
  assert.equal(bandOf(work, { low: 0.25, high: 0.85, riskHuman: 0.8 }), 'medium');
  const risky = heuristicScore({
    ...base,
    fields: [['body', 'prod secrets leak, please rotate']],
  });
  assert.ok(risky.risk >= 0.8);
  assert.equal(bandOf(risky, { low: 0.25, high: 0.85, riskHuman: 0.8 }), 'high');
  assert.ok(compositeScore(work) > 0.2);
});

test('escalation stays off so existing spawn is unchanged', async () => {
  const { agent } = rig({ sandbox: new FakeSandbox() });
  const opened = await agent.ingest(
    github(TENANT, 'esc-off', 'issues', issuePayload('opened', 30)),
  );
  assert.equal(opened.result, 'spawned');
  assert.equal(agent.escalateMetrics(TENANT).scoreCalls, 0);
  assert.equal(agent.decisionCards(TENANT).length, 0);
});

test('low scores archive without a router model call', async () => {
  const client = new FakeJudgeClient(
    '{"action":"spawn","title":"should not run","intensity":"observe","confidence":0.7}',
  );
  const { agent } = rig({
    judge: new ModelJudge(client),
    sandbox: new FakeSandbox(),
    escalate: { enabled: true, thresholds: { low: 0.9, high: 0.99, riskHuman: 0.99 } },
  });
  const result = await agent.ingest(
    github(TENANT, 'esc-low', 'issues', issuePayload('opened', 31)),
  );
  assert.equal(result.result, 'archived');
  if (result.result !== 'archived') return;
  assert.equal(result.band, 'low');
  assert.equal(result.judgeCalls, 0);
  assert.equal(client.prompts.length, 0);
  assert.equal(agent.escalateMetrics(TENANT).archived, 1);
});

test('high risk opens a waiting-human card and does not speak', async () => {
  const lead = new RecordingLead();
  const client = new FakeJudgeClient(
    '{"action":"spawn","title":"should not run","intensity":"observe","confidence":0.7}',
  );
  const { agent } = rig({
    judge: new ModelJudge(client),
    sandbox: new FakeSandbox(),
    lead,
    escalate: { enabled: true },
  });
  const result = await agent.ingest(
    github(
      TENANT,
      'esc-high',
      'issues',
      issuePayload('opened', 32, 'prod secrets leak, please rotate credentials'),
    ),
  );
  assert.equal(result.result, 'escalated');
  if (result.result !== 'escalated') return;
  assert.equal(result.judgeCalls, 0);
  assert.equal(client.prompts.length, 0);
  assert.equal(lead.messages.length, 0);
  assert.equal(agent.workers(TENANT).length, 0);
  const snap = agent.statusSnapshot(TENANT);
  assert.equal(snap.decisions?.[0]?.cardId, result.cardId);
  assert.match(formatStatusText(snap), /waiting on human/);
  const resolved = await agent.resolveDecisionCard(TENANT, result.cardId, 'archive');
  assert.equal(resolved.ok, true);
  assert.equal(agent.decisionCards(TENANT)[0]?.state, 'archived');
  assert.equal(agent.escalateMetrics(TENANT).escalated, 1);
});

test('accepting a card records feedback and can start the worker', async () => {
  const { agent } = rig({
    sandbox: new FakeSandbox(),
    escalate: { enabled: true },
  });
  const result = await agent.ingest(
    github(
      TENANT,
      'esc-acc',
      'issues',
      issuePayload('opened', 33, 'urgent prod outage, secrets leak'),
    ),
  );
  assert.equal(result.result, 'escalated');
  if (result.result !== 'escalated') return;
  const resolved = await agent.resolveDecisionCard(TENANT, result.cardId, 'accept');
  assert.equal(resolved.ok, true);
  assert.equal(agent.decisionCards(TENANT)[0]?.resolution, 'accept');
  assert.ok(agent.queueOf(TENANT).length + agent.workers(TENANT).length >= 1);
});

test('cheap score client is counted separately from the router judge', async () => {
  const router = new FakeJudgeClient(
    '{"action":"spawn","title":"Opened issue","intensity":"observe","confidence":0.7}',
  );
  const score = new FakeJudgeClient('{"value":0.6,"urgency":0.5,"risk":0.2,"reason":"medium"}');
  const { agent } = rig({
    judge: new ModelJudge(router),
    sandbox: new FakeSandbox(),
    escalate: { enabled: true },
    scoreClient: score,
  });
  const opened = await agent.ingest(
    github(TENANT, 'esc-mid', 'issues', issuePayload('opened', 34)),
  );
  assert.equal(opened.result, 'spawned');
  assert.equal(score.prompts.length, 1);
  assert.match(score.prompts[0] ?? '', /Score this event/);
  assert.equal(agent.escalateMetrics(TENANT).scoreCalls, 1);
  assert.equal(agent.escalateMetrics(TENANT).assigned, 1);
  assert.ok(router.prompts.length >= 1);
});

test('parseScore reads the cheap-model JSON', () => {
  const score = parseScore('noise {"value":0.2,"urgency":0.1,"risk":0.9,"reason":"rce"}');
  assert.deepEqual(score, { value: 0.2, urgency: 0.1, risk: 0.9, reason: 'rce' });
});
