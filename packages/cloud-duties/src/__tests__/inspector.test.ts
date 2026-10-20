import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubInspector } from '../inspector.js';
import { T0 } from './harness.js';

function fakeFetch(
  routes: Record<string, unknown>,
  seen: Array<{ url: string; method: string; auth: string }> = [],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({
      url,
      method: init?.method ?? 'GET',
      auth: String((init?.headers as Record<string, string>)?.authorization),
    });
    const key = Object.keys(routes).find((route) => url.includes(route));
    if (!key) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
}

test('the inspector reads the facts a proposal needs with read-only requests', async () => {
  const seen: Array<{ url: string; method: string; auth: string }> = [];
  const inspector = new GitHubInspector({
    token: () => 'github_pat_x',
    now: () => T0,
    fetch: fakeFetch(
      {
        '/actions/workflows': {
          workflows: [
            { name: 'CI', state: 'active' },
            { name: 'Old', state: 'disabled_manually' },
          ],
        },
        '/actions/runs': { total_count: 4 },
        '/search/issues': { total_count: 9 },
        '/repos/acme/widgets': { default_branch: 'trunk' },
      },
      seen,
    ),
  });
  assert.deepEqual(await inspector.inspect('acme/widgets'), {
    defaultBranch: 'trunk',
    workflows: ['CI'],
    openIssues: 9,
    failedRunsLast30Days: 4,
  });
  assert.ok(seen.every((call) => call.method === 'GET' && call.auth === 'Bearer github_pat_x'));
  assert.ok(
    seen.some(
      (call) => call.url.includes('branch=trunk') && call.url.includes('created=%3E%3D2026-09-20'),
    ),
  );
});

test('without a token, or on an error from GitHub, the inspector fails instead of guessing', async () => {
  await assert.rejects(
    new GitHubInspector({ token: () => undefined, fetch: fakeFetch({}) }).inspect('acme/widgets'),
    /MAKA_GITHUB_TOKEN/,
  );
  await assert.rejects(
    new GitHubInspector({ token: () => 'github_pat_x', fetch: fakeFetch({}) }).inspect(
      'acme/widgets',
    ),
    /404/,
  );
  await assert.rejects(
    new GitHubInspector({
      token: () => 'github_pat_x',
      fetch: fakeFetch({ '/repos/acme/widgets': { nope: true } }),
    }).inspect('acme/widgets'),
  );
});
