import { type DutySpec, DutySpecSchema } from './types.js';

/** What the inspector learned about a repository. */
export interface RepoFacts {
  defaultBranch: string;
  /** Names of the CI workflows that are enabled. */
  workflows: string[];
  openIssues: number;
  /** Failed CI runs on the default branch in the last 30 days. */
  failedRunsLast30Days: number;
}

export interface RepoInspector {
  inspect(repo: string, signal?: AbortSignal): Promise<RepoFacts>;
}

export interface ProposedSet {
  id: string;
  label: string;
  recommended: boolean;
  /** Indexes into the proposal's duties. */
  duties: number[];
}

export interface DutyProposal {
  duties: DutySpec[];
  /** The recommended set first. */
  sets: ProposedSet[];
}

export const MIN_PROPOSED = 2;
export const MAX_PROPOSED = 4;

interface Candidate {
  spec: DutySpec;
  applies(facts: RepoFacts): boolean;
  score(facts: RepoFacts): number;
}

const NO_GUESSING =
  'If you cannot find the cause or the answer, report what you found instead of guessing.';

const CANDIDATES: Candidate[] = [
  {
    spec: {
      name: 'Fix failing CI on the default branch',
      trigger: { kind: 'ci_failed_default_branch' },
      instruction: `When CI fails on the default branch, find the cause in the failed run, reproduce it, and fix it with the smallest change that makes the checks pass. Add or repair the test that would have caught it. Deliver the fix as a pull request; never push to the default branch. ${NO_GUESSING}`,
      authority: 'open-pr',
      runBudgetUsd: 5,
      dailyCapUsd: 15,
    },
    applies: (facts) => facts.workflows.length > 0,
    score: (facts) => 100 + Math.min(facts.failedRunsLast30Days, 20) * 2,
  },
  {
    spec: {
      name: 'Keep my pull requests green',
      trigger: { kind: 'ci_failed_own_pr' },
      instruction: `When CI fails on a pull request you opened, find the cause, fix it on that branch with the smallest change, and re-run the checks. Fix it at most once; if it still fails, report why instead of trying again. ${NO_GUESSING}`,
      authority: 'open-pr',
      runBudgetUsd: 4,
      dailyCapUsd: 12,
    },
    applies: (facts) => facts.workflows.length > 0,
    score: () => 80,
  },
  {
    spec: {
      name: 'Answer review comments on my pull requests',
      trigger: { kind: 'review_comment_own_pr' },
      instruction: `When someone reviews or comments on a pull request you opened, work out what they ask for. If it is a clear change, make it and update the pull request; if it is a question, answer it in your report. Do not argue; if you disagree, say why and let the owner decide. ${NO_GUESSING}`,
      authority: 'open-pr',
      runBudgetUsd: 3,
      dailyCapUsd: 9,
    },
    applies: () => true,
    score: () => 70,
  },
  {
    spec: {
      name: 'Triage new issues',
      trigger: { kind: 'issue_opened' },
      instruction: `When an issue is opened, read it, try to reproduce it, and report: what it is, how serious it looks, the likely cause and where in the code, and whether you could fix it. Change nothing. ${NO_GUESSING}`,
      authority: 'read-only',
      runBudgetUsd: 1.5,
      dailyCapUsd: 6,
    },
    applies: () => true,
    score: (facts) => 60 + Math.min(facts.openIssues, 40),
  },
  {
    spec: {
      name: 'Weekly repository health report',
      trigger: { kind: 'schedule', everyMinutes: 10_080 },
      instruction: `Once a week, check the repository: the state of CI on the default branch, stale pull requests, and open issues nobody has answered. Report what needs the owner's attention, most important first. Change nothing. ${NO_GUESSING}`,
      authority: 'read-only',
      runBudgetUsd: 2,
      dailyCapUsd: 2,
    },
    applies: () => true,
    score: () => 40,
  },
];

/**
 * Chooses two to four duties for a repository from what was found in it, by fixed rules (no
 * model, so the same facts always give the same proposal). The recommended set is every chosen
 * duty; the others are the read-only ones alone and none at all.
 */
export function proposeDuties(facts: RepoFacts): DutyProposal {
  const chosen = CANDIDATES.filter((candidate) => candidate.applies(facts))
    .map((candidate, order) => ({ candidate, order, score: candidate.score(facts) }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MAX_PROPOSED)
    .map(({ candidate }) => DutySpecSchema.parse(candidate.spec));
  if (chosen.length < MIN_PROPOSED) throw new Error('Fewer than two duties apply.');
  const all = chosen.map((_, index) => index);
  const readOnly = all.filter((index) => chosen[index]?.authority === 'read-only');
  const sets: ProposedSet[] = [
    {
      id: 'recommended',
      label: `Set up all ${chosen.length}: ${chosen.map((duty) => duty.name).join('; ')}`,
      recommended: true,
      duties: all,
    },
  ];
  if (readOnly.length > 0 && readOnly.length < chosen.length) {
    sets.push({
      id: 'read-only',
      label: `Only the read-only ones: ${readOnly.map((index) => chosen[index]?.name).join('; ')}`,
      recommended: false,
      duties: readOnly,
    });
  }
  sets.push({ id: 'none', label: 'No standing duties for now', recommended: false, duties: [] });
  return { duties: chosen, sets };
}
