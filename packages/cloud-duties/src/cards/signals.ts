import { z } from 'zod';
import { INSPECTOR_TOKEN_ENV } from '../inspector.js';
import { OWN_BRANCH_PREFIX } from '../types.js';

/** What the scan needs to know about a project to read it. */
export interface ScanTarget {
  repo: string;
  defaultBranch: string;
  /** The accounts that are the employee. */
  selfLogins: readonly string[];
}

export interface FailingWorkflow {
  name: string;
  runId: number;
  headSha: string;
}

export interface OwnPull {
  number: number;
  /** Written by someone else: shown quoted and cut, never obeyed. */
  title: string;
  headSha: string;
  /** The pull request cannot be merged into the default branch as it is. */
  conflicts: boolean;
  /** Names of the checks that failed on its head. */
  failingChecks: string[];
  /** Review comments by others that start a thread nobody on our side answered. */
  unansweredComments: number;
  /** The ids of those comments, so the state they make is told apart from a later one. */
  commentIds: number[];
}

export interface IssueSignal {
  number: number;
  title: string;
}

export interface FlakyWorkflow {
  name: string;
  /** Commits on which it failed and then passed when run again. */
  shas: string[];
}

export interface Advisory {
  id: string;
  packageName: string;
  ecosystem: string;
  severity: string;
}

/** What one read of a project found. It holds no instruction: text in it was written by others. */
export interface RepoSignals {
  failingOnDefault: FailingWorkflow[];
  flaky: FlakyWorkflow[];
  advisories: Advisory[];
  /** Pull requests the employee opened. Someone else's are not listed: it never pushes to them. */
  ownPulls: OwnPull[];
  /** Open issues from the last two weeks, opened by someone else. */
  newIssues: IssueSignal[];
}

export interface SignalReader {
  read(target: ScanTarget, signal?: AbortSignal): Promise<RepoSignals>;
}

/** Pull requests looked at in detail, and issues listed: a scan makes a bounded number of requests. */
export const MAX_PULLS_READ = 10;
export const MAX_ISSUES_READ = 20;
export const ISSUE_WINDOW_MS = 14 * 24 * 3_600_000;

const Runs = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.number().int(),
      workflow_id: z.number().int(),
      name: z.string().nullable().optional(),
      head_sha: z.string(),
      conclusion: z.string().nullable(),
      run_attempt: z.number().int().optional(),
    }),
  ),
});
const Alerts = z.array(
  z.object({
    state: z.string(),
    dependency: z.object({
      package: z.object({ name: z.string(), ecosystem: z.string() }),
    }),
    security_advisory: z.object({ ghsa_id: z.string(), severity: z.string() }),
  }),
);
const Pulls = z.array(
  z.object({
    number: z.number().int(),
    title: z.string(),
    draft: z.boolean().optional(),
    head: z.object({
      ref: z.string(),
      sha: z.string(),
      repo: z.object({ full_name: z.string() }).nullable(),
    }),
  }),
);
const PullOne = z.object({
  mergeable_state: z.string().nullable().optional(),
  head: z.object({ sha: z.string() }),
});
const CheckRuns = z.object({
  check_runs: z.array(z.object({ name: z.string(), conclusion: z.string().nullable() })),
});
const ReviewComments = z.array(
  z.object({
    id: z.number().int(),
    in_reply_to_id: z.number().int().nullable().optional(),
    user: z.object({ login: z.string() }).nullable(),
  }),
);
const Issues = z.array(
  z.object({
    number: z.number().int(),
    title: z.string(),
    created_at: z.string(),
    user: z.object({ login: z.string() }).nullable(),
    pull_request: z.unknown().optional(),
  }),
);

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

export interface GitHubSignalReaderOptions {
  /** The token to read with; read when a project is scanned. Default: `MAKA_GITHUB_TOKEN`. */
  token?: () => string | undefined;
  env?: NodeJS.ProcessEnv;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** A request GitHub answered with a status that is not an answer to the question. */
export class SignalReadError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`GitHub answered ${status} for ${path}`);
    this.name = 'SignalReadError';
  }
}

/**
 * Reads the signals of a project with GET requests only: scanning never writes anything and never
 * runs code. The only function that calls the network sends `method: 'GET'` and a path under the
 * project's own repository, so a repository name that is not one is refused before any request.
 * What a feature the repository does not have (Dependabot alerts off) answers is "none", not an error;
 * any other failure fails the whole read, so a half-seen repository proposes nothing.
 */
export class GitHubSignalReader implements SignalReader {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly readToken: () => string | undefined;
  private readonly now: () => number;

  constructor(options: GitHubSignalReaderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/+$/u, '');
    this.fetchImpl = options.fetch ?? fetch;
    const env = options.env ?? process.env;
    this.readToken = options.token ?? (() => env[INSPECTOR_TOKEN_ENV]);
    this.now = options.now ?? Date.now;
  }

  async read(target: ScanTarget, signal?: AbortSignal): Promise<RepoSignals> {
    if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u.test(target.repo)) {
      throw new Error('Not a repository name.');
    }
    const token = this.readToken();
    if (token === undefined || token.trim() === '') {
      throw new Error(`${INSPECTOR_TOKEN_ENV} is not set, so the repository cannot be scanned.`);
    }
    const base = `/repos/${target.repo}`;
    const get = async <T>(path: string, schema: z.ZodType<T>, missing?: T): Promise<T> => {
      const response = await this.fetchImpl(`${this.baseUrl}${base}${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
        },
        ...(signal ? { signal } : {}),
      });
      if (missing !== undefined && (response.status === 403 || response.status === 404)) {
        return missing;
      }
      if (!response.ok) throw new SignalReadError(response.status, `${base}${path}`);
      return schema.parse(await response.json());
    };
    const self = new Set(target.selfLogins.map((login) => login.toLowerCase()));

    const runs = await get(
      `/actions/runs?branch=${encodeURIComponent(target.defaultBranch)}&status=completed&per_page=30`,
      Runs,
    );
    const newestByWorkflow = new Map<number, (typeof runs.workflow_runs)[number]>();
    for (const run of runs.workflow_runs) {
      if (!newestByWorkflow.has(run.workflow_id)) newestByWorkflow.set(run.workflow_id, run);
    }
    const failingOnDefault = [...newestByWorkflow.values()]
      .filter((run) => run.conclusion !== null && FAILED.has(run.conclusion))
      .map((run) => ({ name: run.name ?? 'CI', runId: run.id, headSha: run.head_sha }));

    // A run that passed only on a later attempt failed before on the same commit.
    const flaky = new Map<number, { name: string; shas: Set<string> }>();
    for (const run of runs.workflow_runs) {
      if (run.conclusion !== 'success' || (run.run_attempt ?? 1) < 2) continue;
      const entry = flaky.get(run.workflow_id) ?? { name: run.name ?? 'CI', shas: new Set() };
      entry.shas.add(run.head_sha);
      flaky.set(run.workflow_id, entry);
    }

    const alerts = await get('/dependabot/alerts?state=open&per_page=30', Alerts, []);
    const advisories = alerts
      .filter((alert) => alert.state === 'open')
      .map((alert) => ({
        id: alert.security_advisory.ghsa_id,
        packageName: alert.dependency.package.name,
        ecosystem: alert.dependency.package.ecosystem,
        severity: alert.security_advisory.severity,
      }));

    const pulls = await get('/pulls?state=open&per_page=30', Pulls);
    const own = pulls
      .filter(
        (pull) =>
          pull.head.ref.startsWith(OWN_BRANCH_PREFIX) &&
          pull.head.repo?.full_name.toLowerCase() === target.repo.toLowerCase(),
      )
      .slice(0, MAX_PULLS_READ);
    const ownPulls: OwnPull[] = [];
    for (const pull of own) {
      const detail = await get(`/pulls/${pull.number}`, PullOne);
      const sha = detail.head.sha;
      const checks = await get(`/commits/${sha}/check-runs?per_page=50`, CheckRuns);
      const comments = await get(`/pulls/${pull.number}/comments?per_page=100`, ReviewComments);
      const answered = new Set<number>();
      for (const comment of comments) {
        if (
          comment.in_reply_to_id != null &&
          comment.user !== null &&
          self.has(comment.user.login.toLowerCase())
        ) {
          answered.add(comment.in_reply_to_id);
        }
      }
      const open = comments.filter(
        (comment) =>
          comment.in_reply_to_id == null &&
          comment.user !== null &&
          !self.has(comment.user.login.toLowerCase()) &&
          !answered.has(comment.id),
      );
      ownPulls.push({
        number: pull.number,
        title: pull.title,
        headSha: sha,
        conflicts: detail.mergeable_state === 'dirty',
        failingChecks: checks.check_runs
          .filter((check) => check.conclusion !== null && FAILED.has(check.conclusion))
          .map((check) => check.name)
          .sort(),
        unansweredComments: open.length,
        commentIds: open.map((comment) => comment.id).sort((a, b) => a - b),
      });
    }

    const issues = await get(
      `/issues?state=open&sort=created&direction=desc&per_page=${MAX_ISSUES_READ}`,
      Issues,
    );
    const since = this.now() - ISSUE_WINDOW_MS;
    const newIssues = issues
      .filter(
        (issue) =>
          issue.pull_request === undefined &&
          Date.parse(issue.created_at) >= since &&
          !(issue.user !== null && self.has(issue.user.login.toLowerCase())),
      )
      .map((issue) => ({ number: issue.number, title: issue.title }));

    return {
      failingOnDefault,
      flaky: [...flaky.values()]
        .filter((entry) => entry.shas.size >= 2)
        .map((entry) => ({ name: entry.name, shas: [...entry.shas].sort() })),
      advisories,
      ownPulls,
      newIssues,
    };
  }
}
