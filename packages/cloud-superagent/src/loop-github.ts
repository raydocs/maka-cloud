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

  async merge(input: { repo: string; number: number }): Promise<void> {
    const repo = this.defaultRepo ?? input.repo;
    await this.api('PUT', `/repos/${repo}/pulls/${input.number}/merge`, {
      merge_method: 'merge',
    });
    this.merged.push(input.number);
  }

  private async publish(
    repo: string,
    branch: string,
    message: string,
    dir: string,
  ): Promise<string> {
    const repoInfo = await this.api<{ default_branch: string }>('GET', `/repos/${repo}`);
    const baseRef = await this.api<{ object: { sha: string } }>(
      'GET',
      `/repos/${repo}/git/ref/heads/${encodeURIComponent(repoInfo.default_branch)}`,
    );
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

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
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
    if (!response.ok) {
      throw new Error(
        redactSecret(
          `GitHub ${method} ${path.split('?')[0]} HTTP ${response.status}: ${text.slice(0, 200)}`,
          this.token,
        ),
      );
    }
    return (text ? JSON.parse(text) : undefined) as T;
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

function wrap(error: unknown, token: string, extra = ''): Error {
  const message = error instanceof Error ? error.message : 'github failed';
  return new Error(redactSecret(extra ? `${message} (${extra})` : message, token));
}
