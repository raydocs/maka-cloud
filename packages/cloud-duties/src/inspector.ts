import { z } from 'zod';
import type { RepoFacts, RepoInspector } from './propose.js';

export const INSPECTOR_TOKEN_ENV = 'MAKA_GITHUB_TOKEN';

export interface GitHubInspectorOptions {
  /** The token to read with; read when a repository is inspected. Default: `MAKA_GITHUB_TOKEN`. */
  token?: () => string | undefined;
  env?: NodeJS.ProcessEnv;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const Repo = z.object({ default_branch: z.string().min(1) });
const Workflows = z.object({
  workflows: z.array(z.object({ name: z.string(), state: z.string() })),
});
const Count = z.object({ total_count: z.number().int().nonnegative() });

/**
 * Reads what a duty proposal needs from GitHub, with read-only requests only: the default branch,
 * the enabled workflows, failed runs on the default branch in the last 30 days, and open issues.
 */
export class GitHubInspector implements RepoInspector {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly readToken: () => string | undefined;
  private readonly now: () => number;

  constructor(options: GitHubInspectorOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/+$/u, '');
    this.fetchImpl = options.fetch ?? fetch;
    const env = options.env ?? process.env;
    this.readToken = options.token ?? (() => env[INSPECTOR_TOKEN_ENV]);
    this.now = options.now ?? Date.now;
  }

  async inspect(repo: string, signal?: AbortSignal): Promise<RepoFacts> {
    const token = this.readToken();
    if (token === undefined || token.trim() === '') {
      throw new Error(`${INSPECTOR_TOKEN_ENV} is not set, so the repository cannot be inspected.`);
    }
    const get = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
        },
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}`);
      return schema.parse(await response.json());
    };
    const since = new Date(this.now() - 30 * 24 * 3_600_000).toISOString().slice(0, 10);
    const { default_branch: defaultBranch } = await get(`/repos/${repo}`, Repo);
    const workflows = await get(`/repos/${repo}/actions/workflows?per_page=100`, Workflows);
    const failed = await get(
      `/repos/${repo}/actions/runs?status=failure&branch=${encodeURIComponent(defaultBranch)}&created=%3E%3D${since}&per_page=1`,
      Count,
    );
    const issues = await get(
      `/search/issues?q=${encodeURIComponent(`repo:${repo} type:issue state:open`)}&per_page=1`,
      Count,
    );
    return {
      defaultBranch,
      workflows: workflows.workflows
        .filter((workflow) => workflow.state === 'active')
        .map((workflow) => workflow.name),
      openIssues: issues.total_count,
      failedRunsLast30Days: failed.total_count,
    };
  }
}
