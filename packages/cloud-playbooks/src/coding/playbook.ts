import { type Manifest, type Playbook, type Verdict, verifyManifest } from '@maka-cloud/conductor';
import { OPEN_PULL_REQUEST_TOOL } from './pull-request.js';

export const CODING_RUNNER = 'coding';
export const CODING_ARTIFACTS = ['change.patch', 'changes.json', 'verification.json'] as const;

function artifactName(artifact: string): string {
  return artifact.split(/[\\/]/).pop() ?? artifact;
}

/**
 * The generic checks plus the coding ones: exactly one `verified:` line, which only the coding
 * runner writes after running the checks itself, and the delivery's artifacts.
 */
export function verifyCodingManifest(manifest: Manifest): Verdict {
  const problems = [...verifyManifest(manifest).problems];
  const verified = manifest.done.filter((line) => line.trim().startsWith('verified:'));
  if (verified.length !== 1) {
    problems.push(
      verified.length === 0
        ? 'the change was not verified by the coding runner'
        : 'done has more than one verified line',
    );
  }
  const names = new Set((manifest.artifacts ?? []).map(artifactName));
  const absent = CODING_ARTIFACTS.filter((name) => !names.has(name));
  if (absent.length > 0) problems.push(`artifacts do not list: ${absent.join(', ')}`);
  return { ok: problems.length === 0, problems };
}

const BLOCK_EXAMPLE = [
  '```coding-task',
  '{"repo": "owner/name", "baseRef": "main", "testCommand": "npm test", "goal": "..."}',
  '```',
].join('\n');

/** Replaces the T5 placeholder `coding` playbook. */
export const codingPlaybook: Playbook = {
  id: 'coding',
  description: 'Change code in a repository and deliver the change as a pull request.',
  allowedRunners: [CODING_RUNNER],
  planningInstructions: [
    "Name the GitHub repository as owner/name, the branch or commit to start from, and the repository's own test command (run from the repository root; find it in the README, package.json, Makefile or CI config).",
    'State the change in one or two sentences, the files likely involved, and the reproduction test to write first: a test that fails before the change and passes after it.',
    'Never plan to use hidden or held-out tests.',
  ].join(' '),
  steps: [
    `Delegate one task to the "${CODING_RUNNER}" runner. Its brief is the plan followed by one block:\n${BLOCK_EXAMPLE}\nAdd "runner": "codex" only if the user asked for it. One task per change: the runner already repairs and hands a failing task to the other agent once, so never start a second attempt yourself.`,
    'Wait for the task and read its verdict. A verified result lists the changed files and the checks the runner ran itself.',
    `If it is verified, call ${OPEN_PULL_REQUEST_TOOL} with the task id and a short title. It is held for approval: ask the user with ask_user (reason "irreversible") and the actionRef it returns, then call it again with that actionRef after they approve.`,
    'Deliver the pull request link and what was and was not verified. If the task was not verified, say what failed from its manifest and stop.',
  ],
  verify: verifyCodingManifest,
};
