import type { ChangeSet, PublishedPullRequest } from './deliveries.js';

export const GITHUB_TOKEN_ENV = 'MAKA_GITHUB_TOKEN';

export interface PublishInput {
  changeSet: ChangeSet;
  /** Branch to create, e.g. `maka/<taskId>`. */
  branch: string;
  /** The branch or commit the task started from; the pull request targets it when it is a branch. */
  baseRef: string;
  title: string;
  body: string;
  /** Open the pull request as a draft: a change that is kept for the owner to look at. */
  draft?: boolean;
}

/** Turns a verified change set into a pull request. Must be idempotent per branch. */
export interface PullRequestPublisher {
  /** Why publishing cannot start now (no or wrong token), or undefined. */
  precheck(): string | undefined;
  publish(input: PublishInput, signal?: AbortSignal): Promise<PublishedPullRequest>;
}

/**
 * The token rule: fine-grained personal access tokens only (scoped to selected repositories,
 * Contents and Pull requests read/write), read from `MAKA_GITHUB_TOKEN` so a CI or shell
 * `GITHUB_TOKEN` is never picked up by accident. Returns the reason a token is refused.
 */
export function githubTokenProblem(token: string | undefined): string | undefined {
  if (token === undefined || token.trim() === '') {
    return `${GITHUB_TOKEN_ENV} is not set, so no pull request can be opened. Set it to a fine-grained GitHub token scoped to the repository with Contents and Pull requests read/write.`;
  }
  if (!token.startsWith('github_pat_')) {
    return `${GITHUB_TOKEN_ENV} is not a fine-grained token (it must start with github_pat_). Classic, OAuth and app tokens are refused because they cannot be limited to selected repositories and to Contents and Pull requests.`;
  }
  return undefined;
}

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GitHubPublisherOptions {
  /** Default: `MAKA_GITHUB_TOKEN` from `env`, read when a pull request is opened. */
  token?: () => string | undefined;
  env?: NodeJS.ProcessEnv;
  /** Default `https://api.github.com`. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface GitCommit {
  sha: string;
  tree: { sha: string };
  parents: { sha: string }[];
}

/**
 * Opens the pull request from the host with the GitHub REST API: blobs, a tree on the base
 * commit's tree, a commit whose only parent is the base commit, the branch, and the pull request.
 * Nothing is pushed from a sandbox and the token never leaves this process. A retry reuses a
 * branch that already holds the same tree and an open or closed pull request for that branch.
 */
export class GitHubPublisher implements PullRequestPublisher {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly readToken: () => string | undefined;

  constructor(options: GitHubPublisherOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/+$/u, '');
    this.fetchImpl = options.fetch ?? fetch;
    const env = options.env ?? process.env;
    this.readToken = options.token ?? (() => env[GITHUB_TOKEN_ENV]);
  }

  precheck(): string | undefined {
    return githubTokenProblem(this.readToken());
  }

  async publish(input: PublishInput, signal?: AbortSignal): Promise<PublishedPullRequest> {
    const token = this.readToken();
    const problem = githubTokenProblem(token);
    if (problem) throw new Error(problem);
    const api = new Api(this.baseUrl, token as string, this.fetchImpl, signal);
    const { repo, baseSha, files } = input.changeSet;

    const base = await api.get<GitCommit>(`/repos/${repo}/git/commits/${baseSha}`);
    const tree: { path: string; mode: string; type: 'blob'; sha: string | null }[] = [];
    for (const file of files) {
      if (file.status === 'deleted') {
        tree.push({ path: file.path, mode: '100644', type: 'blob', sha: null });
        continue;
      }
      const blob = await api.post<{ sha: string }>(`/repos/${repo}/git/blobs`, {
        content: file.contentBase64,
        encoding: 'base64',
      });
      if (blob.sha !== file.blobSha) {
        throw new Error(`GitHub stored ${file.path} as ${blob.sha}, expected ${file.blobSha}`);
      }
      tree.push({ path: file.path, mode: file.mode, type: 'blob', sha: blob.sha });
    }
    const newTree = await api.post<{ sha: string }>(`/repos/${repo}/git/trees`, {
      base_tree: base.tree.sha,
      tree,
    });

    const refPath = `/repos/${repo}/git/ref/heads/${input.branch}`;
    const sameChange = (commit: GitCommit): boolean =>
      commit.tree.sha === newTree.sha &&
      commit.parents.length === 1 &&
      commit.parents[0]?.sha === baseSha;
    const existing = await api.getOrNull<{ object: { sha: string } }>(refPath);
    if (existing) {
      const commit = await api.get<GitCommit>(`/repos/${repo}/git/commits/${existing.object.sha}`);
      if (!sameChange(commit)) {
        throw new Error(
          `branch ${input.branch} already exists in ${repo} with other content; it was not changed`,
        );
      }
    } else {
      const commit = await api.post<GitCommit>(`/repos/${repo}/git/commits`, {
        message: input.title,
        tree: newTree.sha,
        parents: [baseSha],
      });
      try {
        await api.post(`/repos/${repo}/git/refs`, {
          ref: `refs/heads/${input.branch}`,
          sha: commit.sha,
        });
      } catch (error) {
        // Created by a call that raced this one: fine if it holds the same change.
        if (!(error instanceof GitHubApiError) || error.status !== 422) throw error;
        const raced = await api.get<{ object: { sha: string } }>(refPath);
        const racedCommit = await api.get<GitCommit>(
          `/repos/${repo}/git/commits/${raced.object.sha}`,
        );
        if (!sameChange(racedCommit)) throw error;
      }
    }

    const owner = repo.split('/')[0] as string;
    const head = `${owner}:${input.branch}`;
    const found = await api.get<{ html_url: string; number: number }[]>(
      `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(head)}`,
    );
    if (found[0]) return { url: found[0].html_url, number: found[0].number, branch: input.branch };

    const target = await this.targetBranch(api, repo, input.baseRef);
    const pr = await api.post<{ html_url: string; number: number }>(`/repos/${repo}/pulls`, {
      title: input.title,
      head: input.branch,
      base: target,
      body: input.body,
      ...(input.draft ? { draft: true } : {}),
    });
    return { url: pr.html_url, number: pr.number, branch: input.branch };
  }

  /** The task's base ref when it names a branch, else the repository's default branch. */
  private async targetBranch(api: Api, repo: string, baseRef: string): Promise<string> {
    if (!/^[0-9a-f]{40}$/u.test(baseRef)) {
      const branch = await api.getOrNull(`/repos/${repo}/branches/${encodeURIComponent(baseRef)}`);
      if (branch) return baseRef;
    }
    return (await api.get<{ default_branch: string }>(`/repos/${repo}`)).default_branch;
  }
}

class Api {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch,
    private readonly signal: AbortSignal | undefined,
  ) {}

  get<T>(path: string): Promise<T> {
    return this.call<T>('GET', path);
  }

  async getOrNull<T>(path: string): Promise<T | undefined> {
    try {
      return await this.call<T>('GET', path);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.call<T>('POST', path, body);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(this.signal ? { signal: this.signal } : {}),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = '';
      try {
        message = String((JSON.parse(text) as { message?: unknown }).message ?? '');
      } catch {}
      throw new GitHubApiError(
        response.status,
        `GitHub ${method} ${path.split('?')[0]} failed with ${response.status}${message ? `: ${message.slice(0, 300)}` : ''}`,
      );
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
