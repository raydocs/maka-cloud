import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HeuristicJudge, ModelJudge, parseModelDecision } from '../router.js';
import { FakeRouterInspect } from '../router-inspect.js';
import { github, issuePayload, rig, TENANT } from './harness.js';

test('ModelJudge without a client throws and HeuristicJudge stays the default', async () => {
  const missing = new ModelJudge();
  await assert.rejects(
    missing.decide(
      {
        eventId: 'evt',
        tenantId: TENANT,
        source: 'chat',
        type: 'user_message',
        subject: null,
        idempotencyKey: 'k',
        actor: { login: 'alice', kind: 'user' },
        occurredAt: 1,
        receivedAt: 1,
        summary: 'hi',
        fields: [],
        closesSubject: false,
      },
      { workers: [] },
    ),
    /no provider/,
  );
  const { agent } = rig();
  assert.ok(agent.judge instanceof HeuristicJudge || 'inner' in agent.judge);
});

test('an injectable client can spawn, and a garbage reply falls back to the heuristic', async () => {
  const spawned = new ModelJudge({
    async complete() {
      return '{"action":"spawn","title":"Look at the login","intensity":"observe"}';
    },
  });
  const { agent } = rig({ judge: spawned });
  const opened = await agent.ingest(github(TENANT, 'm1', 'issues', issuePayload('opened', 8)));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  assert.equal(agent.worker(TENANT, opened.workerId)?.mandate.intensity, 'observe');

  const fallback = new ModelJudge({
    async complete() {
      return 'not json at all';
    },
  });
  const second = rig({ judge: fallback });
  const issue = await second.agent.ingest(
    github(TENANT, 'm2', 'issues', issuePayload('opened', 9)),
  );
  assert.equal(issue.result, 'spawned', 'heuristic still spawns an opened issue');
});

test('a client failure falls back, and ignore/answer parse from fenced JSON', async () => {
  const broken = new ModelJudge({
    async complete() {
      throw new Error('no key');
    },
  });
  const { agent } = rig({ judge: broken });
  const opened = await agent.ingest(github(TENANT, 'm3', 'issues', issuePayload('opened', 10)));
  assert.equal(opened.result, 'spawned');

  const event = {
    eventId: 'evt',
    tenantId: TENANT,
    source: 'chat' as const,
    type: 'user_message',
    subject: null,
    idempotencyKey: 'k',
    actor: { login: 'alice' as const, kind: 'user' as const },
    occurredAt: 1,
    receivedAt: 1,
    summary: 'status?',
    fields: [['text', 'status?']] as Array<[string, string]>,
    closesSubject: false,
  };
  assert.deepEqual(
    parseModelDecision('```json\n{"action":"ignore","reason":"noise"}\n```', event),
    {
      action: 'ignore',
      reason: 'noise',
    },
  );
  assert.deepEqual(parseModelDecision('{"action":"answer","text":"No worker yet."}', event), {
    action: 'answer',
    text: 'No worker yet.',
  });
  assert.equal(parseModelDecision('{"action":"answer"}', event), undefined);
});

test('ModelJudge prefilter skips the model on a heuristic ignore and logs confidence', async () => {
  let called = 0;
  const judge = new ModelJudge(
    {
      async complete() {
        called += 1;
        return '{"action":"spawn","title":"should not run"}';
      },
    },
    new HeuristicJudge(),
    { prefilter: true, inspect: new FakeRouterInspect('log', 'CI: green') },
  );
  const decision = await judge.decide(
    {
      eventId: 'evt',
      tenantId: TENANT,
      source: 'github',
      type: 'ping',
      subject: null,
      idempotencyKey: 'k',
      actor: { login: 'alice', kind: 'user' },
      occurredAt: 1,
      receivedAt: 1,
      summary: 'noise',
      fields: [],
      closesSubject: false,
    },
    { workers: [] },
  );
  // ping is not a HeuristicJudge type — it returns ignore/no_work
  assert.equal(decision.action, 'ignore');
  assert.equal(called, 0);
  assert.equal(judge.log[0]?.source, 'prefilter');
  assert.equal(judge.log[0]?.confidence, 0.9);
});

test('parseModelDecision keeps a confidence score', () => {
  const event = {
    eventId: 'evt',
    tenantId: TENANT,
    source: 'chat' as const,
    type: 'user_message',
    subject: null,
    idempotencyKey: 'k',
    actor: { login: 'alice' as const, kind: 'user' as const },
    occurredAt: 1,
    receivedAt: 1,
    summary: 'x',
    fields: [] as Array<[string, string]>,
    closesSubject: false,
  };
  const parsed = parseModelDecision('{"action":"ignore","reason":"dup","confidence":0.4}', event);
  assert.deepEqual(parsed, { action: 'ignore', reason: 'dup', confidence: 0.4 });
});
