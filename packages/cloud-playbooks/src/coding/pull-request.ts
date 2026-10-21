import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type ConductorToolSpec, shownValue, ToolRefusal } from '@maka-cloud/conductor';
import { z } from 'zod';
import type { ChangeSet, CodingDeliveries, Delivery, PublishedPullRequest } from './deliveries.js';
import type { PullRequestPublisher } from './github.js';
import { type ReviewSummary, SEVERITIES } from './review.js';

export const OPEN_PULL_REQUEST_TOOL = 'open_pull_request';

export interface PullRequestToolOptions {
  deliveries: CodingDeliveries;
  publisher: PullRequestPublisher;
  /**
   * Whether the run delegated the task. Wire it to the conductor's state:
   * `(runId, taskId) => conductor.state.tasksOf(runId).includes(taskId)`.
   */
  ownsTask(runId: string, taskId: string): boolean;
}

const parameters = z.object({
  taskId: z.string().min(1).max(100).describe('The coding task whose verified change to deliver'),
  title: z.string().trim().min(1).max(200).describe('The pull request title'),
});

type Args = z.infer<typeof parameters>;

/** The branch a task's change goes to. */
export function branchFor(taskId: string): string {
  return `maka/${taskId}`;
}

/**
 * `open_pull_request`: an irreversible conductor tool, so the T5 gate holds every call until the
 * user approves it, on a card that shows the repository, branch and title. It delivers only a
 * change the coding runner verified, for a task this run delegated, and opens at most one pull
 * request per task.
 */
export function openPullRequestTool(
  options: PullRequestToolOptions,
): ConductorToolSpec<typeof parameters> {
  const inFlight = new Map<string, Promise<PublishedPullRequest>>();

  const publish = async (delivery: Delivery, title: string, signal: AbortSignal) => {
    const changes = await readFile(delivery.changesPath, 'utf8');
    if (createHash('sha256').update(changes).digest('hex') !== delivery.changesSha256) {
      throw new ToolRefusal(
        'change_modified',
        `The verified change of ${delivery.taskId} was modified after it was verified; nothing was opened.`,
      );
    }
    const changeSet = JSON.parse(changes) as ChangeSet;
    const verification = JSON.parse(
      await readFile(delivery.verificationPath, 'utf8'),
    ) as VerificationView;
    const pr = await options.publisher.publish(
      {
        changeSet,
        branch: branchFor(delivery.taskId),
        baseRef: delivery.baseRef,
        title,
        body: pullRequestBody(verification),
      },
      signal,
    );
    await options.deliveries.markPublished(delivery.taskId, pr);
    return pr;
  };

  return {
    name: OPEN_PULL_REQUEST_TOOL,
    description:
      'Open a pull request with the verified change of a finished coding task. Only after the coding task is finished and verified.',
    parameters,
    irreversible: true,
    effects: ['writes_outside_sandbox', 'irreversible'],
    // A standing duty may open pull requests from `open-pr` upwards, never at `read-only`.
    requiresAuthority: 'open-pr',
    // The pull request GitHub opened and the repository, built by code.
    externalResult: false,
    async approvalDetails(args: Args) {
      const delivery = await options.deliveries.get(args.taskId);
      const lines = [
        `Repository: ${delivery?.repo ?? 'unknown (no verified change for this task)'}`,
        `Branch: ${branchFor(args.taskId)}`,
        // The model wrote the title: shown quoted, a line break or a hidden character as an escape (T15).
        `Title: ${shownValue(args.title)}`,
      ];
      const problem = options.publisher.precheck();
      if (problem) lines.push(`This cannot be opened yet: ${problem}`);
      return lines.join('\n');
    },
    async impl(args, context) {
      if (!options.ownsTask(context.runId, args.taskId)) {
        throw new ToolRefusal(
          'not_your_task',
          `Task ${args.taskId} was not delegated by this run.`,
        );
      }
      const delivery = await options.deliveries.get(args.taskId);
      if (!delivery) {
        throw new ToolRefusal(
          'not_verified',
          `Task ${args.taskId} has no verified change to deliver.`,
        );
      }
      if (delivery.publishedPr) return { ...delivery.publishedPr, alreadyOpen: true };
      const problem = options.publisher.precheck();
      if (problem) throw new ToolRefusal('github_token', problem);
      let pending = inFlight.get(args.taskId);
      if (!pending) {
        pending = publish(delivery, args.title, context.signal).finally(() =>
          inFlight.delete(args.taskId),
        );
        inFlight.set(args.taskId, pending);
      }
      return { ...(await pending), repo: delivery.repo };
    },
  };
}

interface VerificationView {
  testCommand: string;
  baseSha: string;
  repro?: { command: string; files: string[] };
  attempts: { vendor: string; end?: string }[];
  changedFiles?: { path: string; status: string }[];
  review?: ReviewSummary;
}

function reviewHeading(review: ReviewSummary): string {
  if (review.status !== 'reviewed') return 'Not reviewed by a second agent';
  const total = SEVERITIES.reduce((sum, severity) => sum + review.counts[severity], 0);
  if (total === 0) return 'Reviewed by a second agent: no findings';
  const parts = SEVERITIES.filter((severity) => review.counts[severity] > 0).map(
    (severity) => `${severity} ${review.counts[severity]}`,
  );
  return `Reviewed by a second agent: ${total} finding(s) remain (${parts.join(', ')}). They are on the task page.`;
}

const code = (text: string) => `\`${text.replaceAll('`', "'")}\``;

/** The pull request description, built from the runner's verification record. */
export function pullRequestBody(verification: VerificationView): string {
  const lines = [
    'Opened by the Maka Cloud coding runner after the user approved it.',
    '',
    "**Checked by the runner itself** (not taken from the agent's report):",
    `- ${code(verification.testCommand)} passed.`,
  ];
  if (verification.repro) {
    lines.push(
      `- The reproduction test ${code(verification.repro.command)} (${verification.repro.files.map(code).join(', ')}) failed on the base commit ${verification.baseSha.slice(0, 12)} with the rest of this change reverted, and passes with it.`,
    );
  }
  if (verification.attempts.length > 1) {
    const first = verification.attempts[0];
    lines.push(
      `- A first attempt was dropped (${first?.end ?? 'it failed'}); this change is from the second.`,
    );
  }
  if (verification.changedFiles?.length) {
    lines.push(
      '',
      '**Changed files**',
      ...verification.changedFiles.map((file) => `- ${code(file.path)} (${file.status})`),
    );
  }
  // Counts only: the findings are the reviewer's words about a repository anyone may have written,
  // and they stay on the task page (review.md), not in a pull request.
  if (verification.review) lines.push('', `**${reviewHeading(verification.review)}**`);
  lines.push(
    '',
    "**Not verified**: anything those two commands do not cover. This repository's own CI runs on this pull request now.",
  );
  return lines.join('\n');
}
