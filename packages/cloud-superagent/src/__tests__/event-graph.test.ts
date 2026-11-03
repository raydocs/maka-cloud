import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractSignals,
  findProgrammatic,
  programmaticHit,
  splitMerge,
  applyMerge,
  emptyGraphState,
  type GraphTicket,
} from '../event-graph.js';
import { FakeJudgeClient } from '../judge-client.js';
import { ModelJudge } from '../router.js';
import { FakeSandbox } from '../sandbox.js';
import { RecordingLead } from '../lead.js';
import { issueSubject } from '../subjects.js';
import { actMandate } from '../types.js';
import {
  commentPayload,
  github,
  issuePayload,
  prPayload,
  workflowPayload,
  REPO,
  rig,
  TENANT,
} from './harness.js';

function ticket(
  partial: Partial<GraphTicket> & Pick<GraphTicket, 'subjectKey' | 'signals'>,
): GraphTicket {
  return {
    ticketId: partial.ticketId ?? partial.subjectKey,
    tenantId: TENANT,
    subjectKey: partial.subjectKey,
    workerId: partial.workerId ?? null,
    signals: partial.signals,
    members: partial.members ?? [partial.subjectKey],
    blocked: partial.blocked ?? [],
    at: 1,
  };
}

test('programmatic signals hit on path, commit, fingerprint, and issue/PR refs', () => {
  const path = extractSignals({
    eventId: 'e',
    tenantId: TENANT,
    source: 'chat',
    type: 'user_message',
    subject: { kind: 'conversation', tenantId: TENANT, key: 'chat:1', conversationId: '1' },
    idempotencyKey: 'i',
    actor: { login: 'a', kind: 'user' },
    occurredAt: 1,
    receivedAt: 1,
    summary: 'chat',
    fields: [['text', 'src/auth/login.ts is blank']] as Array<[string, string]>,
    closesSubject: false,
  });
  assert.deepEqual(path.paths, ['src/auth/login.ts']);
  const issue = extractSignals({
    eventId: 'e2',
    tenantId: TENANT,
    source: 'github',
    type: 'issue_opened',
    subject: issueSubject(TENANT, REPO, 5),
    idempotencyKey: 'i2',
    actor: { login: 'a', kind: 'user' },
    occurredAt: 1,
    receivedAt: 1,
    summary: 'issue',
    fields: [
      ['body', 'please fix src/auth/login.ts'],
      ['sha', 'abc123def456'],
      ['stack', 'TypeError: x\n    at login'],
    ],
    closesSubject: false,
  });
  const pathHit = programmaticHit(path, issue);
  assert.equal(pathHit.hit, true);
  if (pathHit.hit) assert.match(pathHit.reason, /^path:/);
  const ci = extractSignals({
    eventId: 'e3',
    tenantId: TENANT,
    source: 'github',
    type: 'ci_failed',
    subject: { kind: 'check', tenantId: TENANT, key: 'check:1', repo: REPO },
    idempotencyKey: 'i3',
    actor: { login: 'bot', kind: 'bot' },
    occurredAt: 1,
    receivedAt: 1,
    summary: 'ci',
    fields: [['sha', 'abc123def456']],
    closesSubject: false,
  });
  assert.equal(programmaticHit(ci, issue).hit, true);
  const mentioned = {
    eventId: 'e4',
    tenantId: TENANT,
    source: 'github' as const,
    type: 'issue_opened',
    subject: issueSubject(TENANT, REPO, 20),
    idempotencyKey: 'i4',
    actor: { login: 'a', kind: 'user' as const },
    occurredAt: 1,
    receivedAt: 1,
    summary: 'issue',
    fields: [['body', 'see #12']] as Array<[string, string]>,
    closesSubject: false,
  };
  const pr = ticket({
    subjectKey: `pr:${TENANT}:${REPO}#12`,
    signals: {
      repo: REPO,
      paths: [],
      refs: [`${REPO}#12`],
      commits: [],
      fingerprints: [],
      tokens: [],
    },
  });
  assert.ok(findProgrammatic(mentioned, [pr]));
});

test('programmatic path merge does not call the router model', async () => {
  const client = new FakeJudgeClient(
    '{"action":"spawn","title":"Opened issue","intensity":"observe","confidence":0.7}',
  );
  const { agent } = rig({
    judge: new ModelJudge(client),
    sandbox: new FakeSandbox(),
    merge: { mode: 'auto' },
  });
  const opened = await agent.ingest(
    github(TENANT, 'mg-open', 'issues', issuePayload('opened', 5, 'please fix src/auth/login.ts')),
  );
  assert.equal(opened.result, 'spawned');
  const afterOpen = client.prompts.length;
  assert.ok(afterOpen >= 1);
  const chat = await agent.ingest({
    source: 'chat',
    tenantId: TENANT,
    conversationId: 'c-login',
    messageId: 'm1',
    text: 'src/auth/login.ts is still blank',
    actor: 'bob',
  });
  assert.equal(chat.result, 'merged');
  if (chat.result !== 'merged' || opened.result !== 'spawned') return;
  assert.equal(client.prompts.length, afterOpen);
  assert.equal(chat.judgeCalls, 0);
  assert.deepEqual(chat.workerIds, [opened.workerId]);
  assert.match(chat.reason, /^path:/);
});

test('observe records a suggested merge and does not attach', async () => {
  const client = new FakeJudgeClient(
    '{"action":"spawn","title":"Opened issue","intensity":"observe","confidence":0.7}',
  );
  const { agent } = rig({
    judge: new ModelJudge(client),
    sandbox: new FakeSandbox(),
  });
  const opened = await agent.ingest(
    github(TENANT, 'obs-mg', 'issues', issuePayload('opened', 6, 'please fix src/auth/login.ts')),
  );
  assert.equal(opened.result, 'spawned');
  const afterOpen = client.prompts.length;
  const held = await agent.ingest({
    source: 'chat',
    tenantId: TENANT,
    conversationId: 'c-obs',
    messageId: 'm2',
    text: 'src/auth/login.ts is blank',
    actor: 'bob',
  });
  assert.equal(held.result, 'would_merge');
  if (held.result !== 'would_merge') return;
  assert.equal(client.prompts.length, afterOpen);
  assert.equal(agent.workers(TENANT).length, 1);
  assert.equal(agent.graphOf(TENANT).edges[0]?.applied, false);
});

test('same commit merges a CI failure onto the issue worker', async () => {
  const client = new FakeJudgeClient(
    '{"action":"spawn","title":"Opened issue","intensity":"observe","confidence":0.7}',
  );
  const { agent } = rig({
    judge: new ModelJudge(client),
    sandbox: new FakeSandbox(),
    merge: { mode: 'auto' },
  });
  const opened = await agent.ingest(
    github(
      TENANT,
      'sha-open',
      'issues',
      issuePayload('opened', 7, 'please fix login abc123def456'),
    ),
  );
  assert.equal(opened.result, 'spawned');
  const afterOpen = client.prompts.length;
  const ci = await agent.ingest(
    github(TENANT, 'sha-ci', 'workflow_run', workflowPayload('failure')),
  );
  assert.equal(ci.result, 'merged');
  if (ci.result !== 'merged') return;
  assert.equal(client.prompts.length, afterOpen);
  assert.equal(ci.judgeCalls, 0);
  assert.match(ci.reason, /^commit:/);
});

test('referenced PR number merges an issue onto that PR worker', async () => {
  const { agent } = rig({ sandbox: new FakeSandbox(), merge: { mode: 'auto' } });
  const pr = await agent.ingest(github(TENANT, 'ref-pr', 'pull_request', prPayload('opened', 12)));
  assert.equal(pr.result, 'spawned');
  const issue = await agent.ingest(
    github(TENANT, 'ref-is', 'issues', issuePayload('opened', 21, 'please fix, see #12')),
  );
  assert.equal(issue.result, 'merged');
  if (issue.result !== 'merged' || pr.result !== 'spawned') return;
  assert.deepEqual(issue.workerIds, [pr.workerId]);
  assert.match(issue.reason, /^ref:/);
});

test('followRecall walks a merge in both directions and split undoes it', async () => {
  const { agent } = rig({ sandbox: new FakeSandbox(), merge: { mode: 'auto' } });
  const opened = await agent.ingest(
    github(TENANT, 'sp-open', 'issues', issuePayload('opened', 8, 'please fix src/auth/login.ts')),
  );
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const chat = await agent.ingest({
    source: 'chat',
    tenantId: TENANT,
    conversationId: 'c-split',
    messageId: 'm3',
    text: 'src/auth/login.ts still broken',
    actor: 'bob',
  });
  assert.equal(chat.result, 'merged');
  if (chat.result !== 'merged') return;
  const threadId = agent.worker(TENANT, opened.workerId)?.subject.key;
  assert.ok(threadId);
  const byMerge = agent.followRecall(TENANT, { mergeId: chat.mergeId });
  assert.equal(byMerge[0]?.triggerId, chat.eventId);
  assert.equal(byMerge[0]?.workerId, opened.workerId);
  const bySource = agent.followRecall(TENANT, { threadId: 'chat:inv_test:c-split' });
  assert.ok(bySource.some((row) => row.mergeId === chat.mergeId));
  const byIssue = agent.followRecall(TENANT, { threadId });
  assert.ok(byIssue.some((row) => row.triggerId === chat.eventId));
  agent.splitMerge(TENANT, chat.mergeId);
  const later = await agent.ingest({
    source: 'chat',
    tenantId: TENANT,
    conversationId: 'c-split',
    messageId: 'm4',
    text: 'src/auth/login.ts again',
    actor: 'bob',
  });
  assert.notEqual(later.result, 'merged');
  assert.notEqual(later.result, 'passthrough');
});

test('fuzzy merge uses the merge client; programmatic hits never do', async () => {
  const router = new FakeJudgeClient(
    '{"action":"spawn","title":"Opened issue","intensity":"observe","confidence":0.7}',
  );
  const mergeClient = new FakeJudgeClient(
    '{"merge":true,"ticketId":"issue:inv_test:acme/app#9","reason":"same checkout timeout"}',
  );
  const { agent } = rig({
    judge: new ModelJudge(router),
    sandbox: new FakeSandbox(),
    merge: { mode: 'auto' },
    mergeClient,
  });
  const first = await agent.ingest(
    github(TENANT, 'fz-1', 'issues', issuePayload('opened', 9, 'checkout timeout on payments')),
  );
  assert.equal(first.result, 'spawned');
  const after = router.prompts.length;
  const second = await agent.ingest(
    github(TENANT, 'fz-2', 'issues', issuePayload('opened', 10, 'payments checkout timeout loop')),
  );
  assert.equal(second.result, 'merged');
  assert.equal(router.prompts.length, after);
  assert.equal(mergeClient.prompts.length, 1);
});

test('footprint conflict records a scheduler collision hint', async () => {
  const { agent } = rig({ sandbox: new FakeSandbox(), scheduler: { maxWorkers: 2 } });
  const first = await agent.enqueueTask({
    tenantId: TENANT,
    subject: issueSubject(TENANT, REPO, 1),
    title: 'edit auth',
    mandate: actMandate([REPO]),
    footprint: ['src/auth.ts'],
    priority: 'high',
  });
  assert.equal(first.state, 'running');
  const second = await agent.enqueueTask({
    tenantId: TENANT,
    subject: issueSubject(TENANT, REPO, 2),
    title: 'also auth',
    mandate: actMandate([REPO]),
    footprint: ['src/auth.ts'],
    priority: 'high',
  });
  assert.equal(second.state, 'blocked');
  assert.equal(second.reason, 'footprint');
  assert.ok(agent.collisions(TENANT).some((row) => row.kind === 'footprint'));
});

test('applyMerge + splitMerge keep members and blocked keys', () => {
  const event = {
    eventId: 'evt_1',
    tenantId: TENANT,
    source: 'chat' as const,
    type: 'user_message',
    subject: {
      kind: 'conversation' as const,
      tenantId: TENANT,
      key: 'chat:x',
      conversationId: 'x',
    },
    idempotencyKey: 'k',
    actor: { login: 'a', kind: 'user' as const },
    occurredAt: 1,
    receivedAt: 1,
    summary: 'chat',
    fields: [['text', 'src/a.ts']] as Array<[string, string]>,
    closesSubject: false,
  };
  const base = ticket({
    subjectKey: 'issue:1',
    signals: {
      repo: REPO,
      paths: ['src/a.ts'],
      refs: [],
      commits: [],
      fingerprints: [],
      tokens: [],
    },
  });
  const merged = applyMerge(emptyGraphState(), {
    mergeId: 'mrg_1',
    tenantId: TENANT,
    event,
    ticket: base,
    reason: 'path:src/a.ts',
    layer: 'programmatic',
    mode: 'auto',
    applied: true,
    at: 1,
  });
  assert.ok(merged.tickets[0]?.members.includes('chat:x'));
  const split = splitMerge(merged, 'mrg_1', 2);
  assert.equal(split.tickets[0]?.members.includes('chat:x'), false);
  assert.ok(split.tickets[0]?.blocked.includes('chat:x'));
});

test('subscribed comments still skip merge and the router model', async () => {
  const client = new FakeJudgeClient(
    '{"action":"spawn","title":"Opened issue","intensity":"observe","confidence":0.7}',
  );
  const { agent } = rig({
    judge: new ModelJudge(client),
    sandbox: new FakeSandbox(),
    merge: { mode: 'auto' },
  });
  const opened = await agent.ingest(github(TENANT, 'sub-m', 'issues', issuePayload('opened', 11)));
  assert.equal(opened.result, 'spawned');
  const after = client.prompts.length;
  const comment = await agent.ingest(
    github(TENANT, 'sub-mc', 'issue_comment', commentPayload(11, 'please add logs', false, 4)),
  );
  assert.equal(comment.result, 'passthrough');
  assert.equal(client.prompts.length, after);
});
