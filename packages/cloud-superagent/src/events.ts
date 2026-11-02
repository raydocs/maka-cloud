import { z } from 'zod';
import { checkSubject, conversationSubject, issueSubject, pullRequestSubject } from './subjects.js';
import type { Actor, EventSource, NormalizedEvent, Subject } from './types.js';

export type IngestInput =
  | {
      source: 'github';
      tenantId: string;
      deliveryId: string;
      event: string;
      payload: unknown;
      occurredAt?: number;
    }
  | {
      source: 'chat';
      tenantId: string;
      conversationId: string;
      messageId: string;
      text: string;
      actor: string;
      occurredAt?: number;
    }
  | {
      source: 'timer';
      tenantId: string;
      timerId: string;
      name: string;
      occurredAt?: number;
    }
  | {
      source: 'internal';
      tenantId: string;
      type: string;
      subject: Subject;
      summary: string;
      idempotencyKey: string;
      actor?: Actor;
      fields?: Array<[string, string]>;
      closesSubject?: boolean;
      occurredAt?: number;
    };

export type NormalizeResult =
  | { ok: true; event: Omit<NormalizedEvent, 'eventId'> }
  | { ok: false; reason: string };

const Account = z.object({ login: z.string().min(1), type: z.string().optional() });
const Repository = z.object({ full_name: z.string().min(1) });

function actorOf(login: string, type: string | undefined): Actor {
  const kind = type?.toLowerCase() === 'bot' ? 'bot' : 'user';
  return { login, kind };
}

function clip(value: string, max = 4000): string {
  return value.length <= max ? value : value.slice(0, max);
}

export function normalize(input: IngestInput, receivedAt: number): NormalizeResult {
  const occurredAt = input.occurredAt ?? receivedAt;
  if (input.source === 'chat') {
    return {
      ok: true,
      event: {
        tenantId: input.tenantId,
        source: 'chat',
        type: 'user_message',
        subject: conversationSubject(input.tenantId, input.conversationId),
        idempotencyKey: `chat:${input.tenantId}:${input.messageId}`,
        actor: { login: input.actor, kind: 'user' },
        occurredAt,
        receivedAt,
        summary: 'A user message arrived.',
        fields: [['text', clip(input.text)]],
        closesSubject: false,
      },
    };
  }
  if (input.source === 'timer') {
    return {
      ok: true,
      event: {
        tenantId: input.tenantId,
        source: 'timer',
        type: 'tick',
        subject: null,
        idempotencyKey: `timer:${input.tenantId}:${input.timerId}`,
        actor: { login: 'timer', kind: 'system' },
        occurredAt,
        receivedAt,
        summary: `A timer fired (${input.name}).`,
        fields: [['name', input.name]],
        closesSubject: false,
      },
    };
  }
  if (input.source === 'internal') {
    return {
      ok: true,
      event: {
        tenantId: input.tenantId,
        source: 'internal',
        type: input.type,
        subject: input.subject,
        idempotencyKey: input.idempotencyKey,
        actor: input.actor ?? { login: 'system', kind: 'system' },
        occurredAt,
        receivedAt,
        summary: input.summary,
        fields: input.fields ?? [],
        closesSubject: input.closesSubject === true,
      },
    };
  }
  return normalizeGithub(input, receivedAt, occurredAt);
}

function normalizeGithub(
  input: Extract<IngestInput, { source: 'github' }>,
  receivedAt: number,
  occurredAt: number,
): NormalizeResult {
  if (input.event === 'ping') {
    return {
      ok: true,
      event: base(input, receivedAt, occurredAt, {
        type: 'ping',
        subject: null,
        actor: { login: 'github', kind: 'system' },
        summary: 'GitHub sent a ping.',
        fields: [],
        closesSubject: false,
      }),
    };
  }
  if (input.event === 'pull_request') return githubPullRequest(input, receivedAt, occurredAt);
  if (input.event === 'issues') return githubIssues(input, receivedAt, occurredAt);
  if (input.event === 'issue_comment') return githubIssueComment(input, receivedAt, occurredAt);
  if (input.event === 'pull_request_review' || input.event === 'pull_request_review_comment') {
    return githubReview(input, receivedAt, occurredAt);
  }
  if (input.event === 'workflow_run') return githubWorkflow(input, receivedAt, occurredAt);
  return { ok: false, reason: 'unsupported_event' };
}

function base(
  input: Extract<IngestInput, { source: 'github' }>,
  receivedAt: number,
  occurredAt: number,
  rest: {
    type: string;
    subject: Subject | null;
    actor: Actor;
    summary: string;
    fields: Array<[string, string]>;
    closesSubject: boolean;
  },
): Omit<NormalizedEvent, 'eventId'> {
  return {
    tenantId: input.tenantId,
    source: 'github' satisfies EventSource,
    idempotencyKey: `github:${input.tenantId}:${input.deliveryId}`,
    occurredAt,
    receivedAt,
    ...rest,
  };
}

const PullRequestPayload = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number().int(),
    title: z.string().optional(),
    html_url: z.string().optional(),
    merged: z.boolean().optional(),
    state: z.string().optional(),
    user: Account,
    head: z.object({ ref: z.string().optional() }).optional(),
  }),
  repository: Repository,
  sender: Account,
});

function githubPullRequest(
  input: Extract<IngestInput, { source: 'github' }>,
  receivedAt: number,
  occurredAt: number,
): NormalizeResult {
  const parsed = PullRequestPayload.safeParse(input.payload);
  if (!parsed.success) return { ok: false, reason: 'invalid_payload' };
  const data = parsed.data;
  const subject = pullRequestSubject(
    input.tenantId,
    data.repository.full_name,
    data.pull_request.number,
  );
  if (data.pull_request.head?.ref) subject.branch = data.pull_request.head.ref;
  const closed = data.action === 'closed' || data.action === 'merged';
  const type =
    data.action === 'opened' || data.action === 'reopened'
      ? 'pr_opened'
      : closed
        ? 'pr_closed'
        : 'pr_updated';
  return {
    ok: true,
    event: base(input, receivedAt, occurredAt, {
      type,
      subject: { ...subject, closed },
      actor: actorOf(data.sender.login, data.sender.type),
      summary: `Pull request #${data.pull_request.number} ${data.action}.`,
      fields: [
        ['title', data.pull_request.title ?? ''],
        ['author', data.pull_request.user.login],
      ],
      closesSubject: closed,
    }),
  };
}

const IssuesPayload = z.object({
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
  sender: Account,
});

function githubIssues(
  input: Extract<IngestInput, { source: 'github' }>,
  receivedAt: number,
  occurredAt: number,
): NormalizeResult {
  const parsed = IssuesPayload.safeParse(input.payload);
  if (!parsed.success) return { ok: false, reason: 'invalid_payload' };
  const data = parsed.data;
  if (data.issue.pull_request !== undefined) {
    return githubPullRequest(
      {
        ...input,
        event: 'pull_request',
        payload: {
          action: data.action,
          pull_request: { ...data.issue, number: data.issue.number, user: data.issue.user },
          repository: data.repository,
          sender: data.sender,
        },
      },
      receivedAt,
      occurredAt,
    );
  }
  const subject = issueSubject(input.tenantId, data.repository.full_name, data.issue.number);
  const closed = data.action === 'closed';
  const type =
    data.action === 'opened' ? 'issue_opened' : closed ? 'issue_closed' : 'issue_updated';
  return {
    ok: true,
    event: base(input, receivedAt, occurredAt, {
      type,
      subject: { ...subject, closed },
      actor: actorOf(data.sender.login, data.sender.type),
      summary: `Issue #${data.issue.number} ${data.action}.`,
      fields: [
        ['title', data.issue.title],
        ['body', clip(data.issue.body ?? '')],
        ['author', data.issue.user.login],
      ],
      closesSubject: closed,
    }),
  };
}

const IssueCommentPayload = z.object({
  action: z.string(),
  issue: z.object({
    number: z.number().int(),
    title: z.string().optional(),
    pull_request: z.unknown().optional(),
  }),
  comment: z.object({
    id: z.number().int(),
    body: z.string().nullable().optional(),
  }),
  repository: Repository,
  sender: Account,
});

function githubIssueComment(
  input: Extract<IngestInput, { source: 'github' }>,
  receivedAt: number,
  occurredAt: number,
): NormalizeResult {
  const parsed = IssueCommentPayload.safeParse(input.payload);
  if (!parsed.success) return { ok: false, reason: 'invalid_payload' };
  const data = parsed.data;
  const repo = data.repository.full_name;
  const subject =
    data.issue.pull_request === undefined
      ? issueSubject(input.tenantId, repo, data.issue.number)
      : pullRequestSubject(input.tenantId, repo, data.issue.number);
  return {
    ok: true,
    event: base(input, receivedAt, occurredAt, {
      type: 'issue_comment',
      subject,
      actor: actorOf(data.sender.login, data.sender.type),
      summary: `A comment was added to ${subject.kind === 'pull_request' ? 'pull request' : 'issue'} #${data.issue.number}.`,
      fields: [
        ['commenter', data.sender.login],
        ['comment', clip(data.comment.body ?? '')],
      ],
      closesSubject: false,
    }),
  };
}

const ReviewPayload = z.object({
  action: z.string(),
  pull_request: z.object({ number: z.number().int(), title: z.string().optional() }),
  review: z
    .object({ body: z.string().nullable().optional(), state: z.string().optional() })
    .optional(),
  comment: z
    .object({ body: z.string().nullable().optional(), path: z.string().optional() })
    .optional(),
  repository: Repository,
  sender: Account,
});

function githubReview(
  input: Extract<IngestInput, { source: 'github' }>,
  receivedAt: number,
  occurredAt: number,
): NormalizeResult {
  const parsed = ReviewPayload.safeParse(input.payload);
  if (!parsed.success) return { ok: false, reason: 'invalid_payload' };
  const data = parsed.data;
  const subject = pullRequestSubject(
    input.tenantId,
    data.repository.full_name,
    data.pull_request.number,
  );
  const body = data.comment?.body ?? data.review?.body ?? '';
  return {
    ok: true,
    event: base(input, receivedAt, occurredAt, {
      type: 'review_comment',
      subject,
      actor: actorOf(data.sender.login, data.sender.type),
      summary: `A review comment was added to pull request #${data.pull_request.number}.`,
      fields: [
        ['reviewer', data.sender.login],
        ['comment', clip(body)],
        ['file', data.comment?.path ?? ''],
        ['state', (data.review?.state ?? '').toLowerCase()],
        ['action', data.action],
      ],
      closesSubject: false,
    }),
  };
}

const WorkflowPayload = z.object({
  action: z.string(),
  workflow_run: z.object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
    head_sha: z.string(),
    conclusion: z.string().nullable(),
    head_branch: z.string().nullable().optional(),
    pull_requests: z.array(z.object({ number: z.number().int() })).optional(),
  }),
  repository: Repository,
  sender: Account.optional(),
});

function githubWorkflow(
  input: Extract<IngestInput, { source: 'github' }>,
  receivedAt: number,
  occurredAt: number,
): NormalizeResult {
  const parsed = WorkflowPayload.safeParse(input.payload);
  if (!parsed.success) return { ok: false, reason: 'invalid_payload' };
  const data = parsed.data;
  if (data.action !== 'completed') {
    return { ok: false, reason: 'ignored_action' };
  }
  const run = data.workflow_run;
  const failed = run.conclusion === 'failure' || run.conclusion === 'timed_out';
  const passed = run.conclusion === 'success';
  if (!failed && !passed) return { ok: false, reason: 'ignored_conclusion' };
  const pr = run.pull_requests?.[0]?.number;
  const repo = data.repository.full_name;
  const subject =
    pr === undefined
      ? checkSubject(input.tenantId, repo, run.head_sha, run.name ?? 'workflow')
      : pullRequestSubject(input.tenantId, repo, pr);
  if (run.head_branch && subject.kind === 'pull_request') subject.branch = run.head_branch;
  return {
    ok: true,
    event: base(input, receivedAt, occurredAt, {
      type: failed ? 'ci_failed' : 'ci_passed',
      subject,
      actor: actorOf(data.sender?.login ?? 'github', data.sender?.type ?? 'bot'),
      summary: `A CI run ${failed ? 'failed' : 'passed'} (${run.name ?? 'workflow'}).`,
      fields: [
        ['workflow', run.name ?? ''],
        ['branch', run.head_branch ?? ''],
        ['sha', run.head_sha],
      ],
      closesSubject: false,
    }),
  };
}
