import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeGitHost } from '../loop.js';
import { Superagent } from '../runtime.js';
import {
  FakeSweepSource,
  analyzeSweep,
  runSweep,
  sweepBranch,
  sweepSettingsFrom,
  type SweepCommit,
} from '../sweep.js';
import { REPO, TENANT } from './harness.js';

const WEEK = 7 * 24 * 60 * 60_000;

function commit(partial: Partial<SweepCommit> & Pick<SweepCommit, 'sha' | 'title'>): SweepCommit {
  return {
    files: [],
    mergedAt: 1_000,
    ...partial,
  };
}

test('sweep stays off unless the host passes enabled, and env is ignored', () => {
  const prev = process.env.MAKA_CLOUD_SWEEP;
  process.env.MAKA_CLOUD_SWEEP = '1';
  try {
    const agent = new Superagent();
    assert.equal(agent.sweep.enabled, false);
    assert.equal(sweepSettingsFrom().enabled, false);
    assert.equal(sweepSettingsFrom({ enabled: true }).enabled, true);
  } finally {
    if (prev === undefined) delete process.env.MAKA_CLOUD_SWEEP;
    else process.env.MAKA_CLOUD_SWEEP = prev;
  }
});

test('analyzeSweep finds duplicates, temp patches, leftover dead code, and diary docs', () => {
  const findings = analyzeSweep([
    commit({
      sha: 'aaa1111',
      title: 'HACK temp workaround for login',
      files: ['src/login.ts', 'src/login.bak'],
      patch: 'export function parseUser() {}\n// unused leftover',
      mergedAt: 10,
    }),
    commit({
      sha: 'bbb2222',
      title: 'today i wrote scratch notes',
      files: ['docs/notes.md', 'lib/login.ts'],
      patch: 'export function parseUser() {}\nwhat i did this week',
      mergedAt: 20,
    }),
  ]);
  const kinds = findings.map((row) => row.kind).sort();
  assert.equal(kinds.includes('duplicate'), true);
  assert.equal(kinds.includes('temp_patch'), true);
  assert.equal(kinds.includes('dead_code'), true);
  assert.equal(kinds.includes('changelog_docs'), true);
});

test('runSweep opens a cleanup PR on a sweep branch and never pushes main', async () => {
  const git = new FakeGitHost();
  const source = new FakeSweepSource();
  source.commits = [
    commit({
      sha: 'ccc3333',
      title: 'FIXME quick fix',
      files: ['src/hotfix.ts'],
      patch: 'export function hotfix() { /* TEMP */ }',
      mergedAt: 50,
    }),
  ];
  const off = await runSweep({
    settings: sweepSettingsFrom(),
    tenantId: TENANT,
    repo: REPO,
    since: 0,
    at: WEEK,
  });
  assert.equal(off.skipped, 'disabled');
  assert.equal(git.pullRequests.length, 0);

  const opened = await runSweep({
    settings: sweepSettingsFrom({ enabled: true, source, git, repo: REPO }),
    tenantId: TENANT,
    repo: REPO,
    since: 0,
    at: WEEK,
  });
  assert.equal(opened.skipped, undefined);
  assert.ok(opened.pr);
  assert.equal(opened.pr.branch, sweepBranch(WEEK));
  assert.match(opened.pr.branch, /^maka\/sa-sweep-/);
  assert.notEqual(opened.pr.branch, 'main');
  assert.equal(git.pushes.length, 0);
  assert.equal(git.merged.length, 0);
  assert.equal(git.pullRequests.length, 1);
  assert.equal(git.pullRequests[0]?.branch, opened.pr.branch);
  assert.match(git.pullRequests[0]?.body ?? '', /Review and CI must pass/);
  assert.match(git.pullRequests[0]?.body ?? '', /does not push to main/);
});

test('Superagent.runSweep records the PR and stays default-off', async () => {
  const git = new FakeGitHost();
  const source = new FakeSweepSource();
  source.commits = [
    commit({
      sha: 'ddd4444',
      title: 'XXX workaround',
      files: ['legacy/old.orig'],
      patch: 'export function leftover() {}',
      mergedAt: Date.now() - 60_000,
    }),
  ];
  const quiet = new Superagent();
  const skipped = await quiet.runSweep(TENANT, REPO);
  assert.equal(skipped.skipped, 'disabled');

  const agent = new Superagent({
    sweep: { enabled: true, source, git, repo: REPO },
  });
  const result = await agent.runSweep(TENANT);
  assert.ok(result.pr);
  assert.equal(git.pushes.length, 0);
  const row = agent.store.audit(TENANT).find((item) => item.kind === 'sweep_opened');
  assert.ok(row);
  assert.equal(row.detail.findings, result.findings.length);
  assert.equal(row.detail.branch, result.pr.branch);
});
