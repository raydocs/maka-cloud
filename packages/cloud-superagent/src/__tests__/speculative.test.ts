import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeBoundText } from '../loop.js';
import { FakeReviewer } from '../review.js';
import {
  DEFAULT_SPECULATIVE,
  RecordingCleanup,
  SPECULATIVE_PRIORITY,
  compareWorkerPriority,
  matchSpeculativeTrigger,
  speculativeBlocksOutbound,
  workerPriority,
} from '../speculative.js';
import { github, issuePayload, prPayload, REPO, rig, TENANT, workflowPayload } from './harness.js';

const WATCH = {
  enabled: true,
  maxConcurrent: 1,
  dailyTokens: 50_000,
  dailyUsd: 1,
  priority: SPECULATIVE_PRIORITY,
  triggers: [
    { kind: 'ci_failure' as const, repos: [REPO] },
    { kind: 'issue_match' as const, repos: [REPO], pattern: 'login' },
  ],
};

test('speculative stays off: unowned CI is still unowned_ci and settings default disabled', async () => {
  assert.equal(DEFAULT_SPECULATIVE.enabled, false);
  assert.deepEqual(DEFAULT_SPECULATIVE.triggers, []);
  const { agent, judge } = rig();
  const ci = await agent.ingest(
    github(TENANT, 'ci-off', 'workflow_run', workflowPayload('failure', 99)),
  );
  assert.equal(ci.result, 'ignored');
  if (ci.result !== 'ignored') return;
  assert.equal(ci.reason, 'unowned_ci');
  assert.equal(judge.calls.length, 0);
  assert.equal(agent.workers(TENANT).length, 0);
});

test('a CI failure on a watched PR starts a speculative worker before the Router', async () => {
  const cleanup = new RecordingCleanup();
  const { agent, judge, handler } = rig({
    speculative: WATCH,
    speculativeCleanup: cleanup,
  });
  handler.script = () => ({
    progress: true,
    plan: 'reproduced the failure',
    evidence: [{ kind: 'test', label: 'ci', body: 'red' }],
    usage: { tokens: 20, usdMicros: 40, wallMs: 8 },
  });
  const ci = await agent.ingest(
    github(TENANT, 'ci-watch', 'workflow_run', workflowPayload('failure', 21)),
  );
  assert.equal(ci.result, 'speculative');
  if (ci.result !== 'speculative') return;
  assert.equal(ci.judgeCalls, 0);
  assert.equal(judge.calls.length, 0);
  const worker = agent.worker(TENANT, ci.workerId);
  assert.equal(worker?.speculative?.status, 'ready');
  assert.equal(worker?.speculative?.trigger, 'ci_failure');
  assert.equal(worker?.plan, 'reproduced the failure');
  assert.equal(agent.store.liveSubscribers(TENANT, worker?.subject.key ?? '').length, 0);
  assert.equal(
    agent.store.audit(TENANT).some((row) => row.kind === 'speculative_started'),
    true,
  );
});

test('speculative never pushes, comments, or opens a PR until accepted', async () => {
  const { agent, handler } = rig({
    speculative: WATCH,
    reviewer: new FakeReviewer(),
  });
  const bound = mergeBoundText(REPO, 21, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  handler.script = () => ({
    progress: true,
    action: { kind: 'merge', boundText: bound },
  });
  const ci = await agent.ingest(
    github(TENANT, 'ci-push', 'workflow_run', workflowPayload('failure', 21)),
  );
  assert.equal(ci.result, 'speculative');
  if (ci.result !== 'speculative') return;
  const worker = agent.worker(TENANT, ci.workerId);
  assert.notEqual(worker?.state, 'awaiting_approval');
  assert.equal(agent.store.pendingApprovals(TENANT, ci.workerId).length, 0);
  assert.equal(
    agent.store
      .audit(TENANT)
      .some((row) => row.kind === 'action_refused' && row.detail.reason === 'speculative_blocked'),
    true,
  );
  assert.equal(
    speculativeBlocksOutbound(worker!, { kind: 'push_protected', boundText: 'Push to main' }),
    true,
  );
});

test('accept delivers the result; discard cleans state and records cost', async () => {
  const cleanup = new RecordingCleanup();
  const { agent, handler } = rig({
    speculative: WATCH,
    speculativeCleanup: cleanup,
    reviewer: new FakeReviewer(),
  });
  handler.script = () => ({
    progress: true,
    workspaceRef: 'ws_spec',
    usage: { tokens: 11, usdMicros: 22, wallMs: 3 },
  });
  const ci = await agent.ingest(
    github(TENANT, 'ci-acc', 'workflow_run', workflowPayload('failure', 22)),
  );
  assert.equal(ci.result, 'speculative');
  if (ci.result !== 'speculative') return;
  const accepted = await agent.acceptSpeculative(TENANT, ci.workerId);
  assert.equal(accepted.ok, true);
  const after = agent.worker(TENANT, ci.workerId);
  assert.equal(after?.speculative?.status, 'accepted');
  assert.equal(after?.speculative?.cost?.tokens, 11);
  assert.equal(agent.store.liveSubscribers(TENANT, after?.subject.key ?? '').length, 1);
  assert.equal(
    agent.store.audit(TENANT).some((row) => row.kind === 'speculative_accepted'),
    true,
  );

  handler.script = () => ({
    progress: true,
    workspaceRef: 'ws_drop',
    usage: { tokens: 5, usdMicros: 6, wallMs: 1 },
  });
  const other = await agent.ingest(
    github(TENANT, 'ci-drop', 'workflow_run', workflowPayload('failure', 23)),
  );
  assert.equal(other.result, 'speculative');
  if (other.result !== 'speculative') return;
  const dropped = await agent.discardSpeculative(TENANT, other.workerId);
  assert.equal(dropped.ok, true);
  assert.deepEqual(cleanup.discarded, [other.workerId]);
  assert.equal(agent.worker(TENANT, other.workerId)?.state, 'retired');
  assert.equal(agent.worker(TENANT, other.workerId)?.speculative?.status, 'discarded');
  assert.equal(
    agent.store.audit(TENANT).some((row) => row.kind === 'speculative_discarded'),
    true,
  );
});

test('after accept, a push is held as a normal approval instead of blocked', async () => {
  const { agent, handler } = rig({
    speculative: WATCH,
    reviewer: new FakeReviewer(),
  });
  handler.script = () => ({ progress: true, plan: 'fix ready' });
  const ci = await agent.ingest(
    github(TENANT, 'ci-hold', 'workflow_run', workflowPayload('failure', 24)),
  );
  assert.equal(ci.result, 'speculative');
  if (ci.result !== 'speculative') return;
  await agent.acceptSpeculative(TENANT, ci.workerId);
  handler.script = () => ({
    action: { kind: 'push_protected', boundText: 'Push to main' },
  });
  const comment = await agent.ingest({
    source: 'internal',
    tenantId: TENANT,
    type: 'nudge',
    subject: agent.worker(TENANT, ci.workerId)!.subject,
    summary: 'continue',
    idempotencyKey: 'nudge-hold',
  });
  assert.equal(comment.result, 'passthrough');
  assert.equal(agent.worker(TENANT, ci.workerId)?.state, 'awaiting_approval');
  assert.equal(agent.store.pendingApprovals(TENANT, ci.workerId).length, 1);
});

test('max concurrent speculative runs is 1 and daily token budget is hard', async () => {
  const { agent, handler } = rig({
    speculative: { ...WATCH, dailyTokens: 10 },
  });
  handler.script = () => ({
    progress: true,
    usage: { tokens: 10, usdMicros: 1, wallMs: 1 },
  });
  const first = await agent.ingest(
    github(TENANT, 'ci-cap-1', 'workflow_run', workflowPayload('failure', 31)),
  );
  assert.equal(first.result, 'speculative');
  const second = await agent.ingest(
    github(TENANT, 'ci-cap-2', 'workflow_run', workflowPayload('failure', 32)),
  );
  assert.equal(second.result, 'ignored');
  if (second.result !== 'ignored') return;
  assert.equal(second.reason, 'unowned_ci');
  assert.equal(
    agent.store
      .audit(TENANT)
      .some((row) => row.kind === 'speculative_refused' && row.detail.reason === 'concurrent_cap'),
    true,
  );

  if (first.result === 'speculative') await agent.discardSpeculative(TENANT, first.workerId);
  const third = await agent.ingest(
    github(TENANT, 'ci-cap-3', 'workflow_run', workflowPayload('failure', 33)),
  );
  assert.equal(third.result, 'ignored');
  assert.equal(
    agent.store
      .audit(TENANT)
      .some((row) => row.kind === 'speculative_refused' && row.detail.reason === 'daily_tokens'),
    true,
  );
});

test('a bot-opened matching issue does not speculate', async () => {
  const { agent, judge } = rig({ speculative: WATCH });
  const payload = issuePayload('opened', 11, 'please fix the login');
  (payload as { sender: { login: string; type: string } }).sender = {
    login: 'dependabot[bot]',
    type: 'Bot',
  };
  const result = await agent.ingest(github(TENANT, 'iss-bot', 'issues', payload));
  assert.equal(result.result, 'ignored');
  if (result.result !== 'ignored') return;
  assert.equal(result.reason, 'bot');
  assert.equal(judge.calls.length, 0);
  assert.equal(agent.workers(TENANT).length, 0);
});

test('a matching issue can speculate; a non-matching issue still goes to the Router', async () => {
  const { agent, judge, handler } = rig({ speculative: WATCH });
  handler.script = () => ({ progress: true, plan: 'draft login fix' });
  const hit = await agent.ingest(
    github(TENANT, 'iss-hit', 'issues', issuePayload('opened', 8, 'the login form 500s')),
  );
  assert.equal(hit.result, 'speculative');
  assert.equal(judge.calls.length, 0);

  const miss = await agent.ingest(
    github(TENANT, 'iss-miss', 'issues', issuePayload('opened', 9, 'docs typo')),
  );
  assert.equal(miss.result, 'spawned');
  assert.equal(judge.calls.length, 1);
});

test('speculative workers have the lowest scheduler priority', () => {
  const spec = {
    workerId: 'a',
    speculative: { status: 'running' as const, trigger: 'ci_failure', priority: 0 },
  };
  const normal = { workerId: 'b' };
  assert.equal(workerPriority(spec as never), SPECULATIVE_PRIORITY);
  assert.ok(workerPriority(normal as never) > SPECULATIVE_PRIORITY);
  // Higher priority first: a normal worker is drained before a speculative one.
  assert.ok(compareWorkerPriority(spec as never, normal as never) > 0);
});

test('trigger matcher requires an explicit repo opt-in', () => {
  const event = {
    type: 'ci_failed',
    subject: { repo: REPO, key: 'x', kind: 'pull_request', tenantId: TENANT },
    fields: [] as Array<[string, string]>,
  };
  assert.equal(matchSpeculativeTrigger(event as never, DEFAULT_SPECULATIVE), undefined);
  assert.equal(matchSpeculativeTrigger(event as never, { ...WATCH, enabled: false }), undefined);
  assert.ok(matchSpeculativeTrigger(event as never, WATCH));
});

test('an accepted speculative worker is a real owner; a later comment is pass-through', async () => {
  const { agent, handler, judge } = rig({ speculative: WATCH });
  handler.script = () => ({ progress: true });
  const ci = await agent.ingest(
    github(TENANT, 'ci-own', 'workflow_run', workflowPayload('failure', 40)),
  );
  assert.equal(ci.result, 'speculative');
  if (ci.result !== 'speculative') return;
  await agent.acceptSpeculative(TENANT, ci.workerId);
  const before = judge.calls.length;
  const comment = await agent.ingest({
    source: 'internal',
    tenantId: TENANT,
    type: 'issue_comment',
    subject: agent.worker(TENANT, ci.workerId)!.subject,
    summary: 'please continue',
    idempotencyKey: 'c-own',
    fields: [['comment', 'please continue']],
  });
  assert.equal(comment.result, 'passthrough');
  assert.equal(judge.calls.length, before);
});
