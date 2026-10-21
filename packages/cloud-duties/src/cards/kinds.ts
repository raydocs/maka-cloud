import type { Authority } from '../types.js';

/**
 * The mode ids of `@maka-cloud/modes`, spelled here so the duties package takes no dependency on
 * it. The host checks every kind's mode against the real list (`cards-host.test.ts`), and the
 * conductor refuses a mode it does not know.
 */
export type CardMode = 'quick' | 'standard' | 'deep';

/**
 * What a proposed card may be. The table is code: a card's authority and mode are read from it
 * and never from a stored or scanned text, so no wording, however it was written, can make a card
 * more than its kind. A kind that needs a tool this build does not have is `gated`: it is never
 * proposed until the operator names it in `enabled`.
 */
export const CARD_KINDS = [
  'fix_main_ci',
  'update_dependencies',
  'rebase_pr',
  'fix_pr_checks',
  'answer_review',
  'triage_issue',
  'stabilise_flaky',
  'finish_leftovers',
  'merge_pr',
  'close_issues',
] as const;
export type CardKind = (typeof CARD_KINDS)[number];

export interface KindSpec {
  /** What the owner is told about this kind in a list of switches. */
  label: string;
  /** The most a run started from the card may do: the run's authority. */
  authority: Authority;
  /** The mode the task runs in. */
  mode: CardMode;
  /** The estimate shown until enough finished tasks of this kind exist, in dollars. */
  defaultEstimateUsd: number;
  /** Only pull requests the employee opened itself: it never pushes to someone else's branch. */
  ownPullRequestsOnly: boolean;
  /** The tool this kind needs does not exist yet; set the kind in `enabled` once it does. */
  gated: boolean;
}

export const KIND_SPECS: Readonly<Record<CardKind, KindSpec>> = {
  fix_main_ci: {
    label: 'Fix failing tests on the default branch',
    authority: 'open-pr',
    mode: 'standard',
    defaultEstimateUsd: 3,
    ownPullRequestsOnly: false,
    gated: false,
  },
  update_dependencies: {
    label: 'Update vulnerable dependencies',
    authority: 'open-pr',
    mode: 'standard',
    defaultEstimateUsd: 3,
    ownPullRequestsOnly: false,
    gated: false,
  },
  rebase_pr: {
    label: 'Rebase my pull requests that conflict',
    authority: 'open-pr',
    mode: 'quick',
    defaultEstimateUsd: 1,
    ownPullRequestsOnly: true,
    gated: false,
  },
  fix_pr_checks: {
    label: 'Fix failing checks on my pull requests',
    authority: 'open-pr',
    mode: 'standard',
    defaultEstimateUsd: 2.5,
    ownPullRequestsOnly: true,
    gated: false,
  },
  answer_review: {
    label: 'Answer review comments on my pull requests',
    authority: 'open-pr',
    mode: 'standard',
    defaultEstimateUsd: 2,
    ownPullRequestsOnly: true,
    gated: false,
  },
  triage_issue: {
    label: 'Look into new issues',
    authority: 'read-only',
    mode: 'quick',
    defaultEstimateUsd: 1,
    ownPullRequestsOnly: false,
    gated: false,
  },
  stabilise_flaky: {
    label: 'Stabilise flaky tests',
    authority: 'open-pr',
    mode: 'standard',
    defaultEstimateUsd: 3,
    ownPullRequestsOnly: false,
    gated: false,
  },
  finish_leftovers: {
    label: 'Finish what an earlier task left out',
    authority: 'open-pr',
    mode: 'standard',
    defaultEstimateUsd: 2.5,
    ownPullRequestsOnly: false,
    gated: false,
  },
  // Needs T26's merge tool (the exact-SHA green check). Until it ships, a card that said "Merge"
  // would promise something no tool can do.
  merge_pr: {
    label: 'Merge pull requests whose checks passed',
    authority: 'merge-when-green',
    mode: 'quick',
    defaultEstimateUsd: 0.5,
    ownPullRequestsOnly: true,
    gated: true,
  },
  // Needs a tool that closes issues, which no authority level covers yet.
  close_issues: {
    label: 'Close issues the last release fixed',
    authority: 'open-pr',
    mode: 'quick',
    defaultEstimateUsd: 1,
    ownPullRequestsOnly: false,
    gated: true,
  },
};

export function isCardKind(value: unknown): value is CardKind {
  return typeof value === 'string' && (CARD_KINDS as readonly string[]).includes(value);
}

/** The kinds this build proposes by default: every kind whose tool exists. */
export function defaultEnabledKinds(): ReadonlySet<CardKind> {
  return new Set(CARD_KINDS.filter((kind) => !KIND_SPECS[kind].gated));
}
