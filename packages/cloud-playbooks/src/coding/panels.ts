import { cleanTail, MAX_PANEL_TAIL_LINES, type TaskPanel } from '@maka-cloud/orchestrator';
import type { Finding, ReviewRecord } from './review.js';

/**
 * The panels a coding task shows while it works. Every summary is built here from a check's own
 * result (its exit status and the counts its output ends with), from the change as git listed it,
 * or from the review's counts. No model writes one, and the orchestrator accepts only the fixed
 * shapes that these produce (`cleanPanel`). A panel is a reader copy: the proof of the task stays
 * `verification.json`.
 */

/** The part of a check's result a panel reads. */
export interface PanelCheck {
  exitCode: number;
  timedOut?: boolean;
  output: string;
}

const COUNT_LIMIT = 999_999;

// node:test prints `# pass 41`; jest, vitest, pytest and mocha print `41 passed`, `1 failed`, `41 passing`.
const PASSED = /^#\s*pass\s+(\d+)\s*$|(?:^|[\s=,|:])(\d+)\s+(?:passed|passing)\b/gimu;
const FAILED = /^#\s*fail\s+(\d+)\s*$|(?:^|[\s=,|:])(\d+)\s+(?:failed|failing)\b/gimu;

/** Counts from the runner's summary lines (`# pass 41`, `41 passed`, `1 failing`), when it prints them. */
function counts(output: string): { passed?: number; failed?: number } {
  const read = (pattern: RegExp): number | undefined => {
    let found: number | undefined;
    for (const match of output.matchAll(pattern)) {
      const value = Number(match[1] ?? match[2]);
      if (Number.isSafeInteger(value) && value <= COUNT_LIMIT) found = value;
    }
    return found;
  };
  const passed = read(PASSED);
  const failed = read(FAILED);
  return {
    ...(passed === undefined ? {} : { passed }),
    ...(failed === undefined ? {} : { failed }),
  };
}

/**
 * How a check ended, in one of the fixed shapes of a `tests` panel. The verdict is the exit status
 * the sandbox reported. The counts are the totals the check printed, which a test that the agent
 * wrote could print as it likes, so a run of those passes `counts: false` and shows the verdict only.
 */
export function testsSummary(
  check: PanelCheck,
  shows: { counts: boolean } = { counts: true },
): string {
  if (check.timedOut) return 'timed out';
  if (check.exitCode < 0 || check.exitCode >= 125) return 'could not run';
  const { passed, failed } = shows.counts ? counts(check.output) : {};
  if (check.exitCode === 0)
    return passed === undefined || passed === 0 ? 'passed' : `${passed} passed`;
  if (passed !== undefined && failed !== undefined && failed > 0) {
    return `${passed} passed, ${failed} failed`;
  }
  if (failed !== undefined && failed > 0) return `${failed} failed`;
  return `failed (exit ${check.exitCode})`;
}

export function runningPanel(panelId: string, kind: TaskPanel['kind'], title: string): TaskPanel {
  return { panelId, kind, state: 'running', title, summary: 'running' };
}

/**
 * A test run that has ended. `expect` says what the run was for: `pass` for a run that must pass,
 * `fail` for the reproduction test on the base, which shows the problem by failing. The panel's
 * state says whether the run did its job; its summary says what happened.
 */
export function testsPanel(
  panelId: string,
  title: string,
  check: PanelCheck,
  options: { expect?: 'pass' | 'fail'; counts?: boolean } = {},
): TaskPanel {
  const expect = options.expect ?? 'pass';
  const passed = !check.timedOut && check.exitCode === 0;
  // Only a failure of the test itself shows the problem, not a crash or a timeout.
  const failedItself = !check.timedOut && check.exitCode > 0 && check.exitCode < 125;
  const ok = expect === 'pass' ? passed : failedItself;
  const tail = cleanTail(check.output);
  return {
    panelId,
    kind: 'tests',
    state: ok ? 'passed' : 'failed',
    title,
    summary: testsSummary(check, { counts: options.counts ?? true }),
    ...(tail === '' ? {} : { tail }),
  };
}

/** The change as git listed it: its files, and its lines when the patch is whole. */
export function diffPanel(
  files: ReadonlyArray<{ path: string; status: string }>,
  patch: string,
): TaskPanel {
  const n = files.length;
  let summary = n === 0 ? 'no changes' : `${n} file${n === 1 ? '' : 's'}`;
  // A patch cut at its size limit has lost lines: only the files are counted then.
  if (n > 0 && !/\n\[change\.patch cut at /u.test(patch)) {
    let added = 0;
    let removed = 0;
    for (const line of patch.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    summary = `+${added} −${removed} in ${n} file${n === 1 ? '' : 's'}`;
  }
  const mark: Record<string, string> = { added: 'A', modified: 'M', deleted: 'D' };
  return {
    panelId: 'diff',
    kind: 'diff',
    state: 'passed',
    title: 'Change',
    summary,
    tail: cleanTail(
      files
        .slice(0, MAX_PANEL_TAIL_LINES)
        .map((file) => `${mark[file.status] ?? 'M'} ${file.path}`)
        .join('\n'),
    ),
  };
}

const findingLine = (finding: Finding): string =>
  `${finding.severity} ${finding.path === undefined ? '' : `${finding.path}${finding.line === undefined ? '' : `:${finding.line}`} `}${finding.title}`;

/** What a review found, from its counts. A review that could not be made is `stopped`, not `passed`. */
export function reviewPanel(review: ReviewRecord): TaskPanel {
  if (review.status !== 'reviewed') {
    return {
      panelId: 'review',
      kind: 'review',
      state: 'stopped',
      title: 'Second review',
      summary: 'not available',
    };
  }
  const count = (severity: Finding['severity']) =>
    review.findings.filter((finding) => finding.severity === severity).length;
  const p1 = count('P1');
  return {
    panelId: 'review',
    kind: 'review',
    state: p1 === 0 ? 'passed' : 'failed',
    title: 'Second review',
    summary: `${p1} P1, ${count('P2')} P2, ${count('P3')} P3`,
    ...(review.findings.length === 0
      ? {}
      : {
          tail: cleanTail(
            review.findings.slice(0, MAX_PANEL_TAIL_LINES).map(findingLine).join('\n'),
          ),
        }),
  };
}
