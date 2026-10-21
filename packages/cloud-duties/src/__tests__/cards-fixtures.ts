/** A fake GitHub for the card scan: routes by path, and a record of every request made to it. */
export interface Recorded {
  method: string | undefined;
  url: string;
}

export type Routes = Record<string, unknown | { status: number }>;

export const REPO_URL = 'https://api.github.test/repos/acme/widgets';
export const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 24 * 3_600_000).toISOString();

export function fakeGitHub(routes: Routes): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method, url });
    const path = url.slice(REPO_URL.length);
    const pathname = path.split('?')[0];
    const route = Object.entries(routes).find(([key]) => key === pathname);
    if (!route) return new Response('{"message":"unmocked"}', { status: 500 });
    const body = route[1] as { status?: number };
    if (
      typeof body === 'object' &&
      body !== null &&
      !Array.isArray(body) &&
      Object.keys(body).length === 1 &&
      typeof body.status === 'number'
    ) {
      return new Response('{}', { status: body.status });
    }
    return new Response(JSON.stringify(route[1]), { status: 200 });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const run = (
  id: number,
  workflow: number,
  name: string,
  sha: string,
  conclusion: string,
  attempt = 1,
) => ({
  id,
  workflow_id: workflow,
  name,
  head_sha: sha,
  conclusion,
  run_attempt: attempt,
});

/** A repository with something wrong in every way a card knows. */
export function busyRoutes(): Routes {
  return {
    '/actions/runs': {
      workflow_runs: [
        run(900, 1, 'CI', 'c'.repeat(40), 'failure'),
        run(899, 1, 'CI', 'b'.repeat(40), 'success', 2),
        run(898, 1, 'CI', 'a'.repeat(40), 'success', 3),
        run(897, 2, 'Lint', 'a'.repeat(40), 'success'),
      ],
    },
    '/dependabot/alerts': [
      {
        state: 'open',
        dependency: { package: { name: 'lodash', ecosystem: 'npm' } },
        security_advisory: { ghsa_id: 'GHSA-aaaa-bbbb-cccc', severity: 'high' },
      },
      {
        state: 'open',
        dependency: { package: { name: 'minimist', ecosystem: 'npm' } },
        security_advisory: { ghsa_id: 'GHSA-dddd-eeee-ffff', severity: 'critical' },
      },
      {
        state: 'dismissed',
        dependency: { package: { name: 'left-pad', ecosystem: 'npm' } },
        security_advisory: { ghsa_id: 'GHSA-gggg-hhhh-iiii', severity: 'low' },
      },
    ],
    '/pulls': [
      {
        number: 12,
        title: 'Add retries to the uploader',
        head: { ref: 'maka/retries', sha: '1'.repeat(40), repo: { full_name: 'acme/widgets' } },
      },
      {
        number: 14,
        title: 'Fix the parser',
        head: { ref: 'maka/parser', sha: '2'.repeat(40), repo: { full_name: 'acme/widgets' } },
      },
      {
        number: 15,
        title: 'Tidy docs',
        head: { ref: 'maka/docs', sha: '3'.repeat(40), repo: { full_name: 'acme/widgets' } },
      },
      // Not ours: someone else's branch, and a fork that borrowed our prefix.
      {
        number: 20,
        title: 'Someone else',
        head: { ref: 'feature/x', sha: '4'.repeat(40), repo: { full_name: 'acme/widgets' } },
      },
      {
        number: 21,
        title: 'A fork',
        head: { ref: 'maka/fork', sha: '5'.repeat(40), repo: { full_name: 'mallory/widgets' } },
      },
    ],
    '/pulls/12': { mergeable_state: 'dirty', head: { sha: '1'.repeat(40) } },
    '/pulls/14': { mergeable_state: 'blocked', head: { sha: '2'.repeat(40) } },
    '/pulls/15': { mergeable_state: 'clean', head: { sha: '3'.repeat(40) } },
    [`/commits/${'1'.repeat(40)}/check-runs`]: { check_runs: [] },
    [`/commits/${'2'.repeat(40)}/check-runs`]: {
      check_runs: [
        { name: 'unit', conclusion: 'failure' },
        { name: 'lint', conclusion: 'success' },
      ],
    },
    [`/commits/${'3'.repeat(40)}/check-runs`]: {
      check_runs: [{ name: 'unit', conclusion: 'success' }],
    },
    '/pulls/12/comments': [],
    '/pulls/14/comments': [],
    '/pulls/15/comments': [
      { id: 1, in_reply_to_id: null, user: { login: 'reviewer' } },
      { id: 2, in_reply_to_id: null, user: { login: 'reviewer' } },
      { id: 3, in_reply_to_id: 2, user: { login: 'maka-bot' } },
      { id: 4, in_reply_to_id: 1, user: { login: 'reviewer' } },
    ],
    '/issues': [
      { number: 31, title: 'Crash on empty input', created_at: iso(1), user: { login: 'alice' } },
      { number: 30, title: 'Old report', created_at: iso(40), user: { login: 'bob' } },
      {
        number: 29,
        title: 'A pull request is not an issue',
        created_at: iso(1),
        user: { login: 'carol' },
        pull_request: {},
      },
      {
        number: 28,
        title: 'Opened by the employee',
        created_at: iso(1),
        user: { login: 'maka-bot' },
      },
    ],
  };
}

/** A repository with nothing to do. */
export function cleanRoutes(): Routes {
  return {
    '/actions/runs': { workflow_runs: [run(1, 1, 'CI', 'a'.repeat(40), 'success')] },
    '/dependabot/alerts': [],
    '/pulls': [],
    '/issues': [],
  };
}
