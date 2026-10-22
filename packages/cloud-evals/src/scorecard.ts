import { handsOff } from './proof.js';
import type { CellRow } from './report.js';

/**
 * The scorecard answers "can it work on its own yet, and did the last change help?". Per subject:
 * how often it resolves a task, how often it hands a change over with nothing left for the owner
 * (`handsOff`), and how often such a change is wrong anyway (false confidence: the proof said
 * done, the hidden tests say no). Against a baseline run: the tasks it now fixes and now breaks.
 */

/** Hands-off changes may merge without being read once this many were seen, at most this share wrong. */
export const AUTO_MERGE_BAR = { minHandsOff: 30, maxFalseConfidence: 0.05 } as const;

/** Below this two-sided sign-test p-value a difference against the baseline counts. */
const SIGNIFICANT = 0.05;

export interface SubjectScore {
  subjectId: string;
  /** Cells with a verdict. */
  cells: number;
  resolved: number;
  resolveRate: number | null;
  costPerResolvedUsd: number | null;
  medianMinutes: number | null;
  /** Null when the subject keeps no proof record (a vendor CLI alone). */
  handsOffRate: number | null;
  handsOff: number;
  /** Of the hands-off changes, the share the hidden tests reject. Null when there were none. */
  falseConfidence: number | null;
  /** Whether hands-off changes from this subject clear `AUTO_MERGE_BAR`. */
  autoMergeReady: boolean;
}

export interface SubjectComparison {
  subjectId: string;
  /** Task repetitions with a verdict in both runs. */
  paired: number;
  /** `task::repetition` keys resolved now and not in the baseline. */
  fixed: string[];
  /** Resolved in the baseline and not now. */
  broke: string[];
  /** Two-sided sign test over fixed against broke; null when nothing changed. */
  pValue: number | null;
  verdict: 'better' | 'worse' | 'no clear change' | 'no change';
  resolveRateDelta: number | null;
  costPerResolvedDeltaUsd: number | null;
  handsOffRateDelta: number | null;
  falseConfidenceDelta: number | null;
}

export interface Scorecard {
  experimentId: string;
  baselineId: string | null;
  mode: string;
  subjects: SubjectScore[];
  comparisons: SubjectComparison[];
}

const keyOf = (row: CellRow) => `${row.taskId}::${row.repetition}`;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

const round = (value: number | null, digits = 4): number | null =>
  value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits;

const delta = (now: number | null, before: number | null): number | null =>
  now === null || before === null ? null : round(now - before);

/** Two-sided exact binomial test at one half: how surprising `a` against `b` is if nothing changed. */
export function signTest(a: number, b: number): number | null {
  const n = a + b;
  if (n === 0) return null;
  const k = Math.min(a, b);
  // In logs: 0.5 ** n is zero past about a thousand pairs, and every term with it.
  const logs: number[] = [];
  let log = n * Math.log(0.5);
  for (let i = 0; i <= k; i += 1) {
    logs.push(log);
    log += Math.log(n - i) - Math.log(i + 1);
  }
  const top = Math.max(...logs);
  const tail = Math.exp(top) * logs.reduce((sum, value) => sum + Math.exp(value - top), 0);
  return Math.min(1, round(2 * tail, 6) as number);
}

function score(subjectId: string, rows: readonly CellRow[]): SubjectScore {
  const own = rows.filter((row) => row.subjectId === subjectId && row.resolved !== null);
  const resolved = own.filter((row) => row.resolved === true);
  const known = own.filter((row) => row.costUsd !== null);
  const cost = known.reduce((sum, row) => sum + (row.costUsd as number), 0);
  const keepsProof = own.some((row) => row.proof !== null);
  const off = own.filter((row) => handsOff(row.proof));
  const wrong = off.filter((row) => row.resolved === false).length;
  const falseConfidence = off.length === 0 ? null : wrong / off.length;
  return {
    subjectId,
    cells: own.length,
    resolved: resolved.length,
    resolveRate: own.length === 0 ? null : round(resolved.length / own.length),
    // One cell without a reported cost leaves the total unknown: it is never counted as zero.
    costPerResolvedUsd:
      resolved.length === 0 || known.length < own.length ? null : round(cost / resolved.length),
    medianMinutes: round(median(own.map((row) => row.durationMs / 60_000)), 1),
    handsOffRate: keepsProof && own.length > 0 ? round(off.length / own.length) : null,
    handsOff: off.length,
    falseConfidence: round(falseConfidence),
    autoMergeReady:
      off.length >= AUTO_MERGE_BAR.minHandsOff &&
      falseConfidence !== null &&
      falseConfidence <= AUTO_MERGE_BAR.maxFalseConfidence,
  };
}

function compare(
  subjectId: string,
  now: readonly CellRow[],
  before: readonly CellRow[],
): SubjectComparison {
  const verdicts = (rows: readonly CellRow[]) =>
    new Map(
      rows
        .filter((row) => row.subjectId === subjectId && row.resolved !== null)
        .map((row) => [keyOf(row), row]),
    );
  const a = verdicts(now);
  const b = verdicts(before);
  const shared = [...a.keys()].filter((key) => b.has(key)).sort();
  const fixed = shared.filter((key) => a.get(key)?.resolved && !b.get(key)?.resolved);
  const broke = shared.filter((key) => !a.get(key)?.resolved && b.get(key)?.resolved);
  const pValue = signTest(fixed.length, broke.length);
  const verdict =
    pValue === null
      ? 'no change'
      : pValue < SIGNIFICANT
        ? fixed.length > broke.length
          ? 'better'
          : 'worse'
        : 'no clear change';
  // The rates are over the shared tasks only, so a task that ran in one run alone moves nothing.
  const pick = (rows: Map<string, CellRow>) => shared.map((key) => rows.get(key) as CellRow);
  const s = score(subjectId, pick(a));
  const t = score(subjectId, pick(b));
  return {
    subjectId,
    paired: shared.length,
    fixed,
    broke,
    pValue,
    verdict,
    resolveRateDelta: delta(s.resolveRate, t.resolveRate),
    costPerResolvedDeltaUsd: delta(s.costPerResolvedUsd, t.costPerResolvedUsd),
    handsOffRateDelta: delta(s.handsOffRate, t.handsOffRate),
    falseConfidenceDelta: delta(s.falseConfidence, t.falseConfidence),
  };
}

export function buildScorecard(input: {
  experimentId: string;
  mode: string;
  subjectIds: readonly string[];
  rows: readonly CellRow[];
  baseline?: { experimentId: string; rows: readonly CellRow[] };
}): Scorecard {
  const { baseline } = input;
  return {
    experimentId: input.experimentId,
    baselineId: baseline?.experimentId ?? null,
    mode: input.mode,
    subjects: input.subjectIds.map((id) => score(id, input.rows)),
    comparisons: baseline
      ? input.subjectIds.map((id) => compare(id, input.rows, baseline.rows))
      : [],
  };
}

const pct = (rate: number | null) => (rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`);
const usd = (value: number | null) => (value === null ? 'n/a' : `$${value.toFixed(2)}`);
const minutes = (value: number | null) => (value === null ? 'n/a' : `${value.toFixed(1)} min`);
const signed = (value: number | null, show: (v: number) => string) =>
  value === null ? 'n/a' : `${value > 0 ? '+' : value < 0 ? '−' : '±'}${show(Math.abs(value))}`;
const points = (v: number) => `${(v * 100).toFixed(1)} pt`;
const dollars = (v: number) => `$${v.toFixed(2)}`;

export function renderScorecard(card: Scorecard): string {
  const lines = [`# Scorecard: ${card.experimentId}`, ''];
  if (card.mode === 'dry-run') {
    lines.push(
      '> **Synthetic dry run.** Fake subjects and a fake grader: this shows the scorecard works, not how any agent performs.',
      '',
    );
  }
  lines.push(
    '| Subject | Resolved | Hands-off | False confidence | Cost / resolved | Median time | Merge on its own? |',
    '|---|---|---|---|---|---|---|',
  );
  for (const s of card.subjects) {
    const merge =
      s.handsOffRate === null
        ? 'n/a'
        : s.autoMergeReady
          ? 'yes'
          : s.handsOff < AUTO_MERGE_BAR.minHandsOff
            ? `not yet (${s.handsOff} of ${AUTO_MERGE_BAR.minHandsOff} hands-off seen)`
            : 'no';
    lines.push(
      `| ${s.subjectId} | ${s.resolved} of ${s.cells} (${pct(s.resolveRate)}) | ${pct(s.handsOffRate)} | ${pct(s.falseConfidence)} | ${usd(s.costPerResolvedUsd)} | ${minutes(s.medianMinutes)} | ${merge} |`,
    );
  }
  if (card.baselineId !== null) {
    lines.push(
      '',
      `## Against ${card.baselineId}`,
      '',
      '| Subject | Verdict | Fixed | Broke | Resolve rate | Hands-off | False confidence | Cost / resolved |',
      '|---|---|---|---|---|---|---|---|',
    );
    for (const c of card.comparisons) {
      const p = c.pValue === null ? '' : ` (p ${c.pValue.toFixed(3)})`;
      lines.push(
        `| ${c.subjectId} | ${c.verdict}${p} | ${c.fixed.length} | ${c.broke.length} | ${signed(c.resolveRateDelta, points)} | ${signed(c.handsOffRateDelta, points)} | ${signed(c.falseConfidenceDelta, points)} | ${signed(c.costPerResolvedDeltaUsd, dollars)} |`,
      );
    }
    for (const c of card.comparisons) {
      if (c.broke.length > 0) {
        lines.push(
          '',
          `**${c.subjectId} now fails:** ${c.broke.map((key) => `\`${key}\``).join(', ')}`,
        );
      }
    }
  }
  lines.push(
    '',
    '## How to read this',
    '',
    '- **Hands-off**: the change was delivered with a reproduction test, a second agent’s review and no open P1, so nothing was left for the owner. Only the coding playbook keeps that record; a vendor CLI alone shows n/a.',
    '- **False confidence**: of the hands-off changes, the share the hidden tests reject. This is the number that decides whether a change can merge without being read. Lower is better.',
    `- **Merge on its own?** yes once at least ${AUTO_MERGE_BAR.minHandsOff} hands-off changes were seen and at most ${pct(AUTO_MERGE_BAR.maxFalseConfidence)} of them were wrong.`,
    `- **Verdict** against the baseline is a sign test on the tasks one run resolves and the other does not; under p ${SIGNIFICANT} it says better or worse, otherwise the difference may be noise. Deltas are over the tasks both runs have.`,
    '- Every subject counts its own cells with a verdict; `report.md` has the comparison across subjects on paired cells.',
    '',
  );
  return lines.join('\n');
}
