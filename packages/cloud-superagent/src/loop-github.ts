import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { GitHostPort, PullRequestResult, PushResult } from './loop.js';
import { FakeGitHost } from './loop.js';
import { redactSecret } from './sandbox.js';

const run = promisify(execFile);

export const GITHUB_TOKEN_ENV = 'MAKA_GITHUB_TOKEN';
export const LOOP_REPO_ENV = 'MAKA_CLOUD_LOOP_REPO';
export const LOOP_SEED_ENV = 'MAKA_CLOUD_LOOP_SEED';

export type CiVerdict = 'no-checks' | 'pending' | 'success' | 'failure' | 'skipped';

export interface CiStatus {
  verdict: CiVerdict;
  detail: string;
}

export interface RepoInspect {
  defaultBranch: string;
  empty: boolean;
  headSha?: string;
}

export function githubTokenProblem(token: string | undefined): string | undefined {
  if (token === undefined || token.trim() === '') {
    return `${GITHUB_TOKEN_ENV} is not set, so no GitHub pull request can be opened. Set it to a fine-grained token scoped to the scratch repo with Contents and Pull requests read/write.`;
  }
  if (!token.startsWith('github_pat_')) {
    return `${GITHUB_TOKEN_ENV} is not a fine-grained token (it must start with github_pat_). Classic, OAuth and app tokens are refused.`;
  }
  return undefined;
}

export interface HttpGitHostOptions {
  token: string;
  repo?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Host-side GitHub REST publisher. Token never goes on argv or into the box.
 * Local commit stays in the WorkspaceStore clone; GitHub gets blobs / a tree /
 * a commit / a worker-branch ref (same split as cloud-playbooks GitHubPublisher).
 */
export class HttpGitHost implements GitHostPort {
  readonly pulls: PullRequestResult[] = [];
  readonly merged: number[] = [];
  private readonly token: string;
  private readonly defaultRepo: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpGitHostOptions) {
    const problem = githubTokenProblem(options.token);
    if (problem) throw new Error(problem);
    this.token = options.token;
    this.defaultRepo = options.repo;
    this.baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
  }

  async commitAndPush(input: {
    dir: string;
    branch: string;
    message: string;
    repo: string;
  }): Promise<PushResult> {
    const local = await commitLocal(input.dir, input.branch, input.message);
    const repo = this.defaultRepo ?? input.repo;
    try {
      const sha = await this.publish(repo, input.branch, input.message, input.dir);
      return { sha, branch: input.branch };
    } catch (error) {
      throw wrap(error, this.token, `local=${local}`);
    }
  }

  async openOrUpdatePullRequest(input: {
    repo: string;
    branch: string;
    base: string;
    title: string;
    body: string;
    number?: number;
  }): Promise<PullRequestResult> {
    const repo = this.defaultRepo ?? input.repo;
    const owner = repo.split('/')[0] ?? '';
    const head = `${owner}:${input.branch}`;
    try {
      const found = await this.api<{ html_url: string; number: number }[]>(
        'GET',
        `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(head)}`,
      );
      const existing = input.number ? found.find((row) => row.number === input.number) : found[0];
      if (existing) {
        await this.api('PATCH', `/repos/${repo}/pulls/${existing.number}`, {
          title: input.title,
          body: input.body,
        });
        const row = { number: existing.number, url: existing.html_url };
        this.pulls.push(row);
        return row;
      }
      const created = await this.api<{ html_url: string; number: number }>(
        'POST',
        `/repos/${repo}/pulls`,
        {
          title: input.title,
          head: input.branch,
          base: input.base,
          body: input.body,
        },
      );
      const row = { number: created.number, url: created.html_url };
      this.pulls.push(row);
      return row;
    } catch (error) {
      throw wrap(error, this.token);
    }
  }

  ciLink(repo: string, sha: string): string {
    return `https://github.com/${this.defaultRepo ?? repo}/commit/${sha}/checks`;
  }

  async inspectRepo(repo?: string): Promise<RepoInspect> {
    const name = this.defaultRepo ?? repo ?? '';
    const info = await this.api<{ default_branch: string }>('GET', `/repos/${name}`);
    const branch = info.default_branch || 'main';
    const ref = await this.raw('GET', `/repos/${name}/git/ref/heads/${encodeURIComponent(branch)}`);
    if (ref.status === 404 || ref.status === 409) {
      return { defaultBranch: branch, empty: true };
    }
    if (!ref.ok) {
      throw new Error(
        redactSecret(
          `GitHub GET default branch HTTP ${ref.status}: ${ref.text.slice(0, 200)}`,
          this.token,
        ),
      );
    }
    const body = JSON.parse(ref.text) as { object?: { sha?: string } };
    return { defaultBranch: branch, empty: false, headSha: body.object?.sha };
  }

  /**
   * Creates the default branch on an empty repo with the scratch fixture.
   * Only called when `MAKA_CLOUD_LOOP_SEED=1`. Token stays on the host.
   */
  async seedScratch(
    files: Record<string, string>,
    repo?: string,
  ): Promise<{ sha: string; branch: string }> {
    const name = this.defaultRepo ?? repo ?? '';
    const info = await this.inspectRepo(name);
    if (!info.empty) return { sha: info.headSha ?? '', branch: info.defaultBranch };
    const branch = info.defaultBranch;
    const tree: Array<{ path: string; mode: string; type: 'blob'; sha: string }> = [];
    for (const [path, content] of Object.entries(files)) {
      const blob = await this.api<{ sha: string }>('POST', `/repos/${name}/git/blobs`, {
        content: Buffer.from(content).toString('base64'),
        encoding: 'base64',
      });
      tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const newTree = await this.api<{ sha: string }>('POST', `/repos/${name}/git/trees`, { tree });
    const commit = await this.api<{ sha: string }>('POST', `/repos/${name}/git/commits`, {
      message: 'seed: broken add() scratch',
      tree: newTree.sha,
    });
    await this.api('POST', `/repos/${name}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    });
    return { sha: commit.sha, branch };
  }

  /**
   * Combined Statuses + Checks. An empty list is `no-checks`, not failure.
   * GitHub reports `state: pending` with `total_count: 0` on a bare commit.
   */
  async readCi(sha: string, repo?: string): Promise<CiStatus> {
    const name = this.defaultRepo ?? repo ?? '';
    const status = await this.api<{
      state?: string;
      total_count?: number;
      statuses?: Array<{ state?: string; context?: string }>;
    }>('GET', `/repos/${name}/commits/${encodeURIComponent(sha)}/status`);
    const checks = await this.api<{
      total_count?: number;
      check_runs?: Array<{ status?: string; conclusion?: string | null; name?: string }>;
    }>('GET', `/repos/${name}/commits/${encodeURIComponent(sha)}/check-runs`);
    return summarizeCi(status, checks);
  }

  async merge(input: {
    repo: string;
    number: number;
    sha: string;
    allowNoCi?: boolean;
  }): Promise<void> {
    const repo = this.defaultRepo ?? input.repo;
    const ci = await this.readCi(input.sha, repo);
    const gate = evaluateMergeGate(ci, { allowNoCi: input.allowNoCi === true });
    if (!gate.ok) throw new Error(`MERGE_REFUSED ${gate.reason}`);
    await this.api('PUT', `/repos/${repo}/pulls/${input.number}/merge`, {
      merge_method: 'merge',
      sha: input.sha,
    });
    this.merged.push(input.number);
  }

  private async publish(
    repo: string,
    branch: string,
    message: string,
    dir: string,
  ): Promise<string> {
    const inspected = await this.inspectRepo(repo);
    if (inspected.empty) {
      throw new Error(
        `${repo} has no commits. Set ${LOOP_SEED_ENV}=1 to create the default branch with the scratch fixture via the GitHub API.`,
      );
    }
    const baseRef = { object: { sha: inspected.headSha ?? '' } };
    const base = await this.api<{ tree: { sha: string } }>(
      'GET',
      `/repos/${repo}/git/commits/${baseRef.object.sha}`,
    );
    const files = await listFiles(dir);
    const tree: Array<{ path: string; mode: string; type: 'blob'; sha: string }> = [];
    for (const file of files) {
      const blob = await this.api<{ sha: string }>('POST', `/repos/${repo}/git/blobs`, {
        content: Buffer.from(file.content).toString('base64'),
        encoding: 'base64',
      });
      tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const newTree = await this.api<{ sha: string }>('POST', `/repos/${repo}/git/trees`, {
      base_tree: base.tree.sha,
      tree,
    });
    const commit = await this.api<{ sha: string }>('POST', `/repos/${repo}/git/commits`, {
      message,
      tree: newTree.sha,
      parents: [baseRef.object.sha],
    });
    const refPath = `/repos/${repo}/git/refs/heads/${branch}`;
    const existing = await this.apiOrNull<{ object: { sha: string } }>(
      'GET',
      `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    if (existing) {
      const force = branch.startsWith('maka/sa-');
      await this.api('PATCH', refPath, { sha: commit.sha, force });
    } else {
      await this.api('POST', `/repos/${repo}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha: commit.sha,
      });
    }
    return commit.sha;
  }

  private async raw(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; text: string }> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.raw(method, path, body);
    if (!response.ok) {
      throw new Error(
        redactSecret(
          `GitHub ${method} ${path.split('?')[0]} HTTP ${response.status}: ${response.text.slice(0, 200)}`,
          this.token,
        ),
      );
    }
    return (response.text ? JSON.parse(response.text) : undefined) as T;
  }

  private async apiOrNull<T>(method: string, path: string): Promise<T | undefined> {
    try {
      return await this.api<T>(method, path);
    } catch (error) {
      if (error instanceof Error && /HTTP 404/.test(error.message)) return undefined;
      throw error;
    }
  }
}

export function createGitHostFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): { git: GitHostPort; kind: 'fake' | 'github'; repo?: string } {
  const live = env.MAKA_CLOUD_LOOP_LIVE === '1';
  const token = env[GITHUB_TOKEN_ENV]?.trim() ?? '';
  if (!live || !token) return { git: new FakeGitHost(), kind: 'fake' };
  const problem = githubTokenProblem(token);
  if (problem) throw new Error(problem);
  const repo = env[LOOP_REPO_ENV]?.trim() ?? '';
  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    throw new Error(`${LOOP_REPO_ENV} must be owner/name when ${GITHUB_TOKEN_ENV} is set.`);
  }
  return {
    git: new HttpGitHost({ token, repo, fetch: fetchImpl }),
    kind: 'github',
    repo,
  };
}

export async function commitLocal(dir: string, branch: string, message: string): Promise<string> {
  await run('git', ['-C', dir, 'checkout', '-B', branch]);
  await run('git', ['-C', dir, 'add', '-A']);
  await run('git', [
    '-C',
    dir,
    '-c',
    'user.email=superagent@test',
    '-c',
    'user.name=Superagent Loop',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-m',
    message,
    '--allow-empty',
  ]);
  const { stdout } = await run('git', ['-C', dir, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

async function listFiles(dir: string): Promise<Array<{ path: string; content: string }>> {
  const { stdout } = await run('git', ['-C', dir, 'ls-files']);
  const paths = stdout.trim().split('\n').filter(Boolean);
  const files: Array<{ path: string; content: string }> = [];
  for (const path of paths) {
    files.push({ path, content: await readFile(join(dir, path), 'utf8') });
  }
  return files;
}

export function summarizeCi(
  status: {
    state?: string;
    total_count?: number;
    statuses?: Array<{ state?: string }>;
  },
  checks: {
    total_count?: number;
    check_runs?: Array<{ status?: string; conclusion?: string | null }>;
  },
): CiStatus {
  const statuses = status.statuses ?? [];
  const runs = checks.check_runs ?? [];
  const hasStatus = (status.total_count ?? statuses.length) > 0 && statuses.length > 0;
  const hasChecks = (checks.total_count ?? runs.length) > 0 && runs.length > 0;
  if (!hasStatus && !hasChecks) {
    return { verdict: 'no-checks', detail: 'no Checks or Statuses on this SHA' };
  }
  const failedStatus = statuses.some((row) => row.state === 'failure' || row.state === 'error');
  const failedCheck = runs.some(
    (row) =>
      row.conclusion === 'failure' ||
      row.conclusion === 'timed_out' ||
      row.conclusion === 'cancelled' ||
      row.conclusion === 'stale',
  );
  if (failedStatus || failedCheck) {
    return { verdict: 'failure', detail: 'a check or status failed' };
  }
  const pendingStatus = statuses.some((row) => row.state === 'pending');
  const pendingCheck = runs.some(
    (row) =>
      row.status === 'queued' ||
      row.status === 'in_progress' ||
      row.status === 'pending' ||
      row.conclusion === 'action_required',
  );
  if (pendingStatus || pendingCheck) {
    return { verdict: 'pending', detail: 'checks still running' };
  }
  const passed =
    statuses.some((row) => row.state === 'success') ||
    runs.some((row) => row.conclusion === 'success');
  if (passed) {
    return { verdict: 'success', detail: 'checks passed' };
  }
  const skippedOnly =
    runs.length > 0 &&
    runs.every((row) => row.conclusion === 'skipped' || row.conclusion === 'neutral');
  if (skippedOnly) {
    return { verdict: 'skipped', detail: 'every check was skipped' };
  }
  return { verdict: 'success', detail: 'checks passed' };
}

export type MergeGateResult =
  | { ok: true; verdict: CiVerdict }
  | { ok: false; reason: string; verdict: CiVerdict };

/**
 * Merge only when this exact SHA is green. An empty check list is never
 * green unless the mandate sets `allowNoCi` (scratch / no-CI repos).
 */
export function evaluateMergeGate(
  ci: CiStatus,
  options: { allowNoCi?: boolean } = {},
): MergeGateResult {
  if (ci.verdict === 'success') return { ok: true, verdict: ci.verdict };
  if (ci.verdict === 'no-checks' && options.allowNoCi) {
    return { ok: true, verdict: ci.verdict };
  }
  if (ci.verdict === 'no-checks') {
    return {
      ok: false,
      reason: 'no checks reported: an empty check list is never green',
      verdict: ci.verdict,
    };
  }
  if (ci.verdict === 'skipped') {
    return { ok: false, reason: 'every check was skipped', verdict: ci.verdict };
  }
  if (ci.verdict === 'pending') {
    return { ok: false, reason: 'checks still running', verdict: ci.verdict };
  }
  return { ok: false, reason: 'a check or status failed', verdict: ci.verdict };
}

function wrap(error: unknown, token: string, extra = ''): Error {
  const message = error instanceof Error ? error.message : 'github failed';
  return new Error(redactSecret(extra ? `${message} (${extra})` : message, token));
}
