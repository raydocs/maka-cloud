import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DutyEngine, type EngineOptions } from '../engine.js';
import type { DutyProposal, RepoFacts } from '../propose.js';
import type { Authority, DutySpec } from '../types.js';

export const SECRET = 'a-webhook-secret-of-sufficient-length';
export const OWNER = 'inv_owner';
export const REPO = 'acme/widgets';
export const INSTALLATION = 4242;
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);

export class Clock {
  constructor(public t = T0) {}
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export const FACTS: RepoFacts = {
  defaultBranch: 'main',
  workflows: ['CI'],
  openIssues: 3,
  failedRunsLast30Days: 2,
};

export function spec(over: Partial<DutySpec> & Pick<DutySpec, 'trigger'>): DutySpec {
  return {
    name: 'A duty',
    instruction: 'Do the work.',
    authority: 'read-only' as Authority,
    runBudgetUsd: 2,
    dailyCapUsd: 6,
    ...over,
  };
}

export function proposalOf(...duties: DutySpec[]): DutyProposal {
  const all = duties.map((_, index) => index);
  return {
    duties,
    sets: [
      { id: 'recommended', label: 'All', recommended: true, duties: all },
      { id: 'none', label: 'None', recommended: false, duties: [] },
    ],
  };
}

export interface Rig {
  engine: DutyEngine;
  clock: Clock;
  dbPath: string;
  projectId: string;
  /** Registers a duty set as an approved proposal and returns the duty ids in order. */
  activate(...duties: DutySpec[]): Promise<string[]>;
  deliver(
    event: string,
    payload: unknown,
    options?: { id?: string; secret?: string },
  ): ReturnType<DutyEngine['receive']>;
  reopen(): DutyEngine;
  cleanup(): void;
}

let counter = 0;

export function sign(body: Uint8Array | string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function request(
  event: string,
  payload: unknown,
  options: { id?: string; secret?: string } = {},
) {
  const body = Buffer.from(JSON.stringify(payload));
  return {
    headers: {
      'x-github-event': event,
      'x-github-delivery': options.id ?? `d${++counter}`,
      'x-hub-signature-256': sign(body, options.secret),
    },
    body,
  };
}

export async function rig(options: Partial<EngineOptions> & { file?: boolean } = {}): Promise<Rig> {
  const clock = new Clock();
  const dir = mkdtempSync(join(tmpdir(), 'duties-'));
  const dbPath = options.file ? join(dir, 'duties.db') : ':memory:';
  let proposing: DutyProposal | undefined;
  const make = (): DutyEngine =>
    new DutyEngine({
      dbPath,
      webhookSecret: SECRET,
      allowProject: () => true,
      now: clock.now,
      proposer: () => proposing as DutyProposal,
      ...options,
    });
  let engine = make();
  const added = engine.addProject(OWNER, {
    repo: REPO,
    installationId: INSTALLATION,
    defaultBranch: 'main',
    selfLogins: ['maka-bot'],
  });
  if (!added.ok) throw new Error('could not add the project');
  const projectId = added.project.projectId;
  const self: Rig = {
    get engine() {
      return engine;
    },
    clock,
    dbPath,
    projectId,
    async activate(...duties: DutySpec[]) {
      proposing = proposalOf(...duties);
      const proposed = await engine.propose(OWNER, projectId, { inspect: async () => FACTS });
      if (!proposed.ok) throw new Error(`propose failed: ${proposed.reason}`);
      const decided = engine.decideProposal({
        proposalId: proposed.proposal.proposalId,
        setId: 'recommended',
        caller: OWNER,
      });
      if (!decided.ok) throw new Error(`decide failed: ${decided.reason}`);
      return proposed.proposal.sets[0]?.dutyIds ?? [];
    },
    deliver(event, payload, opts) {
      const { headers, body } = request(event, payload, opts);
      return engine.receive(headers, body);
    },
    reopen() {
      engine.close();
      engine = make();
      return engine;
    },
    cleanup() {
      try {
        engine.close();
      } catch {
        // Already closed.
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return self;
}

// ---- payloads

const sender = { login: 'alice', type: 'User' };
const base = { repository: { full_name: REPO }, installation: { id: INSTALLATION } };

export function workflowRun(
  over: {
    id?: number;
    attempt?: number;
    number?: number;
    workflowId?: number;
    branch?: string;
    conclusion?: string | null;
    action?: string;
    event?: string;
    headRepo?: string;
    commitMessage?: string;
    name?: string;
  } = {},
) {
  return {
    action: over.action ?? 'completed',
    workflow_run: {
      id: over.id ?? 1000,
      run_attempt: over.attempt ?? 1,
      run_number: over.number ?? 10,
      workflow_id: over.workflowId ?? 7,
      name: over.name ?? 'CI',
      head_branch: over.branch ?? 'main',
      head_sha: 'abcdef0123456789abcdef0123456789abcdef01',
      conclusion: over.conclusion === undefined ? 'failure' : over.conclusion,
      event: over.event ?? 'push',
      html_url: 'https://github.com/acme/widgets/actions/runs/1000',
      head_repository: { full_name: over.headRepo ?? REPO },
      head_commit: { message: over.commitMessage ?? 'fix: a thing' },
    },
    ...base,
    sender,
  };
}

export function issueOpened(
  over: {
    number?: number;
    title?: string;
    body?: string;
    user?: string;
    senderType?: string;
    action?: string;
  } = {},
) {
  return {
    action: over.action ?? 'opened',
    issue: {
      number: over.number ?? 5,
      title: over.title ?? 'It breaks',
      body: over.body ?? 'Steps to reproduce',
      html_url: 'https://github.com/acme/widgets/issues/5',
      user: { login: over.user ?? 'alice', type: 'User' },
    },
    ...base,
    sender: { login: over.user ?? 'alice', type: over.senderType ?? 'User' },
  };
}

export function issueComment(
  over: {
    commentId?: number;
    prAuthor?: string;
    commenter?: string;
    body?: string;
    isPr?: boolean;
    senderType?: string;
  } = {},
) {
  return {
    action: 'created',
    issue: {
      number: 9,
      title: 'Add a thing',
      user: { login: over.prAuthor ?? 'maka-bot', type: 'User' },
      ...(over.isPr === false ? {} : { pull_request: { url: 'https://api.github.com/x' } }),
    },
    comment: {
      id: over.commentId ?? 77,
      body: over.body ?? 'please rename it',
      html_url: 'https://github.com/acme/widgets/pull/9#issuecomment-77',
    },
    ...base,
    sender: { login: over.commenter ?? 'alice', type: over.senderType ?? 'User' },
  };
}

export function reviewComment(
  over: { id?: number; prAuthor?: string; commenter?: string; body?: string } = {},
) {
  return {
    action: 'created',
    pull_request: {
      number: 9,
      title: 'Add a thing',
      user: { login: over.prAuthor ?? 'maka-bot', type: 'User' },
    },
    comment: {
      id: over.id ?? 88,
      body: over.body ?? 'nit',
      path: 'src/a.ts',
      html_url: 'https://github.com/acme/widgets/pull/9#discussion_r88',
    },
    ...base,
    sender: { login: over.commenter ?? 'alice', type: 'User' },
  };
}

export function review(
  over: { id?: number; state?: string; body?: string; prAuthor?: string } = {},
) {
  return {
    action: 'submitted',
    pull_request: {
      number: 9,
      title: 'Add a thing',
      user: { login: over.prAuthor ?? 'maka-bot', type: 'User' },
    },
    review: {
      id: over.id ?? 99,
      state: over.state ?? 'changes_requested',
      body: over.body ?? 'Needs work',
      html_url: 'https://github.com/acme/widgets/pull/9#pullrequestreview-99',
    },
    ...base,
    sender,
  };
}

export const CI_DEFAULT = spec({
  name: 'ci',
  trigger: { kind: 'ci_failed_default_branch' },
  authority: 'open-pr',
});
export const CI_OWN = spec({
  name: 'ci own',
  trigger: { kind: 'ci_failed_own_pr' },
  authority: 'open-pr',
});
export const ISSUES = spec({ name: 'issues', trigger: { kind: 'issue_opened' } });
export const REVIEWS = spec({
  name: 'reviews',
  trigger: { kind: 'review_comment_own_pr' },
  authority: 'open-pr',
});
export const WEEKLY = spec({ name: 'weekly', trigger: { kind: 'schedule', everyMinutes: 60 } });
