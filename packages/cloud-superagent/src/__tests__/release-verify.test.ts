import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Superagent } from '../runtime.js';
import { actMandate } from '../types.js';
import {
  FakeVersionProbe,
  liveContainsCommit,
  looksLikeRelease,
  parseVersionSha,
  releaseVerifySettingsFrom,
  verifyRelease,
} from '../release-verify.js';
import { github, prPayload, REPO, rig, TENANT } from './harness.js';

test('release verify stays off unless the host passes enabled, and env is ignored', () => {
  const prev = process.env.MAKA_CLOUD_RELEASE_VERIFY;
  process.env.MAKA_CLOUD_RELEASE_VERIFY = '1';
  try {
    const agent = new Superagent();
    assert.equal(agent.releaseVerify.enabled, false);
    assert.equal(releaseVerifySettingsFrom().enabled, false);
    assert.equal(releaseVerifySettingsFrom({ enabled: true }).enabled, true);
    assert.equal(releaseVerifySettingsFrom({ enabled: true }).versionUrl, undefined);
  } finally {
    if (prev === undefined) delete process.env.MAKA_CLOUD_RELEASE_VERIFY;
    else process.env.MAKA_CLOUD_RELEASE_VERIFY = prev;
  }
});

test('parseVersionSha reads json sha/commit/version or a bare hex', () => {
  assert.equal(parseVersionSha('{"sha":"abc1234def"}'), 'abc1234def');
  assert.equal(parseVersionSha('{"commit":"deadbeef01"}'), 'deadbeef01');
  assert.equal(parseVersionSha('{"version":"1.2.3+cafe012"}'), 'cafe012');
  assert.equal(parseVersionSha('cafe012\n'), 'cafe012');
  assert.equal(liveContainsCommit('deadbeef01', 'deadbeef01'), true);
  assert.equal(liveContainsCommit('deadbee', 'deadbeef01'), true);
  assert.equal(liveContainsCommit('deadbeef01', 'deadbee'), true);
  assert.equal(liveContainsCommit('ffff0001', 'deadbeef01'), false);
  assert.equal(
    looksLikeRelease({
      evidence: 'merged',
      signals: [{ kind: 'merged', repo: REPO, number: 1 }],
    }),
    true,
  );
  assert.equal(
    looksLikeRelease({
      evidence: 'file only',
      signals: [{ kind: 'file', path: '/tmp/a' }],
    }),
    false,
  );
});

test('verifyRelease skips without a URL and never calls the probe', async () => {
  const probe = new FakeVersionProbe();
  const skipped = await verifyRelease({
    settings: releaseVerifySettingsFrom({
      enabled: true,
      probe,
    }),
    mergeSha: 'deadbeef01',
    now: () => 10,
  });
  assert.equal(skipped.complete, true);
  assert.equal(skipped.escalate, false);
  assert.equal(skipped.record.status, 'skipped');
  assert.match(skipped.record.reason, /no version endpoint/);
  assert.equal(probe.reads.length, 0);

  const off = await verifyRelease({
    settings: releaseVerifySettingsFrom({
      enabled: false,
      versionUrl: 'https://app.test/version',
      probe,
    }),
    mergeSha: 'deadbeef01',
    now: () => 10,
  });
  assert.equal(off.record.status, 'skipped');
  assert.equal(off.record.reason, 'release-verify off');
  assert.equal(probe.reads.length, 0);
});

test('verifyRelease confirms when the fake probe later contains the merge sha', async () => {
  const probe = new FakeVersionProbe();
  probe.failUntil = 1;
  probe.oldBody = '{"sha":"oldold01"}';
  probe.body = '{"sha":"deadbeef01"}';
  let now = 0;
  const result = await verifyRelease({
    settings: releaseVerifySettingsFrom({
      enabled: true,
      versionUrl: 'https://app.test/version',
      timeoutMs: 30,
      pollMs: 5,
      probe,
      sleep: async (ms) => {
        now += ms;
      },
    }),
    mergeSha: 'deadbeef01',
    now: () => now,
  });
  assert.equal(result.complete, true);
  assert.equal(result.record.status, 'confirmed');
  assert.equal(result.record.seen, 'deadbeef01');
  assert.equal(probe.reads.length, 2);
  assert.deepEqual(probe.reads, ['https://app.test/version', 'https://app.test/version']);
});

test('verifyRelease fails and asks for escalate when the live sha never matches', async () => {
  const probe = new FakeVersionProbe();
  probe.body = '{"sha":"ffff0001"}';
  let now = 0;
  const result = await verifyRelease({
    settings: releaseVerifySettingsFrom({
      enabled: true,
      versionUrl: 'https://app.test/version',
      timeoutMs: 20,
      pollMs: 5,
      probe,
      sleep: async (ms) => {
        now += ms;
      },
    }),
    mergeSha: 'deadbeef01',
    now: () => now,
  });
  assert.equal(result.complete, false);
  assert.equal(result.escalate, true);
  assert.equal(result.record.status, 'failed');
  assert.match(result.record.reason, /does not contain/);
});

test('a Done claim without release-verify stays retired (default skip is silent)', async () => {
  const { agent, handler } = rig({
    doneWorld: {
      pull: async () => ({ merged: true, mergeSha: 'deadbeef01' }),
      published: async () => true,
    },
  });
  handler.script = () => ({
    progress: true,
    done: {
      evidence: 'merged and published',
      signals: [
        { kind: 'merged', repo: REPO, number: 12 },
        { kind: 'published', package: '@acme/app', version: '1.0.0' },
      ],
    },
  });
  const opened = await agent.ingest(github(TENANT, 'rv-off', 'pull_request', prPayload('opened')));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  assert.equal(agent.worker(TENANT, opened.workerId)?.state, 'retired');
  assert.equal(
    agent.store.audit(TENANT).some((row) => row.kind === 'release_verify'),
    false,
  );
});

test('enabled verify without a URL retires and notes the skip in progress', async () => {
  const { agent, handler } = rig({
    releaseVerify: { enabled: true },
    doneWorld: {
      pull: async () => ({ merged: true, mergeSha: 'deadbeef01' }),
      published: async () => true,
    },
    judge: {
      async decide() {
        return { action: 'spawn', mandate: actMandate([REPO], 'explicit'), title: 'rv' };
      },
    },
  });
  handler.script = () => ({
    progress: true,
    done: {
      evidence: 'merged and published',
      signals: [
        { kind: 'merged', repo: REPO, number: 12 },
        { kind: 'published', package: '@acme/app', version: '1.0.0' },
      ],
    },
  });
  const opened = await agent.ingest(github(TENANT, 'rv-skip', 'pull_request', prPayload('opened')));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const worker = agent.worker(TENANT, opened.workerId);
  assert.equal(worker?.state, 'retired');
  assert.match(worker?.progress?.lastActivity ?? '', /no version endpoint/);
  const row = agent.store.audit(TENANT).find((item) => item.kind === 'release_verify');
  assert.equal(row?.detail.status, 'skipped');
});

test('confirmed live sha retires the worker and writes the ledger', async () => {
  const probe = new FakeVersionProbe();
  probe.body = '{"sha":"deadbeef01"}';
  const { agent, handler } = rig({
    releaseVerify: {
      enabled: true,
      versionUrl: 'https://app.test/version',
      probe,
      timeoutMs: 20,
      pollMs: 5,
    },
    doneWorld: {
      pull: async () => ({ merged: true, mergeSha: 'deadbeef01' }),
      published: async () => true,
    },
    judge: {
      async decide() {
        return { action: 'spawn', mandate: actMandate([REPO], 'explicit'), title: 'rv' };
      },
    },
  });
  handler.script = () => ({
    progress: true,
    done: {
      evidence: 'merged and published',
      signals: [
        { kind: 'merged', repo: REPO, number: 12 },
        { kind: 'published', package: '@acme/app', version: '1.0.0' },
      ],
    },
  });
  const opened = await agent.ingest(github(TENANT, 'rv-ok', 'pull_request', prPayload('opened')));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const worker = agent.worker(TENANT, opened.workerId);
  assert.equal(worker?.state, 'retired');
  assert.equal(worker?.releaseVerify?.status, 'confirmed');
  assert.equal(worker?.mergeSha, 'deadbeef01');
  assert.match(worker?.progress?.lastActivity ?? '', /confirmed/);
  assert.equal(probe.reads.length, 1);
  assert.equal(
    agent.store.audit(TENANT).some((row) => row.kind === 'release_verify'),
    true,
  );
});

test('mismatch or timeout marks the worker stuck and hands it to the watchdog', async () => {
  const probe = new FakeVersionProbe();
  probe.body = '{"sha":"ffff0001"}';
  const cards: Array<{ workerId: string }> = [];
  const { agent, handler } = rig({
    releaseVerify: {
      enabled: true,
      versionUrl: 'https://app.test/version',
      probe,
      timeoutMs: 10,
      pollMs: 5,
    },
    onEscalate: (card) => cards.push(card),
    doneWorld: {
      pull: async () => ({ merged: true, mergeSha: 'deadbeef01' }),
      published: async () => true,
    },
    judge: {
      async decide() {
        return { action: 'spawn', mandate: actMandate([REPO], 'explicit'), title: 'rv' };
      },
    },
  });
  handler.script = () => ({
    progress: true,
    done: {
      evidence: 'merged and published',
      signals: [
        { kind: 'merged', repo: REPO, number: 12 },
        { kind: 'published', package: '@acme/app', version: '1.0.0' },
      ],
    },
  });
  const opened = await agent.ingest(github(TENANT, 'rv-fail', 'pull_request', prPayload('opened')));
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const worker = agent.worker(TENANT, opened.workerId);
  assert.equal(worker?.state, 'stuck');
  assert.equal(worker?.releaseVerify?.status, 'failed');
  assert.equal(agent.escalations.length, 1);
  assert.equal(cards.length, 1);
  assert.equal(
    agent.store.audit(TENANT).some((row) => row.kind === 'stuck'),
    true,
  );
});
