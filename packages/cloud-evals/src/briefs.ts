import type { PublicTask } from './types.js';

const RULES = [
  'Do not commit, push, change git remotes or open pull requests: leave the change in the working tree, the harness takes it from there.',
  'Never look for, fetch or use hidden or held-out tests; only the repository and what you write count.',
].join(' ');

/** The brief of a vendor CLI run alone: the issue, the checkout and the rules, nothing more. */
export function aloneBrief(input: { task: PublicTask; baseSha: string; dir: string }): string {
  const { task, baseSha, dir } = input;
  return `${[
    '# Task',
    `Repository \`${task.repo}\`, checked out at commit \`${baseSha}\` in \`${dir}/workspace\`.`,
    '## Issue',
    task.statement.trim(),
    '## Rules',
    `Resolve the issue by changing the repository in \`${dir}/workspace\`. Set up whatever environment you need to run its tests yourself. ${RULES}`,
  ].join('\n\n')}\n`;
}

/**
 * The conductor's brief for the coding playbook: the `coding-task` block it needs, and the same
 * issue text the other subjects get, in full (the block's `goal` field is too short for it).
 */
export function playbookBrief(input: { task: PublicTask; testCommand: string }): string {
  const { task, testCommand } = input;
  const block = JSON.stringify({
    repo: task.repo,
    baseRef: task.baseCommit,
    testCommand,
    goal: 'Resolve the issue described under "Issue" below.',
  });
  return `${[
    '# Task',
    '```coding-task',
    block,
    '```',
    '## Issue',
    task.statement.trim(),
    '## Rules',
    `Set up whatever environment you need to run the repository's tests yourself. ${RULES}`,
  ].join('\n')}\n`;
}
