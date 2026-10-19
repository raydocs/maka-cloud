import type { CodingTask, Vendor } from './task.js';

/** What the second vendor is told about the first one's attempt (`failure_brief.json`). */
export interface FailureBrief {
  repo: string;
  baseSha: string;
  goal: string;
  testCommand: string;
  /** The vendor that tried first. */
  vendor: Vendor;
  /** Why the task was taken from it. */
  reason: string;
  /** One entry per run of that vendor: what happened and, for a failed check, its output. */
  runs: { run: number; outcome: string; output?: string }[];
  /** The attempt's diff against the base commit, in the task directory. */
  attemptPatch: string;
}

export interface CheckProblem {
  /** One line: what failed. */
  problem: string;
  /** The end of the failing command's output, when there is one. */
  output?: string;
}

const NO_TAMPERING = [
  'Do not commit, push, change git remotes or open pull requests: leave the change in the working tree, the runner takes it from there.',
  'Never look for, fetch or use hidden or held-out tests; only the repository and what you write count.',
].join(' ');

/** The brief an agent starts from, in Markdown. `dir` is the task directory in the sandbox. */
export function agentBrief(input: {
  task: CodingTask;
  baseSha: string;
  dir: string;
  /** The conductor's brief, plan included. */
  conductorBrief: string;
  /** Set when an earlier vendor failed: the second vendor's brief points at its failure brief. */
  failure?: { vendor: Vendor; reason: string };
}): string {
  const { task, baseSha, dir } = input;
  const sections = [
    '# Coding task',
    `Repository \`${task.repo}\`, checked out at commit \`${baseSha}\` in \`${dir}/workspace\`.`,
    '## Goal',
    task.goal,
    '## How your work is checked',
    [
      `1. First write a reproduction test: a test that fails on commit \`${baseSha.slice(0, 12)}\` and passes once the change is made.`,
      `   Record it in \`${dir}/repro.json\` as \`{"command": "...", "files": ["..."]}\`: \`command\` runs only that test from the repository root, \`files\` are its test files relative to the repository root.`,
      '2. Make the change.',
      `3. Run the reproduction test and the repository's tests: \`${task.testCommand}\`.`,
      '',
      `When you finish, the runner checks the work itself, outside your session: \`${task.testCommand}\` must pass, and the reproduction test must pass with your change and fail when your changes outside its files are reverted. What you report is not taken as proof.`,
    ].join('\n'),
    '## Rules',
    NO_TAMPERING,
  ];
  if (input.failure) {
    sections.push(
      '## An earlier attempt failed',
      [
        `Another agent (${input.failure.vendor}) tried this task and it was taken from it: ${input.failure.reason}.`,
        `\`${dir}/failure_brief.json\` says what it tried and how the checks failed; its diff is \`${dir}/attempt-1.patch\`.`,
        'The workspace is back at the base commit. Use what it learned, but do not assume its approach was right.',
      ].join(' '),
    );
  }
  sections.push("## The conductor's brief", input.conductorBrief.trim());
  return `${sections.join('\n\n')}\n`;
}

/** What a resumed session is told after a failed run or a failed check. */
export function repairPrompt(failure: CheckProblem, testCommand: string): string {
  const lines = [`The runner checked your work and it failed: ${failure.problem}`];
  if (failure.output) lines.push('', 'End of the output:', '```', failure.output, '```');
  lines.push(
    '',
    `Fix it. Keep repro.json up to date, run the reproduction test and \`${testCommand}\` again, then stop. ${NO_TAMPERING}`,
  );
  return lines.join('\n');
}
