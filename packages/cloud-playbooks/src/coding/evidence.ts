import { scrubSecretText } from '@maka-cloud/orchestrator';
import { type ReviewSummary, SEVERITIES } from './review.js';
import { type ViewportRecord, viewportIssues } from './viewport.js';

/** The product's name as a pull request shows it. One place, so a rename is one edit. */
export const PRODUCT_NAME = 'Maka Cloud';

/** The runner's verification record (`verification.json`), as the pull request reads it. */
export interface VerificationView {
  testCommand: string;
  baseSha: string;
  repro?: { command: string; files: string[] };
  attempts: { vendor: string; end?: string }[];
  /** Set when the change is kept for the owner to look at, not delivered. */
  kept?: { reason: string };
  changedFiles?: { path: string; status: string }[];
  review?: ReviewSummary;
  viewport?: ViewportRecord;
}

/** What the host knows beyond the runner's record. Each is shown only when given. */
export interface ProofExtras {
  /** What the task spent, from the gateway's metering. */
  costUsd?: number;
  /** The task's budget. */
  budgetUsd?: number;
  /** The task's page in the owner's workspace: the steps, the review and the log. */
  runUrl?: string;
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

// Everything below comes from the runner's record of a repository anyone may have written (a test
// command, a path), and the description is posted on GitHub: a key in it would be public there.
// In a table cell a `|` would end the cell, so it is escaped too.
const code = (text: string) =>
  `\`${scrubSecretText(text).replaceAll('`', "'").replaceAll('|', '\\|')}\``;

const dollars = (usd: number) => `$${usd.toFixed(2)}`;

/** Only a plain https link is shown; anything else is left out rather than posted. */
function safeLink(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      ? scrubSecretText(parsed.toString())
      : undefined;
  } catch {
    return undefined;
  }
}

function reviewRow(verification: VerificationView): string {
  const review = verification.review;
  if (!review) return '❌ Not reviewed';
  const implementer = verification.attempts.at(-1)?.vendor;
  const other =
    review.status === 'reviewed' &&
    review.reviewer &&
    implementer &&
    review.reviewer !== implementer
      ? ' A different vendor wrote the change.'
      : '';
  if (review.status !== 'reviewed') return `❌ **${reviewHeading(review)}**`;
  const total = SEVERITIES.reduce((sum, severity) => sum + review.counts[severity], 0);
  return `${total === 0 ? '✅' : '⚠️'} **${reviewHeading(review)}**${other}`;
}

/** What the runner saw of the page; the screenshots themselves stay on the task page. */
function viewportRow(record: ViewportRecord | undefined): string | undefined {
  if (!record) return undefined;
  if (record.result === 'not_declared') return 'ℹ️ No screenshots: no page was named to look at';
  if (record.result === 'not_run')
    return `⚠️ Not looked at: ${code(record.reason ?? 'the check did not run')}`;
  const pages = record.pages ?? [];
  const paths = [...new Set(pages.map((page) => page.path))].map(code).join(', ');
  const before =
    record.before?.result === 'captured'
      ? ', with and without this change'
      : ', with this change only';
  const issues = viewportIssues(pages);
  return issues.length === 0
    ? `✅ ${paths} at 1280 and 390 px wide${before}: no horizontal overflow, console error or control under 44 px`
    : `⚠️ ${paths} at 1280 and 390 px wide${before}: ${issues.slice(0, 5).map(code).join('; ')}`;
}

/**
 * The pull request description: a proof table first (what the runner itself checked, the review,
 * the cost and the run), then the changed files and what was not verified. It is built from the
 * runner's own record, never from the agent's report, and carries the review's counts only: the
 * reviewer's words are about a repository anyone may have written, and stay on the task page.
 */
export function pullRequestBody(verification: VerificationView, extras: ProofExtras = {}): string {
  const rows: [string, string][] = [];
  if (verification.repro) {
    rows.push([
      `Reproduction test ${code(verification.repro.command)} (${verification.repro.files.map(code).join(', ')})`,
      `✅ Failed on the base commit \`${verification.baseSha.slice(0, 12)}\` with the rest of this change reverted, and passes with it`,
    ]);
  }
  rows.push([`Repository tests ${code(verification.testCommand)}`, '✅ Passed']);
  const viewport = viewportRow(verification.viewport);
  if (viewport) rows.push(["Desktop and phone (the runner's own screenshots)", viewport]);
  rows.push(['Independent review', reviewRow(verification)]);
  const fix = verification.review?.fix;
  if (fix && fix.sent > 0) {
    const sent = `${fix.sent} finding(s) sent back over ${fix.rounds} fix round(s)`;
    // The last round's fixed change may have passed the checks without its review finishing.
    const reviewedAgain = fix.history.at(-1)?.result !== 'not_reviewed';
    rows.push([
      'Fix after review',
      fix.result !== 'applied'
        ? `⚠️ ${sent}; no fix was used`
        : reviewedAgain
          ? `✅ ${sent}; this is the latest fixed change, checked and reviewed again`
          : `⚠️ ${sent}; this is the latest fixed change, checked but its review did not finish`,
    ]);
  }
  if (verification.attempts.length > 1) {
    const first = verification.attempts[0];
    rows.push([
      'Attempts',
      `A first attempt was dropped (${code(first?.end ?? 'it failed')}); this change is from the second`,
    ]);
  }
  if (extras.costUsd !== undefined) {
    rows.push([
      'Cost',
      extras.budgetUsd !== undefined
        ? `${dollars(extras.costUsd)} of a ${dollars(extras.budgetUsd)} budget`
        : dollars(extras.costUsd),
    ]);
  }
  const run = safeLink(extras.runUrl);
  if (run) rows.push(['Run', `[The steps, the review and the log](${run})`]);

  const lines = [
    ...(verification.kept
      ? [
          `**Kept for you to look at. Do not merge this before you have read the review.** ${code(verification.kept.reason)}`,
          '',
        ]
      : []),
    '### Proof',
    '',
    "Checked by the runner itself, not taken from the agent's report.",
    '',
    '| Check | Result |',
    '| --- | --- |',
    ...rows.map(([check, result]) => `| ${check} | ${result} |`),
  ];
  if (verification.changedFiles?.length) {
    lines.push(
      '',
      `<details><summary>Changed files (${verification.changedFiles.length})</summary>`,
      '',
      ...verification.changedFiles.map((file) => `- ${code(file.path)} (${file.status})`),
      '',
      '</details>',
    );
  }
  lines.push(
    '',
    "**Not verified**: anything those checks do not cover. This repository's own CI runs on this pull request now.",
    '',
    `<sub>Opened by ${PRODUCT_NAME} after you approved it.</sub>`,
  );
  return lines.join('\n');
}
