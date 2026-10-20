import { z } from 'zod';

/**
 * What a duty may do, lowest first. The conductor enforces it at its tool gate (T23 PR 2); a run
 * can never raise its own level.
 */
export const AUTHORITIES = ['read-only', 'open-pr', 'merge-when-green'] as const;
export const AuthoritySchema = z.enum(AUTHORITIES);
export type Authority = z.infer<typeof AuthoritySchema>;

export const MAX_RUN_BUDGET_USD = 20;
export const MAX_DAILY_CAP_USD = 100;
export const MAX_INSTRUCTION_CHARS = 4000;
export const MIN_SCHEDULE_MINUTES = 60;
export const MAX_SCHEDULE_MINUTES = 10_080;

/** The branch prefix `open_pull_request` gives the employee's own pull requests. */
export const OWN_BRANCH_PREFIX = 'maka/';

const Schedule = z
  .object({
    kind: z.literal('schedule'),
    /** A slot every this many minutes, counted from the moment the duty was approved. */
    everyMinutes: z.number().int().min(MIN_SCHEDULE_MINUTES).max(MAX_SCHEDULE_MINUTES),
  })
  .strict();

export const TriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ci_failed_default_branch') }).strict(),
  z.object({ kind: z.literal('ci_failed_own_pr') }).strict(),
  z.object({ kind: z.literal('issue_opened') }).strict(),
  z.object({ kind: z.literal('review_comment_own_pr') }).strict(),
  Schedule,
]);
export type Trigger = z.infer<typeof TriggerSchema>;
export type TriggerKind = Trigger['kind'];

/** A duty as proposed or edited: strict, with hard ceilings on what one run and one day may spend. */
export const DutySpecSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    trigger: TriggerSchema,
    instruction: z.string().trim().min(1).max(MAX_INSTRUCTION_CHARS),
    authority: AuthoritySchema,
    runBudgetUsd: z.number().positive().max(MAX_RUN_BUDGET_USD),
    dailyCapUsd: z.number().positive().max(MAX_DAILY_CAP_USD),
  })
  .strict()
  .refine((duty) => duty.dailyCapUsd >= duty.runBudgetUsd, {
    message: 'The daily cap must cover at least one run.',
    path: ['dailyCapUsd'],
  });
export type DutySpec = z.infer<typeof DutySpecSchema>;

export type DutyState = 'proposed' | 'active' | 'off';

export interface Duty extends DutySpec {
  dutyId: string;
  projectId: string;
  state: DutyState;
  /** When the user approved it; null until then. Schedules count from here. */
  activatedAt: number | null;
}

export interface Project {
  projectId: string;
  owner: string;
  repo: string;
  installationId: number;
  defaultBranch: string;
  selfLogins: string[];
  createdAt: number;
  duties: Duty[];
}

export const RepoSchema = z
  .string()
  .max(140)
  .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u);

export const AddProjectSchema = z
  .object({
    repo: RepoSchema,
    installationId: z.number().int().positive(),
    defaultBranch: z.string().min(1).max(255),
    /** The accounts that are the employee: their comments never trigger a duty, and a pull request they author is "its own". */
    selfLogins: z.array(z.string().min(1).max(100)).min(1).max(10),
  })
  .strict();
export type AddProjectInput = z.infer<typeof AddProjectSchema>;

export interface ProposalSet {
  id: string;
  label: string;
  recommended: boolean;
  dutyIds: string[];
}

export interface Proposal {
  proposalId: string;
  projectId: string;
  state: 'open' | 'decided';
  /** Recommended set first. */
  sets: ProposalSet[];
  decidedSet: string | null;
}

/** Money is stored as whole micro-dollars, so sums are exact. */
export const toMicro = (usd: number): number => Math.round(usd * 1_000_000);
export const fromMicro = (micro: number): number => micro / 1_000_000;

export function authorityRank(authority: Authority): number {
  return AUTHORITIES.indexOf(authority);
}

export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
