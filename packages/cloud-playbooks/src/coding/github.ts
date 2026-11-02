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

export interface UpdateInput {
  /** A change made on top of the pull request's head: its `baseSha` must be that head. */
  changeSet: ChangeSet;
  /** The branch of the open pull request, e.g. `maka/<taskId>`. */
  branch: string;
  /** The commit message. */
  title: string;
}

/** A pull request a fix was pushed onto, and the commit its branch now points at. */
export interface UpdatedPullRequest extends PublishedPullRequest {
  headSha: string;
}

/** Turns a verified change set into a pull request. Must be idempotent per branch. */
export interface PullRequestPublisher {
  /** Why publishing cannot start now (no or wrong token), or undefined. */
  precheck(): string | undefined;
  publish(input: PublishInput, signal?: AbortSignal): Promise<PublishedPullRequest>;
  /**
   * Pushes a verified fix onto the branch of an open pull request, as one commit on top of its
   * head. Refuses when the head is no longer the commit the fix was made on. Idempotent: a retry
   * after the push finds the same commit and returns it.
   */
  update?(input: UpdateInput, signal?: AbortSignal): Promise<UpdatedPullRequest>;
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
    const { repo, baseSha } = input.changeSet;
    const newTree = await writeTree(api, input.changeSet);

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

  async update(input: UpdateInput, signal?: AbortSignal): Promise<UpdatedPullRequest> {
    const token = this.readToken();
    const problem = githubTokenProblem(token);
    if (problem) throw new Error(problem);
    const api = new Api(this.baseUrl, token as string, this.fetchImpl, signal);
    const { repo, baseSha } = input.changeSet;
    const owner = repo.split('/')[0] as string;
    const found = await api.get<{ html_url: string; number: number; state: string }[]>(
      `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${input.branch}`)}`,
    );
    const pr = found[0];
    if (!pr || pr.state !== 'open') {
      throw new Error(`no open pull request for ${input.branch} in ${repo}; nothing was pushed`);
    }
    const refPath = `/repos/${repo}/git/ref/heads/${input.branch}`;
    const newTree = await writeTree(api, input.changeSet);
    const head = (await api.get<{ object: { sha: string } }>(refPath)).object.sha;
    const done = { url: pr.html_url, number: pr.number, branch: input.branch };
    if (head !== baseSha) {
      // A retry after the push: the head is the fix's own commit.
      const commit = await api.get<GitCommit>(`/repos/${repo}/git/commits/${head}`);
      if (
        commit.tree.sha === newTree.sha &&
        commit.parents.length === 1 &&
        commit.parents[0]?.sha === baseSha
      ) {
        return { ...done, headSha: head };
      }
      throw new Error(
        `branch ${input.branch} moved since the fix was made (now ${head.slice(0, 12)}); nothing was pushed`,
      );
    }
    const commit = await api.post<GitCommit>(`/repos/${repo}/git/commits`, {
      message: input.title,
      tree: newTree.sha,
      parents: [baseSha],
    });
    // Not forced: GitHub refuses the move when the branch is no longer at `baseSha`.
    await api.patch(`/repos/${repo}/git/refs/heads/${input.branch}`, {
      sha: commit.sha,
      force: false,
    });
    return { ...done, headSha: commit.sha };
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

/** Where a pull request stands on GitHub. */
export interface PullRequestStatus {
  state: 'open' | 'closed' | 'merged';
  headSha: string;
}

/**
 * The checks of one commit, folded into one state. `failed`: a check failed or timed out, and
 * none is still running. `needs_approval`: a check waits for a person on GitHub. `none`: no check
 * reported (yet).
 */
export type ChecksState = 'pending' | 'passed' | 'failed' | 'needs_approval' | 'none';

export interface FailingCheck {
  /** The check run's id, which is the job id for a GitHub Actions check. */
  id: number;
  /** Written by the repository's workflow: shown only quoted. */
  name: string;
}

export interface ChecksResult {
  state: ChecksState;
  failing: FailingCheck[];
}

/** Reads what a pull request's CI says, with the host's GitHub token. */
export interface PullRequestChecks {
  precheck(): string | undefined;
  pullRequest(repo: string, number: number, signal?: AbortSignal): Promise<PullRequestStatus>;
  checks(repo: string, sha: string, signal?: AbortSignal): Promise<ChecksResult>;
  /** The end of a failing check's log, unscrubbed; undefined when it cannot be read. */
  log(
    repo: string,
    check: FailingCheck,
    maxChars: number,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
}

const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set([
  'failure',
  'timed_out',
  'startup_failure',
]);

/** Folds check runs (or workflow runs) into one state. */
export function foldChecks(
  runs: ReadonlyArray<{ id: number; name: string; status: string; conclusion: string | null }>,
): ChecksResult {
  if (runs.length === 0) return { state: 'none', failing: [] };
  const failing = runs
    .filter((run) => run.status === 'completed' && FAILED_CONCLUSIONS.has(run.conclusion ?? ''))
    .map((run) => ({ id: run.id, name: run.name }));
  if (runs.some((run) => run.status === 'completed' && run.conclusion === 'action_required')) {
    return { state: 'needs_approval', failing };
  }
  if (runs.some((run) => run.status !== 'completed')) return { state: 'pending', failing };
  return { state: failing.length > 0 ? 'failed' : 'passed', failing };
}

/**
 * The GitHub reader of the PR follow-up. Check runs need the token's "Checks: read"; a
 * fine-grained token GitHub refuses them to (403) falls back to the workflow runs of the commit,
 * which need "Actions: read" (as do the job logs). Only GitHub Actions jobs have a log to read.
 */
export class GitHubChecks implements PullRequestChecks {
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

  private api(signal: AbortSignal | undefined): Api {
    const token = this.readToken();
    const problem = githubTokenProblem(token);
    if (problem) throw new Error(problem);
    return new Api(this.baseUrl, token as string, this.fetchImpl, signal);
  }

  async pullRequest(
    repo: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<PullRequestStatus> {
    const pr = await this.api(signal).get<{
      state: string;
      merged?: boolean;
      merged_at?: string | null;
      head: { sha: string };
    }>(`/repos/${repo}/pulls/${number}`);
    const merged = pr.merged === true || (pr.merged_at ?? null) !== null;
    return {
      state: merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed',
      headSha: pr.head.sha,
    };
  }

  async checks(repo: string, sha: string, signal?: AbortSignal): Promise<ChecksResult> {
    const api = this.api(signal);
    try {
      const found = await api.get<{
        check_runs: { id: number; name: string; status: string; conclusion: string | null }[];
      }>(`/repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100`);
      return foldChecks(found.check_runs);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 403) throw error;
    }
    const runs = await api.get<{
      workflow_runs: {
        id: number;
        name: string | null;
        status: string;
        conclusion: string | null;
      }[];
    }>(`/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`);
    const folded = foldChecks(
      runs.workflow_runs.map((run) => ({ ...run, name: run.name ?? 'workflow' })),
    );
    // A workflow run is not a job: name its failing jobs, whose ids have the logs.
    const failing: FailingCheck[] = [];
    for (const run of folded.failing) {
      const jobs = await api.get<{
        jobs: { id: number; name: string; status: string; conclusion: string | null }[];
      }>(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
      failing.push(...foldChecks(jobs.jobs).failing);
    }
    return { state: folded.state, failing };
  }

  async log(
    repo: string,
    check: FailingCheck,
    maxChars: number,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      return await this.api(signal).text(`/repos/${repo}/actions/jobs/${check.id}/logs`, maxChars);
    } catch (error) {
      if (error instanceof GitHubApiError) return undefined;
      throw error;
    }
  }
}

/** Writes the change's blobs and a tree on the base commit's tree; checks every blob hash. */
async function writeTree(api: Api, changeSet: ChangeSet): Promise<{ sha: string }> {
  const { repo, baseSha, files } = changeSet;
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
  return api.post<{ sha: string }>(`/repos/${repo}/git/trees`, {
    base_tree: base.tree.sha,
    tree,
  });
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

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.call<T>('PATCH', path, body);
  }

  /** A text body (a job's log), following GitHub's redirect to its storage; at most the last `maxChars`. */
  async text(path: string, maxChars: number): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'x-github-api-version': '2022-11-28',
      },
      redirect: 'follow',
      ...(this.signal ? { signal: this.signal } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new GitHubApiError(
        response.status,
        `GitHub GET ${path} failed with ${response.status}`,
      );
    }
    const text = await response.text();
    return text.length <= maxChars ? text : text.slice(text.length - maxChars);
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
