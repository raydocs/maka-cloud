import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubSignalReader, SignalReadError } from '../cards/signals.js';
import {
  busyRoutes,
  cleanRoutes,
  fakeGitHub,
  NOW,
  REPO_URL,
  type Routes,
} from './cards-fixtures.js';

const target = { repo: 'acme/widgets', defaultBranch: 'main', selfLogins: ['maka-bot'] };
const reader = (routes: Routes, token: string | null = 'ghs_test') => {
  const github = fakeGitHub(routes);
  return {
    ...github,
    reader: new GitHubSignalReader({
      baseUrl: 'https://api.github.test',
      fetch: github.fetch,
      token: () => token ?? undefined,
      now: () => NOW,
    }),
  };
};

test('a busy repository is read into the signals the cards are made from', async () => {
  const { reader: r } = reader(busyRoutes());
  const signals = await r.read(target);
  assert.deepEqual(signals.failingOnDefault, [{ name: 'CI', runId: 900, headSha: 'c'.repeat(40) }]);
  assert.deepEqual(signals.flaky, [{ name: 'CI', shas: ['a'.repeat(40), 'b'.repeat(40)] }]);
  assert.deepEqual(
    signals.advisories.map((a) => [a.packageName, a.severity]),
    [
      ['lodash', 'high'],
      ['minimist', 'critical'],
    ],
    'a dismissed alert is not one',
  );
  assert.deepEqual(
    signals.ownPulls.map((p) => [p.number, p.conflicts, p.failingChecks, p.unansweredComments]),
    [
      [12, true, [], 0],
      [14, false, ['unit'], 0],
      [15, false, [], 1],
    ],
    "only the employee's own branches in the repository itself; a reply from the employee answers a thread",
  );
  assert.deepEqual(signals.ownPulls[2]?.commentIds, [1]);
  assert.deepEqual(
    signals.newIssues.map((i) => i.number),
    [31],
    'old, pull request and own issues are left out',
  );
});

test('a quiet repository gives no signals', async () => {
  const { reader: r } = reader(cleanRoutes());
  const signals = await r.read(target);
  assert.deepEqual(signals, {
    failingOnDefault: [],
    flaky: [],
    advisories: [],
    ownPulls: [],
    newIssues: [],
  });
});

test('scanning only reads: every request is a GET to this repository', async () => {
  const { reader: r, calls } = reader(busyRoutes());
  await r.read(target);
  assert.ok(calls.length > 8);
  for (const call of calls) {
    assert.equal(call.method, 'GET');
    assert.ok(call.url.startsWith(`${REPO_URL}/`), call.url);
  }
});

test('dependabot alerts that are off or hidden are none, any other failure fails the whole read', async () => {
  for (const status of [403, 404]) {
    const { reader: r } = reader({ ...busyRoutes(), '/dependabot/alerts': { status } });
    assert.deepEqual((await r.read(target)).advisories, []);
  }
  for (const path of ['/actions/runs', '/pulls', '/pulls/12', '/issues']) {
    const { reader: r } = reader({ ...busyRoutes(), [path]: { status: 502 } });
    await assert.rejects(r.read(target), SignalReadError, path);
  }
  const { reader: missing } = reader({ ...busyRoutes(), '/actions/runs': { status: 404 } });
  await assert.rejects(
    missing.read(target),
    SignalReadError,
    'a missing repository is not a quiet one',
  );
});

test('without a token, or for something that is not a repository, nothing is requested', async () => {
  const none = reader(busyRoutes(), null);
  await assert.rejects(none.reader.read(target), /MAKA_GITHUB_TOKEN/);
  const blank = reader(busyRoutes(), '  ');
  await assert.rejects(blank.reader.read(target), /MAKA_GITHUB_TOKEN/);
  const bad = reader(busyRoutes());
  await assert.rejects(
    bad.reader.read({ ...target, repo: 'acme/widgets/../../admin' }),
    /Not a repository/,
  );
  await assert.rejects(bad.reader.read({ ...target, repo: 'acme' }), /Not a repository/);
  assert.deepEqual(
    [none.calls, blank.calls, bad.calls].map((c) => c.length),
    [0, 0, 0],
  );
});

test('a reply that is not the shape asked for fails the read instead of being guessed at', async () => {
  const { reader: r } = reader({
    ...busyRoutes(),
    '/actions/runs': { workflow_runs: [{ id: 'one' }] },
  });
  await assert.rejects(r.read(target));
});
