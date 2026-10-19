/** What a finished child task hands back (the T2 result manifest). */
export interface Manifest {
  summary: string;
  done: string[];
  notDone: string[];
  confidence: 'low' | 'medium' | 'high';
  knownIssues: string[];
  artifacts?: string[];
}

export interface Verdict {
  ok: boolean;
  problems: string[];
}

export interface Playbook {
  id: string;
  /** One line for the conductor's system prompt: when to pick this playbook. */
  description: string;
  /** Runners a run on this playbook may delegate to. */
  allowedRunners: readonly string[];
  /** What the planner is told about planning this kind of work. */
  planningInstructions: string;
  /** The steps the conductor follows after planning, returned with the plan. */
  steps: readonly string[];
  /** Checks a finished child task's manifest before the conductor relies on it. */
  verify(manifest: Manifest): Verdict;
}

export const RUNNERS = ['claude-agent-sdk', 'codex'] as const;

/** The checks every playbook starts from. T7 and T8 add their own on top. */
export function verifyManifest(manifest: Manifest): Verdict {
  const problems: string[] = [];
  if (manifest.notDone.length > 0) problems.push(`not done: ${manifest.notDone.join('; ')}`);
  if (manifest.confidence === 'low') problems.push('the task reports low confidence');
  if (manifest.knownIssues.length > 0)
    problems.push(`known issues: ${manifest.knownIssues.join('; ')}`);
  return { ok: problems.length === 0, problems };
}

export const RESEARCH_PLAYBOOK: Playbook = {
  id: 'research',
  description:
    'Answer a question with a written report whose every claim is checked against a fetched source.',
  allowedRunners: RUNNERS,
  planningInstructions:
    'Break the question into sub-questions, say which sources to search and fetch for each, and how every citation in the draft will be checked against the fetched text.',
  steps: [
    'Delegate the searching, fetching and drafting with the plan as the brief.',
    'Wait for the result and read its verification.',
    'Delegate fixes for unsupported or unverified claims, or remove them.',
    'Deliver the report with its sources and what was and was not verified.',
  ],
  verify: verifyManifest,
};

export const CODING_PLAYBOOK: Playbook = {
  id: 'coding',
  description: 'Change code in a repository and deliver the change as a pull request.',
  allowedRunners: RUNNERS,
  planningInstructions:
    "Name the repository and the change, the files likely involved, the reproduction test to write first, and the repository's own test command.",
  steps: [
    'Delegate the implementation to one runner with the plan as the brief.',
    'Wait for the result and read its verification.',
    'If tests fail or the result is not verified, delegate a fix with what failed.',
    'Deliver the pull request link and what was and was not verified.',
  ],
  verify: verifyManifest,
};

export const FREE_PLAYBOOK: Playbook = {
  id: 'free',
  description: 'Anything else: make a plan for the goal and carry it out step by step.',
  allowedRunners: RUNNERS,
  planningInstructions:
    'Write the shortest plan that reaches the goal: the steps, which ones need a runner, and how each result will be checked.',
  steps: [
    'Carry out the plan, delegating the steps that need a runner.',
    'Check each result before relying on it.',
    'Deliver the outcome and what was and was not verified.',
  ],
  verify: verifyManifest,
};

export const DEFAULT_PLAYBOOKS: readonly Playbook[] = [
  RESEARCH_PLAYBOOK,
  CODING_PLAYBOOK,
  FREE_PLAYBOOK,
];
