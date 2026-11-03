import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodingLoopHandler, FakeCoder, FakeGitHost, NodeFileTestPort } from '../loop.js';
import {
  FakePeerReviewClient,
  parsePeerReview,
  peerReviewSettingsFrom,
  runPeerReview,
  sameReviewModel,
} from '../peer-review.js';
import { Superagent } from '../runtime.js';
import { FakeSandbox } from '../sandbox.js';
import { actMandate } from '../types.js';
import { initLocalRepo } from '../workspace.js';
import { scratchFiles } from '../loop.js';
import { sequentialIds } from '../ids.js';
import { github, prPayload, REPO, TENANT } from './harness.js';

test('peer review stays off unless the host passes enabled, and env is ignored', () => {
  const prev = process.env.MAKA_CLOUD_PEER_REVIEW;
  process.env.MAKA_CLOUD_PEER_REVIEW = '1';
  try {
    const agent = new Superagent();
    assert.equal(agent.peerReview.enabled, false);
    assert.equal(peerReviewSettingsFrom().enabled, false);
    assert.equal(peerReviewSettingsFrom({ enabled: true, maxRounds: 0 }).maxRounds, 2);
  } finally {
    if (prev === undefined) delete process.env.MAKA_CLOUD_PEER_REVIEW;
    else process.env.MAKA_CLOUD_PEER_REVIEW = prev;
  }
});

test('parsePeerReview takes the last SEVERITY and reads FINDING/CORRECT lines', () => {
  assert.deepEqual(parsePeerReview('looks fine'), {
    severity: 'clear',
    findings: [],
    correct: undefined,
  });
  assert.equal(parsePeerReview('SEVERITY: advise\nSEVERITY: block').severity, 'block');
  const parsed = parsePeerReview(
    'SEVERITY: block\nFINDING: missing test\nCORRECT: add the unit test\n',
  );
  assert.equal(parsed.severity, 'block');
  assert.deepEqual(parsed.findings, ['missing test']);
  assert.equal(parsed.correct, 'add the unit test');
  assert.equal(parsePeerReview('{"severity":"advise","findings":["nit"]}').severity, 'advise');
  assert.equal(sameReviewModel('coder-a', 'coder-a'), true);
  assert.equal(sameReviewModel('coder-a', 'reviewer-b'), false);
});

test('the same model or a missing client skips review and still allows the push', async () => {
  const same = await runPeerReview({
    settings: peerReviewSettingsFrom({
      enabled: true,
      model: 'same-model',
      workerModel: 'same-model',
      client: new FakePeerReviewClient('same-model'),
    }),
    diff: 'diff --git a/x b/x',
    currentRounds: 0,
  });
  assert.equal(same.allowed, true);
  assert.equal(same.skipped, 'same_model');

  const missing = await runPeerReview({
    settings: peerReviewSettingsFrom({ enabled: true, model: 'reviewer' }),
    diff: 'diff',
    currentRounds: 0,
  });
  assert.equal(missing.allowed, true);
  assert.equal(missing.skipped, 'no_client');
});

test('blocking review bounces the worker and waits after N rounds', async () => {
  const client = new FakePeerReviewClient('reviewer-b');
  client.text = 'SEVERITY: block\nFINDING: missing test\nCORRECT: add add.test.js\n';
  const settings = peerReviewSettingsFrom({
    enabled: true,
    model: 'reviewer-b',
    workerModel: 'coder-a',
    maxRounds: 2,
    client,
  });
  const first = await runPeerReview({
    settings,
    diff: 'diff --git a/add.js b/add.js',
    currentRounds: 0,
  });
  assert.equal(first.allowed, false);
  assert.equal(first.waiting, false);
  assert.equal(first.rounds, 1);

  const second = await runPeerReview({
    settings,
    diff: 'diff --git a/add.js b/add.js',
    currentRounds: 1,
  });
  assert.equal(second.allowed, false);
  assert.equal(second.waiting, false);

  const third = await runPeerReview({
    settings,
    diff: 'diff --git a/add.js b/add.js',
    currentRounds: 2,
  });
  assert.equal(third.allowed, false);
  assert.equal(third.waiting, true);
  assert.equal(third.rounds, 3);
});

test('CodingLoopHandler asks the fake reviewer before push and records a lesson on BLOCK', async () => {
  const repoDir = await initLocalRepo(scratchFiles());
  const git = new FakeGitHost();
  const sandbox = new FakeSandbox();
  const client = new FakePeerReviewClient('reviewer-b');
  client.text =
    'SEVERITY: block\nFINDING: do not ship without a changelog\nCORRECT: add CHANGELOG\n';
  client.usage = { tokens: 30, usdMicros: 90, wallMs: 5, inputTokens: 20, outputTokens: 10 };
  const handler = new CodingLoopHandler({
    coder: new FakeCoder(),
    tests: new NodeFileTestPort(),
    git,
    sandbox,
    repoUrl: repoDir,
    workerModel: 'coder-a',
  });
  const agent = new Superagent({
    handler,
    sandbox,
    ids: sequentialIds(400),
    admission: { allowActors: ['alice', 'bob'] },
    learning: { enabled: true, distillAfter: 99 },
    peerReview: {
      enabled: true,
      model: 'reviewer-b',
      workerModel: 'coder-a',
      maxRounds: 2,
      client,
    },
    judge: {
      async decide() {
        return { action: 'spawn', mandate: actMandate([REPO], 'explicit'), title: 'loop' };
      },
    },
  });
  const opened = await agent.ingest(
    github(TENANT, 'pr-loop', 'pull_request', prPayload('opened', 70)),
  );
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  assert.equal(git.pushes.length, 0);
  assert.equal(git.pullRequests.length, 0);
  assert.equal(client.calls.length, 1);
  const worker = agent.worker(TENANT, opened.workerId);
  assert.equal(worker?.plan, 'fix peer-review findings');
  assert.equal(worker?.progress?.phase, 'edit');
  assert.equal(agent.ledger(TENANT).tokens >= 30, true);
  assert.equal(agent.ledger(TENANT).usdMicros >= 90, true);
  assert.equal(
    agent.lessons(TENANT).some((row) => row.cause === 'peer_review'),
    true,
  );
  assert.equal(
    agent.store.audit(TENANT).some((row) => row.kind === 'peer_review'),
    true,
  );
});

test('advise findings allow the push; default-off loop tests keep publishing', async () => {
  const repoDir = await initLocalRepo(scratchFiles());
  const git = new FakeGitHost();
  const sandbox = new FakeSandbox();
  const client = new FakePeerReviewClient('reviewer-b');
  client.text = 'SEVERITY: advise\nFINDING: consider a comment\n';
  const handler = new CodingLoopHandler({
    coder: new FakeCoder(),
    tests: new NodeFileTestPort(),
    git,
    sandbox,
    repoUrl: repoDir,
  });
  const agent = new Superagent({
    handler,
    sandbox,
    ids: sequentialIds(500),
    admission: { allowActors: ['alice', 'bob'] },
    peerReview: {
      enabled: true,
      model: 'reviewer-b',
      workerModel: 'coder-a',
      client,
    },
    judge: {
      async decide() {
        return { action: 'spawn', mandate: actMandate([REPO], 'explicit'), title: 'loop' };
      },
    },
  });
  const opened = await agent.ingest(
    github(TENANT, 'pr-advise', 'pull_request', prPayload('opened', 71)),
  );
  assert.equal(opened.result, 'spawned');
  assert.equal(git.pushes.length, 1);
  assert.equal(git.pullRequests.length, 1);
});
