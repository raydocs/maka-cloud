import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodingLoopHandler, FakeCoder, FakeGitHost, NodeFileTestPort } from '../loop.js';
import { FakeSandbox } from '../sandbox.js';
import {
  actMandate,
  emptyUsage,
  observeMandate,
  type NormalizedEvent,
  type WorkerRecord,
} from '../types.js';
import { commentPayload, github, issuePayload, REPO, rig, TENANT } from './harness.js';

class CountingCoder extends FakeCoder {
  applies = 0;
  override async apply(input: Parameters<FakeCoder['apply']>[0]): ReturnType<FakeCoder['apply']> {
    this.applies += 1;
    return super.apply(input);
  }
}

test('resolveDecisionCard writes the ledger and must-ask rows join status decisions', async () => {
  const { agent, handler, judge } = rig({
    sandbox: new FakeSandbox(),
    escalate: { enabled: true },
  });
  const opened = await agent.ingest(
    github(
      TENANT,
      'wire-card',
      'issues',
      issuePayload('opened', 70, 'prod secrets leak, please rotate credentials'),
    ),
  );
  assert.equal(opened.result, 'escalated');
  if (opened.result !== 'escalated') return;
  const accepted = await agent.resolveDecisionCard(TENANT, opened.cardId, 'accept');
  assert.equal(accepted.ok, true);
  const standing = agent.decisionBook().list(TENANT);
  assert.equal(standing.length, 1);
  assert.equal(standing[0]?.polarity, 'decided');
  assert.equal(standing[0]?.origin, 'human');

  const archived = await agent.ingest(
    github(
      TENANT,
      'wire-arch',
      'issues',
      issuePayload('opened', 71, 'prod secrets leak, please rotate credentials'),
    ),
  );
  assert.equal(archived.result, 'escalated');
  if (archived.result !== 'escalated') return;
  const archivedCard = await agent.resolveDecisionCard(TENANT, archived.cardId, 'archive');
  assert.equal(archivedCard.ok, true);
  assert.equal(agent.decisionBook().list(TENANT).length, 1);

  judge.inner = {
    async decide() {
      return { action: 'spawn', mandate: actMandate([REPO], 'explicit'), title: 'act' };
    },
  };
  handler.script = () => ({
    progress: true,
    action: { kind: 'other_irreversible', boundText: 'drop table sessions' },
  });
  const spawned = await agent.ingest(
    github(TENANT, 'wire-ask', 'issues', issuePayload('opened', 72, 'please fix the login')),
  );
  assert.equal(spawned.result, 'spawned');
  if (spawned.result !== 'spawned') return;
  const snap = agent.statusSnapshot(TENANT);
  const pending = agent.pendingMustAsks(TENANT);
  assert.equal(pending.length > 0, true);
  assert.equal(
    snap.decisions?.some((row) => row.cardId === pending[0]?.pendingId && row.state === 'pending'),
    true,
  );
  assert.equal(snap.mustAskPending?.[0]?.pendingId, pending[0]?.pendingId);
});

test('an exact deploy decision does not open another escalation card', async () => {
  const { agent } = rig({
    sandbox: new FakeSandbox(),
    escalate: { enabled: true, thresholds: { low: 0, high: 0.01, riskHuman: 2 } },
  });
  const recorded = agent.recordHumanDecision({
    polarity: 'decided',
    verbatim: 'deploy the api',
    sourceEventId: 'evt_prior',
    actor: { login: 'alice', kind: 'user' },
    scope: { tenantId: TENANT, repo: REPO, category: 'deploy' },
  });
  assert.equal(recorded.ok, true);
  const result = await agent.ingest(
    github(TENANT, 'wire-skip', 'issues', issuePayload('opened', 73, 'please deploy the api')),
  );
  assert.notEqual(result.result, 'escalated');
  assert.equal(agent.decisionCards(TENANT).length, 0);
});

test('speculative outbound does not open a second decision card', async () => {
  const { agent, handler, judge } = rig({ sandbox: new FakeSandbox() });
  judge.inner = {
    async decide() {
      return { action: 'spawn', mandate: actMandate([REPO], 'explicit'), title: 'act' };
    },
  };
  const opened = await agent.ingest(
    github(TENANT, 'wire-spec', 'issues', issuePayload('opened', 74)),
  );
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const worker = agent.worker(TENANT, opened.workerId);
  assert.ok(worker);
  agent.store.putWorker({
    ...worker,
    speculative: { status: 'running', trigger: 'ci_failure', priority: 0 },
  });
  handler.script = () => ({
    progress: true,
    action: { kind: 'other_irreversible', boundText: 'post a comment on the issue' },
  });
  const again = await agent.ingest(
    github(TENANT, 'wire-spec-c', 'issue_comment', commentPayload(74, 'ship it', false, 8)),
  );
  assert.equal(again.result, 'passthrough');
  assert.notEqual(agent.worker(TENANT, opened.workerId)?.state, 'awaiting_approval');
  assert.equal(agent.pendingMustAsks(TENANT).length, 0);
  assert.equal(agent.statusSnapshot(TENANT).decisions, undefined);
  assert.equal(
    agent.store.audit(TENANT).some((row) => row.detail.reason === 'speculative_blocked'),
    true,
  );
});

test('CodingLoopHandler applies a duplex cancel before the coding step, and pause still verifies the box stopped', async () => {
  const coder = new CountingCoder();
  const handler = new CodingLoopHandler({
    coder,
    tests: new NodeFileTestPort(),
    git: new FakeGitHost(),
  });
  const cancel: NormalizedEvent = {
    eventId: 'evt_cancel',
    tenantId: TENANT,
    source: 'internal',
    type: 'user_cancel',
    subject: null,
    idempotencyKey: 'cancel',
    actor: { login: 'alice', kind: 'user' },
    occurredAt: 1,
    receivedAt: 2,
    summary: 'cancel',
    fields: [['text', 'cancel']],
    closesSubject: false,
  };
  const open: NormalizedEvent = {
    ...cancel,
    eventId: 'evt_open',
    type: 'issue_opened',
    idempotencyKey: 'open',
    summary: 'open',
    fields: [],
    receivedAt: 1,
  };
  const stopped = await handler.handle(
    {
      worker: {
        workerId: 'wrk_wire',
        tenantId: TENANT,
        subject: { kind: 'issue', tenantId: TENANT, key: 'k', repo: REPO, number: 1 },
        state: 'running',
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
        seenEventIds: [],
        usage: emptyUsage(),
        evidence: [],
        createdAt: 1,
        updatedAt: 1,
        retiredAt: null,
      } satisfies WorkerRecord,
      event: open,
      sandbox: new FakeSandbox(),
      orgSecrets: {
        async has() {
          return false;
        },
        async inject() {
          throw new Error('no secrets');
        },
      },
      recall: () => '',
      pollInbox: () => [cancel],
    },
    open,
  );
  assert.equal(coder.applies, 0);
  assert.match(stopped.plan ?? '', /cancelled/);
  assert.equal(handler instanceof CodingLoopHandler, true);

  const sandbox = new FakeSandbox();
  const coding = new CodingLoopHandler({
    coder: new FakeCoder(),
    tests: new NodeFileTestPort(),
    git: new FakeGitHost(),
  });
  const { agent } = rig({
    handler: coding,
    sandbox,
    sandboxRef: 'box-wire',
    judge: {
      async decide() {
        return { action: 'spawn' as const, mandate: observeMandate([REPO]), title: 'observe' };
      },
    },
  });
  const spawned = await agent.ingest(
    github(TENANT, 'wire-pause', 'issues', issuePayload('opened', 75)),
  );
  assert.equal(spawned.result, 'spawned');
  if (spawned.result !== 'spawned') return;
  const paused = await agent.pause(TENANT, spawned.workerId);
  assert.equal(paused.ok, true);
  assert.equal(agent.worker(TENANT, spawned.workerId)?.pausedVerified, true);
  sandbox.machines.set('box-wire', { id: 'box-wire', state: 'running' });
  sandbox.suspend = async () => undefined;
  agent.store.putWorker({
    ...agent.worker(TENANT, spawned.workerId)!,
    state: 'sleeping',
    pausedVerified: false,
    pausedFrom: undefined,
  });
  const refused = await agent.pause(TENANT, spawned.workerId);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.reason, 'box_still_running');
});
