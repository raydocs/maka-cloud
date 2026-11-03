import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyDecision,
  defaultTenantRouterConfig,
  fastPathDrop,
  fewShotPrompt,
  parseRouterCommand,
} from '../intake.js';
import { FakeJudgeClient } from '../judge-client.js';
import { ModelJudge, RecordingJudge } from '../router.js';
import { FakeSandbox } from '../sandbox.js';
import { actMandate, observeMandate } from '../types.js';
import { commentPayload, github, issuePayload, prPayload, REPO, rig, TENANT } from './harness.js';

test('classifyDecision splits explicit, inferred, and not-accepted', () => {
  const issue = {
    eventId: 'e',
    tenantId: TENANT,
    source: 'github' as const,
    type: 'issue_opened',
    subject: { kind: 'issue' as const, tenantId: TENANT, key: 'k', repo: REPO, number: 1 },
    idempotencyKey: 'i',
    actor: { login: 'alice', kind: 'user' as const },
    occurredAt: 1,
    receivedAt: 1,
    summary: 'Opened issue',
    fields: [['body', 'look at this']] as Array<[string, string]>,
    closesSubject: false,
  };
  const inferred = classifyDecision(issue, {
    action: 'spawn',
    mandate: observeMandate([REPO]),
    title: 'Opened issue',
  });
  assert.equal(inferred.class, 'inferred');
  assert.ok(inferred.confidence >= 0.5);
  const chat = {
    ...issue,
    source: 'chat' as const,
    type: 'user_message',
    fields: [['text', 'please fix the login']] as Array<[string, string]>,
  };
  const explicit = classifyDecision(chat, {
    action: 'spawn',
    mandate: actMandate([REPO], 'explicit'),
    title: 'fix',
  });
  assert.equal(explicit.class, 'explicit');
  const ignored = classifyDecision(issue, { action: 'ignore', reason: 'no_work' });
  assert.equal(ignored.class, 'not_accepted');
});

test('new tenant config defaults to observe; constructor ingest stays auto', async () => {
  assert.equal(defaultTenantRouterConfig(TENANT).mode, 'observe');
  const { agent } = rig({ sandbox: new FakeSandbox() });
  const opened = await agent.ingest(github(TENANT, 'auto-1', 'issues', issuePayload('opened', 70)));
  assert.equal(opened.result, 'spawned');
  agent.ensureRouterConfig('inv_new');
  assert.equal(agent.routerConfig('inv_new').mode, 'observe');
  const watching = rig({ sandbox: new FakeSandbox() });
  watching.agent.ensureRouterConfig(TENANT);
  const held = await watching.agent.ingest(
    github(TENANT, 'obs-1', 'issues', issuePayload('opened', 71, 'the login page is blank')),
  );
  assert.equal(held.result, 'would_accept');
  if (held.result !== 'would_accept') return;
  assert.equal(held.classification, 'inferred');
  assert.equal(watching.agent.workers(TENANT).length, 0);
  assert.equal(watching.agent.intakeMetrics(TENANT).slowWouldAccept, 1);
});

test('off drops on the Fast Path with zero judge calls', async () => {
  const { agent, judge } = rig({ sandbox: new FakeSandbox(), router: { mode: 'off' } });
  const result = await agent.ingest(github(TENANT, 'off-1', 'issues', issuePayload('opened', 72)));
  assert.equal(result.result, 'ignored');
  if (result.result !== 'ignored') return;
  assert.equal(result.reason, 'router_off');
  assert.equal(result.judgeCalls, 0);
  assert.equal(judge.calls.length, 0);
  assert.equal(agent.intakeMetrics(TENANT).fastDropped >= 1, true);
  assert.equal(agent.intakeMetrics(TENANT).byReason['fast:router_off'], 1);
});

test('Fast Path drops bots, deny rules, and rate caps without a model call', async () => {
  const client = new FakeJudgeClient('{"action":"spawn","title":"should not run"}');
  const { agent } = rig({
    sandbox: new FakeSandbox(),
    judge: new ModelJudge(client),
    intake: { maxUnownedPerMinute: 1 },
  });
  agent.setRouterConfig(TENANT, {
    mode: 'auto',
    rules: [{ id: 'no-docs', effect: 'deny', path: 'docs/**' }],
  });
  const bot = prPayload('opened', 80);
  (bot as { sender: { login: string; type: string } }).sender = {
    login: 'dependabot[bot]',
    type: 'Bot',
  };
  const deniedBot = await agent.ingest(github(TENANT, 'fp-bot', 'pull_request', bot));
  assert.equal(deniedBot.result, 'ignored');
  if (deniedBot.result !== 'ignored') return;
  assert.equal(deniedBot.reason, 'bot');
  assert.equal(client.prompts.length, 0);

  const withPath = issuePayload('opened', 81, 'please fix');
  (withPath as { issue: { title: string } }).issue.title = 'docs/readme';
  // deny path matches the `file` field; put it on a review-like issue via extra field after normalize.
  const first = await agent.ingest(github(TENANT, 'fp-ok', 'issues', issuePayload('opened', 82)));
  assert.equal(first.result, 'spawned');
  const second = await agent.ingest(
    github(TENANT, 'fp-rate', 'issues', issuePayload('opened', 83)),
  );
  assert.equal(second.result, 'ignored');
  if (second.result !== 'ignored') return;
  assert.equal(second.reason, 'rate_cap');
  assert.equal(second.judgeCalls, 0);
  assert.ok(agent.intakeMetrics(TENANT).fastDropped >= 2);
  assert.ok(client.prompts.length <= 1, 'rate cap and bots never reach the Slow Path');
});

test('deny-by-author Fast Path records a drop reason', () => {
  const event = {
    eventId: 'e',
    tenantId: TENANT,
    source: 'github' as const,
    type: 'issue_opened',
    subject: { kind: 'issue' as const, tenantId: TENANT, key: 'k', repo: REPO, number: 1 },
    idempotencyKey: 'i',
    actor: { login: 'mallory', kind: 'user' as const },
    occurredAt: 1,
    receivedAt: 1,
    summary: 'Opened issue',
    fields: [
      ['author', 'mallory'],
      ['labels', 'wontfix'],
    ] as Array<[string, string]>,
    closesSubject: false,
  };
  const drop = fastPathDrop({
    event,
    policy: {},
    meteringStop: false,
    rules: [{ id: 'no-mallory', effect: 'deny', author: 'mallory' }],
    mode: 'auto',
    handledIds: [],
    slowAt: [],
    now: 1,
  });
  assert.deepEqual(drop, { drop: true, reason: 'rule_deny:no-mallory' });
  const labeled = fastPathDrop({
    event,
    policy: {},
    meteringStop: false,
    rules: [{ id: 'no-wontfix', effect: 'deny', label: 'wontfix' }],
    mode: 'auto',
    handledIds: [],
    slowAt: [],
    now: 1,
  });
  assert.deepEqual(labeled, { drop: true, reason: 'rule_deny:no-wontfix' });
});

test('subscribed-thread events never call the router model', async () => {
  const client = new FakeJudgeClient(
    '{"action":"spawn","title":"Opened issue","intensity":"observe","confidence":0.7}',
  );
  const judge = new ModelJudge(client);
  const { agent } = rig({ judge, sandbox: new FakeSandbox() });
  const opened = await agent.ingest(
    github(TENANT, 'sub-open', 'issues', issuePayload('opened', 90)),
  );
  assert.equal(opened.result, 'spawned');
  const afterOpen = client.prompts.length;
  assert.ok(afterOpen >= 1, 'cold start uses the Slow Path');
  const comment = await agent.ingest(
    github(TENANT, 'sub-c', 'issue_comment', commentPayload(90, 'please add logs', false, 3)),
  );
  assert.equal(comment.result, 'passthrough');
  if (comment.result !== 'passthrough' || opened.result !== 'spawned') return;
  assert.equal(comment.judgeCalls, 0);
  assert.equal(client.prompts.length, afterOpen);
  assert.deepEqual(comment.workerIds, [opened.workerId]);
  assert.equal(agent.intakeMetrics(TENANT).passthrough, 1);
});

test('feedback is stored and injected as few-shot on the next Slow Path', async () => {
  const client = new FakeJudgeClient(
    '{"action":"spawn","title":"work","intensity":"observe","confidence":0.8}',
  );
  const { agent } = rig({
    judge: new ModelJudge(client),
    sandbox: new FakeSandbox(),
  });
  const opened = await agent.ingest(github(TENANT, 'fb-1', 'issues', issuePayload('opened', 91)));
  assert.equal(opened.result, 'spawned');
  const decision = agent.routerConfig(TENANT).decisions[0];
  assert.ok(decision);
  const command = agent.handleRouterCommand(TENANT, `feedback wrong ${decision.decisionId} noise`);
  assert.equal(command.ok, true);
  assert.equal(agent.routerConfig(TENANT).feedback[0]?.verdict, 'wrong');
  const shot = fewShotPrompt(agent.routerConfig(TENANT));
  assert.match(shot, /wrong/);
  await agent.ingest(github(TENANT, 'fb-2', 'issues', issuePayload('opened', 92)));
  assert.ok(client.prompts.some((row) => row.includes('Prior feedback')));
  assert.ok(client.prompts.some((row) => row.includes('suggest deny')));
});

test('router model is configured separately from the worker model', () => {
  const { agent } = rig({ sandbox: new FakeSandbox() });
  agent.setRouterConfig(TENANT, {
    models: {
      router: { provider: 'fake', model: 'router-fast', apiKeyEnv: 'MAKA_CLOUD_ROUTER_API_KEY' },
      worker: { provider: 'anthropic', model: 'worker-strong', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    },
  });
  const models = agent.routerConfig(TENANT).models;
  assert.equal(models.router?.model, 'router-fast');
  assert.equal(models.worker?.model, 'worker-strong');
  assert.notEqual(models.router?.model, models.worker?.model);
  assert.equal(models.router?.apiKeyEnv?.includes('KEY'), true);
});

test('sensitivity below the threshold is a Slow Path drop', async () => {
  const judge = new RecordingJudge();
  judge.inner = {
    async decide() {
      return { action: 'spawn', mandate: observeMandate([REPO]), title: 'maybe', confidence: 0.2 };
    },
  };
  const { agent } = rig({ judge, sandbox: new FakeSandbox() });
  agent.setRouterConfig(TENANT, { mode: 'auto', sensitivity: 0.8 });
  const result = await agent.ingest(github(TENANT, 'sens', 'issues', issuePayload('opened', 93)));
  assert.equal(result.result, 'ignored');
  if (result.result !== 'ignored') return;
  assert.equal(result.reason, 'below_sensitivity');
  assert.equal(result.judgeCalls, 1);
  assert.equal(agent.intakeMetrics(TENANT).slowDropped, 1);
});

test('parseRouterCommand covers feedback, mode, and sensitivity', () => {
  assert.deepEqual(parseRouterCommand('feedback correct dec_1'), {
    kind: 'feedback',
    verdict: 'correct',
    decisionId: 'dec_1',
  });
  assert.deepEqual(parseRouterCommand('router mode observe'), { kind: 'mode', mode: 'observe' });
  assert.deepEqual(parseRouterCommand('router sensitivity 0.7'), {
    kind: 'sensitivity',
    value: 0.7,
  });
});
