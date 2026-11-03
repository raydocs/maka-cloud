import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodingLoopHandler, FakeCoder, FakeGitHost, NodeFileTestPort } from '../loop.js';
import {
  DEFAULT_PEER_REVIEW_ROUNDS,
  FakePeerReviewClient,
  REVIEW_CAPABILITIES,
  isolateReview,
  isStyleOnlyFinding,
  mergePeerReviewStats,
  parsePeerReview,
  peerReviewSettingsFrom,
  retainSubstantiveFindings,
  runPeerReview,
  sameReviewModel,
  sealReviewEnv,
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
    assert.equal(peerReviewSettingsFrom({ enabled: true, maxRounds: 0 }).maxRounds, 3);
    assert.equal(DEFAULT_PEER_REVIEW_ROUNDS, 3);
    assert.equal(peerReviewSettingsFrom().maxRounds, 3);
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
  const nits = parsePeerReview('{"severity":"advise","findings":["nit"]}');
  assert.equal(nits.severity, 'advise');
  assert.deepEqual(nits.findings, ['nit']);
  assert.equal(sameReviewModel('coder-a', 'coder-a'), true);
  assert.equal(sameReviewModel('coder-a', 'reviewer-b'), false);
});

test('sealReviewEnv strips secret-shaped keys and never copies process.env', () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-secret-value';
  process.env.GITHUB_TOKEN = 'ghp_secret';
  try {
    const sealed = sealReviewEnv({
      PATH: '/usr/bin',
      REPO: 'acme/app',
      ANTHROPIC_API_KEY: 'sk-ant-should-drop',
      GITHUB_TOKEN: 'ghp_should-drop',
      OPENAI_API_KEY: 'sk-openai',
      AWS_SECRET_ACCESS_KEY: 'aws',
      SESSION_TOKEN: 'tok',
      DB_PASSWORD: 'pw',
    });
    assert.deepEqual(sealed, { PATH: '/usr/bin', REPO: 'acme/app' });
    const isolated = isolateReview({
      HOME: '/tmp/review',
      ANTHROPIC_API_KEY: 'sk-ant-should-drop',
    });
    assert.equal(isolated.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(isolated.env.HOME, '/tmp/review');
    assert.equal(isolated.capabilities.write, false);
    assert.equal(isolated.capabilities.network, false);
    assert.equal(isolated.capabilities.secrets, false);
    assert.equal(REVIEW_CAPABILITIES.write, false);
    assert.equal(isolateReview().env.ANTHROPIC_API_KEY, undefined);
    assert.equal(isolateReview().env.GITHUB_TOKEN, undefined);
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
    delete process.env.GITHUB_TOKEN;
  }
});

test('runPeerReview drops style-only findings and never forwards secret env', async () => {
  assert.equal(isStyleOnlyFinding('consider a comment'), true);
  assert.equal(isStyleOnlyFinding('do not ship without a changelog'), true);
  assert.equal(isStyleOnlyFinding('add() returns the first argument instead of the sum'), false);
  assert.deepEqual(retainSubstantiveFindings(['nit: rename helper', 'null deref on empty input']), {
    kept: ['null deref on empty input'],
    discarded: ['nit: rename helper'],
  });

  const client = new FakePeerReviewClient('reviewer-b');
  client.text = 'SEVERITY: block\nFINDING: consider a comment\nFINDING: changelog nit\n';
  const outcome = await runPeerReview({
    settings: peerReviewSettingsFrom({
      enabled: true,
      model: 'reviewer-b',
      workerModel: 'coder-a',
      client,
      reviewEnv: {
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'sk-ant-leak',
        GITHUB_TOKEN: 'ghp_leak',
      },
    }),
    diff: 'diff --git a/add.js b/add.js',
    currentRounds: 0,
  });
  assert.equal(outcome.allowed, true);
  assert.equal(outcome.severity, 'clear');
  assert.deepEqual(outcome.findings, []);
  assert.equal(outcome.discardedStyle.length, 2);
  assert.equal(client.lastEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(client.lastEnv.GITHUB_TOKEN, undefined);
  assert.equal(client.lastEnv.PATH, '/bin');
  assert.equal(client.lastCapabilities?.write, false);
  assert.equal(client.lastCapabilities?.network, false);
  assert.equal(client.lastCapabilities?.secrets, false);
  assert.equal(client.calls[0]?.includes('Do not report style'), true);
  assert.equal(client.calls[0]?.includes('cannot write'), true);
});

test('mergePeerReviewStats records duration, token share, and fixes', () => {
  const first = mergePeerReviewStats(
    undefined,
    {
      allowed: false,
      severity: 'block',
      findings: ['null deref on empty input'],
      discardedStyle: [],
      feedback: 'block',
      waiting: false,
      rounds: 1,
      isolation: isolateReview(),
      stats: { wallMs: 8, tokens: 30, issuesReported: 1 },
    },
    70,
  );
  assert.equal(first.issuesReported, 1);
  assert.equal(first.issuesFixed, 0);
  assert.equal(first.tokenShare, 30 / 70);
  const second = mergePeerReviewStats(
    first,
    {
      allowed: true,
      severity: 'clear',
      findings: [],
      discardedStyle: [],
      feedback: 'clear',
      waiting: false,
      rounds: 1,
      isolation: isolateReview(),
      stats: { wallMs: 4, tokens: 20, issuesReported: 0 },
    },
    130,
  );
  assert.equal(second.issuesFixed, 1);
  assert.equal(second.tokens, 50);
  assert.equal(second.wallMs, 12);
  assert.equal(second.tokenShare, 50 / 130);
});

test('default maxRounds of 3 waits on the fourth blocking round', async () => {
  const client = new FakePeerReviewClient('reviewer-b');
  client.text = 'SEVERITY: block\nFINDING: add() returns the first argument instead of the sum\n';
  const settings = peerReviewSettingsFrom({
    enabled: true,
    model: 'reviewer-b',
    workerModel: 'coder-a',
    client,
  });
  assert.equal(settings.maxRounds, 3);
  const third = await runPeerReview({
    settings,
    diff: 'diff',
    currentRounds: 2,
  });
  assert.equal(third.waiting, false);
  assert.equal(third.rounds, 3);
  const fourth = await runPeerReview({
    settings,
    diff: 'diff',
    currentRounds: 3,
  });
  assert.equal(fourth.waiting, true);
  assert.equal(fourth.rounds, 4);
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
    'SEVERITY: block\nFINDING: add() returns the first argument instead of the sum\nCORRECT: return a + b\n';
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
  const review = agent.store.audit(TENANT).find((row) => row.kind === 'peer_review');
  assert.ok(review);
  assert.equal(review.detail.write, false);
  assert.equal(review.detail.network, false);
  assert.equal(review.detail.secrets, false);
  assert.equal(review.detail.issuesReported, 1);
  assert.equal(typeof review.detail.tokenShare, 'number');
  assert.equal(typeof review.detail.wallMs, 'number');
  assert.equal(worker?.peerReviewStats?.issuesReported, 1);
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
  const review = agent.store.audit(TENANT).find((row) => row.kind === 'peer_review');
  assert.equal(review?.detail.severity, 'clear');
  assert.equal(review?.detail.discardedStyle, 1);
});

test('Superagent does not pass process.env secrets to the isolated reviewer', async () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevTok = process.env.GITHUB_TOKEN;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-process-env';
  process.env.GITHUB_TOKEN = 'ghp_process_env';
  try {
    const repoDir = await initLocalRepo(scratchFiles());
    const git = new FakeGitHost();
    const sandbox = new FakeSandbox();
    const client = new FakePeerReviewClient('reviewer-b');
    client.text = 'SEVERITY: clear\nFINDING: none\n';
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
      ids: sequentialIds(600),
      admission: { allowActors: ['alice', 'bob'] },
      peerReview: {
        enabled: true,
        model: 'reviewer-b',
        workerModel: 'coder-a',
        client,
        reviewEnv: {
          REPO: 'acme/app',
          ANTHROPIC_API_KEY: 'sk-ant-host-bag',
          GITHUB_TOKEN: 'ghp_host_bag',
        },
      },
      judge: {
        async decide() {
          return { action: 'spawn', mandate: actMandate([REPO], 'explicit'), title: 'iso' };
        },
      },
    });
    const opened = await agent.ingest(
      github(TENANT, 'pr-iso', 'pull_request', prPayload('opened', 72)),
    );
    assert.equal(opened.result, 'spawned');
    assert.equal(client.lastEnv.ANTHROPIC_API_KEY, undefined);
    assert.equal(client.lastEnv.GITHUB_TOKEN, undefined);
    assert.equal(client.lastEnv.REPO, 'acme/app');
    assert.equal(Object.hasOwn(client.lastEnv, 'ANTHROPIC_API_KEY'), false);
    assert.equal(client.lastCapabilities?.secrets, false);
    assert.equal(git.pushes.length, 1);
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevTok === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prevTok;
  }
});
