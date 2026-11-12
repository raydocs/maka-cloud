import { z } from 'zod';
import { OWN_BRANCH_PREFIX, type TriggerKind } from './types.js';
import type { AcceptedEvent } from './webhook.js';

/**
 * What a webhook says, reduced to the few facts a duty needs. Everything here that other people
 * or tools wrote (titles, bodies, workflow names, commit messages) is carried as `fields` and
 * reaches the model only quoted and labelled as data, in a run that is marked external.
 */
export interface EventFacts {
  /** A line built by code from numbers and fixed words. */
  summary: string;
  url?: string;
  /** Text written by others, as label and value. Clipped and quoted when the brief is built. */
  fields: Array<[label: string, value: string]>;
}

export interface ProjectView {
  repo: string;
  installationId: number;
  defaultBranch: string;
  selfLogins: readonly string[];
}

export type Classified =
  | { kind: 'ping' }
  | { kind: 'ignored'; reason: string }
  /** A later success of a workflow on a branch: older failures of it are stale. */
  | { kind: 'ci_success'; scope: string; seq: number }
  | {
      kind: 'trigger';
      trigger: Exclude<TriggerKind, 'schedule'>;
      key: string;
      facts: EventFacts;
      supersede?: { scope: string; seq: number };
      /** CI failure only: ignored when a later success of the same scope is already recorded. */
      staleIf?: { scope: string; seq: number };
      /** CI failure of a branch of our own: part of a chain of runs that wake each other. */
      chain?: { key: string; seq: number };
    };

const Account = z.object({ login: z.string().min(1), type: z.string() });
const Repository = z.object({ full_name: z.string().min(1) });
const Installation = z.object({ id: z.number().int().positive() });

const WorkflowRun = z.object({
  action: z.string(),
  workflow_run: z.object({
    id: z.number().int(),
    run_attempt: z.number().int().optional(),
    run_number: z.number().int(),
    workflow_id: z.number().int(),
    name: z.string().nullable().optional(),
    head_branch: z.string().nullable(),
    head_sha: z.string(),
    conclusion: z.string().nullable(),
    event: z.string(),
    html_url: z.string().optional(),
    head_repository: Repository.nullable().optional(),
    head_commit: z.object({ message: z.string().nullable().optional() }).nullable().optional(),
  }),
  repository: Repository,
  installation: Installation,
  sender: Account,
});

const Issues = z.object({
  action: z.string(),
  issue: z.object({
    number: z.number().int(),
    title: z.string(),
    body: z.string().nullable().optional(),
    html_url: z.string().optional(),
    user: Account,
    pull_request: z.unknown().optional(),
  }),
  repository: Repository,
  installation: Installation,
  sender: Account,
});

const IssueComment = z.object({
  action: z.string(),
  issue: z.object({
    number: z.number().int(),
    title: z.string(),
    user: Account,
    pull_request: z.unknown().optional(),
  }),
  comment: z.object({
    id: z.number().int(),
    body: z.string().nullable().optional(),
    html_url: z.string().optional(),
  }),
  repository: Repository,
  installation: Installation,
  sender: Account,
});

const PullRequest = z.object({
  number: z.number().int(),
  title: z.string().optional(),
  user: Account,
});

const ReviewComment = z.object({
  action: z.string(),
  pull_request: PullRequest,
  comment: z.object({
    id: z.number().int(),
    body: z.string().nullable().optional(),
    path: z.string().optional(),
    html_url: z.string().optional(),
  }),
  repository: Repository,
  installation: Installation,
  sender: Account,
});

const Review = z.object({
  action: z.string(),
  pull_request: PullRequest,
  review: z.object({
    id: z.number().int(),
    body: z.string().nullable().optional(),
    state: z.string(),
    html_url: z.string().optional(),
  }),
  repository: Repository,
  installation: Installation,
  sender: Account,
});

export interface Parsed {
  repo: string;
  installationId: number;
  /** A completed CI run: the branch it ran on, for whatever follows that branch's checks. */
  ci?: { branch: string };
  /** Classifies the event for the project registered for `repo`. */
  classify(project: ProjectView): Classified;
}

const lower = (text: string) => text.toLowerCase();

const MAX_ATTEMPT = 999;

/**
 * Where a run attempt stands in its workflow's history: by run number, then by attempt. A re-run
 * keeps its run number, so the number alone cannot tell a failed first attempt from the passing
 * second one.
 */
export function runOrder(runNumber: number, attempt: number | undefined): number {
  const n = Math.min(Math.max(Math.trunc(attempt ?? 1), 1), MAX_ATTEMPT);
  return runNumber * (MAX_ATTEMPT + 1) + n;
}

/** Whether the sender is the employee itself or any bot: those never wake a duty (no loops). */
function isSelfOrBot(sender: z.infer<typeof Account>, project: ProjectView): boolean {
  return (
    sender.type.toLowerCase() === 'bot' ||
    project.selfLogins.some((login) => lower(login) === lower(sender.login))
  );
}

function isSelf(login: string, project: ProjectView): boolean {
  return project.selfLogins.some((self) => lower(self) === lower(login));
}

/**
 * Reads a payload of an accepted event. Undefined when it is not shaped as the event says
 * (including a missing installation): the delivery is rejected, never guessed at.
 */
export function parseEvent(event: AcceptedEvent, payload: unknown): Parsed | undefined {
  switch (event) {
    case 'ping':
      return { repo: '', installationId: 0, classify: () => ({ kind: 'ping' }) };
    case 'workflow_run': {
      const parsed = WorkflowRun.safeParse(payload);
      if (!parsed.success) return undefined;
      const run = parsed.data.workflow_run;
      return {
        ...base(parsed.data, (project) => classifyWorkflowRun(parsed.data, project)),
        ...(parsed.data.action === 'completed' && run.head_branch
          ? { ci: { branch: run.head_branch } }
          : {}),
      };
    }
    case 'issues': {
      const parsed = Issues.safeParse(payload);
      if (!parsed.success) return undefined;
      return base(parsed.data, (project) => classifyIssue(parsed.data, project));
    }
    case 'issue_comment': {
      const parsed = IssueComment.safeParse(payload);
      if (!parsed.success) return undefined;
      return base(parsed.data, (project) => classifyIssueComment(parsed.data, project));
    }
    case 'pull_request_review_comment': {
      const parsed = ReviewComment.safeParse(payload);
      if (!parsed.success) return undefined;
      return base(parsed.data, (project) => classifyReviewComment(parsed.data, project));
    }
    case 'pull_request_review': {
      const parsed = Review.safeParse(payload);
      if (!parsed.success) return undefined;
      return base(parsed.data, (project) => classifyReview(parsed.data, project));
    }
  }
}

function base(
  data: { repository: { full_name: string }; installation: { id: number } },
  classify: (project: ProjectView) => Classified,
): Parsed {
  return { repo: lower(data.repository.full_name), installationId: data.installation.id, classify };
}

function classifyWorkflowRun(data: z.infer<typeof WorkflowRun>, project: ProjectView): Classified {
  const run = data.workflow_run;
  if (data.action !== 'completed') return { kind: 'ignored', reason: 'action' };
  const branch = run.head_branch ?? '';
  const scope = `${project.repo}:${run.workflow_id}:${branch}`;
  const order = runOrder(run.run_number, run.run_attempt);
  if (run.conclusion === 'success') return { kind: 'ci_success', scope, seq: order };
  if (run.conclusion !== 'failure' && run.conclusion !== 'timed_out') {
    return { kind: 'ignored', reason: 'not_a_failure' };
  }
  // A run whose code comes from a fork is other people's code on our CI: never a duty's concern.
  const sameRepo = lower(run.head_repository?.full_name ?? '') === project.repo;
  if (!sameRepo || branch === '') return { kind: 'ignored', reason: 'fork_or_unknown_branch' };
  const own = branch.startsWith(OWN_BRANCH_PREFIX);
  const defaultBranch = branch === project.defaultBranch && run.event !== 'pull_request';
  if (!own && !defaultBranch) return { kind: 'ignored', reason: 'other_branch' };
  const fields: Array<[string, string]> = [
    ['workflow', run.name ?? ''],
    ['branch', branch],
    ['commit message', run.head_commit?.message ?? ''],
  ];
  return {
    kind: 'trigger',
    trigger: own ? 'ci_failed_own_pr' : 'ci_failed_default_branch',
    key: `workflow_run:${project.repo}:${run.id}:${run.run_attempt ?? 1}`,
    facts: {
      summary: `A CI run (id ${run.id}, attempt ${run.run_attempt ?? 1}, commit ${run.head_sha.slice(0, 12)}) ${run.conclusion === 'timed_out' ? 'timed out' : 'failed'}.`,
      ...(run.html_url === undefined ? {} : { url: run.html_url }),
      fields,
    },
    staleIf: { scope, seq: order },
    supersede: { scope, seq: order },
    ...(own ? { chain: { key: scope, seq: order } } : {}),
  };
}

function classifyIssue(data: z.infer<typeof Issues>, project: ProjectView): Classified {
  if (data.action !== 'opened') return { kind: 'ignored', reason: 'action' };
  if (data.issue.pull_request !== undefined) return { kind: 'ignored', reason: 'pull_request' };
  if (isSelfOrBot(data.sender, project)) return { kind: 'ignored', reason: 'self_or_bot' };
  return {
    kind: 'trigger',
    trigger: 'issue_opened',
    key: `issue:${project.repo}:${data.issue.number}`,
    facts: {
      summary: `Issue #${data.issue.number} was opened.`,
      ...(data.issue.html_url === undefined ? {} : { url: data.issue.html_url }),
      fields: [
        ['author', data.issue.user.login],
        ['title', data.issue.title],
        ['body', data.issue.body ?? ''],
      ],
    },
  };
}

function classifyIssueComment(
  data: z.infer<typeof IssueComment>,
  project: ProjectView,
): Classified {
  if (data.action !== 'created') return { kind: 'ignored', reason: 'action' };
  if (data.issue.pull_request === undefined)
    return { kind: 'ignored', reason: 'not_a_pull_request' };
  if (!isSelf(data.issue.user.login, project)) return { kind: 'ignored', reason: 'not_own_pr' };
  if (isSelfOrBot(data.sender, project)) return { kind: 'ignored', reason: 'self_or_bot' };
  return {
    kind: 'trigger',
    trigger: 'review_comment_own_pr',
    key: `comment:${project.repo}:${data.comment.id}`,
    facts: {
      summary: `A comment was added to your pull request #${data.issue.number}.`,
      ...(data.comment.html_url === undefined ? {} : { url: data.comment.html_url }),
      fields: [
        ['commenter', data.sender.login],
        ['title', data.issue.title],
        ['comment', data.comment.body ?? ''],
      ],
    },
  };
}

function classifyReviewComment(
  data: z.infer<typeof ReviewComment>,
  project: ProjectView,
): Classified {
  if (data.action !== 'created') return { kind: 'ignored', reason: 'action' };
  if (!isSelf(data.pull_request.user.login, project)) {
    return { kind: 'ignored', reason: 'not_own_pr' };
  }
  if (isSelfOrBot(data.sender, project)) return { kind: 'ignored', reason: 'self_or_bot' };
  return {
    kind: 'trigger',
    trigger: 'review_comment_own_pr',
    key: `review_comment:${project.repo}:${data.comment.id}`,
    facts: {
      summary: `A review comment was added to your pull request #${data.pull_request.number}.`,
      ...(data.comment.html_url === undefined ? {} : { url: data.comment.html_url }),
      fields: [
        ['reviewer', data.sender.login],
        ['file', data.comment.path ?? ''],
        ['comment', data.comment.body ?? ''],
      ],
    },
  };
}

/** A review's state in fixed words: the summary line is ours, so no payload text goes into it. */
const REVIEW_STATES: ReadonlyMap<string, string> = new Map([
  ['approved', 'approved'],
  ['changes_requested', 'changes requested'],
  ['commented', 'commented'],
  ['dismissed', 'dismissed'],
]);

function classifyReview(data: z.infer<typeof Review>, project: ProjectView): Classified {
  if (data.action !== 'submitted') return { kind: 'ignored', reason: 'action' };
  if (!isSelf(data.pull_request.user.login, project)) {
    return { kind: 'ignored', reason: 'not_own_pr' };
  }
  if (isSelfOrBot(data.sender, project)) return { kind: 'ignored', reason: 'self_or_bot' };
  const body = data.review.body ?? '';
  if (data.review.state.toLowerCase() === 'approved' && body.trim() === '') {
    return { kind: 'ignored', reason: 'approval_without_comment' };
  }
  return {
    kind: 'trigger',
    trigger: 'review_comment_own_pr',
    key: `review:${project.repo}:${data.review.id}`,
    facts: {
      summary: `A review (${REVIEW_STATES.get(data.review.state.toLowerCase()) ?? 'other'}) was submitted on your pull request #${data.pull_request.number}.`,
      ...(data.review.html_url === undefined ? {} : { url: data.review.html_url }),
      fields: [
        ['reviewer', data.sender.login],
        ['review', body],
      ],
    },
  };
}
