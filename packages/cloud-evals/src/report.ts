import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  expandExperiment,
  type AttemptStore,
  type ExperimentSpec,
  selectCellResult,
} from '@maka/eval';
import { type ProofSignals, proofFromArtifacts } from './proof.js';

export interface CellRow {
  cellId: string;
  taskId: string;
  subjectId: string;
  repetition: number;
  status: string;
  /** Null when the cell has no verdict (infrastructure failure that was not replaced). */
  resolved: boolean | null;
  costUsd: number | null;
  durationMs: number;
  failureReason: string | null;
  /** What the subject's own record said about its change; null when it kept none. */
  proof: ProofSignals | null;
}

export interface CurvePoint {
  costUsd: number;
  resolveRate: number;
}

export interface SubjectSummary {
  subjectId: string;
  /** Paired cells counted. */
  cells: number;
  resolved: number;
  resolveRate: number;
  meanCostUsd: number | null;
  totalCostUsd: number;
  costPerResolvedUsd: number | null;
  /** Cells of this subject without a reported cost. */
  costUnknown: number;
  onFrontier: boolean;
  /** Share of cells resolved within a dollar cap, one step per resolved cell. */
  curve: CurvePoint[];
}

export interface Summary {
  experimentId: string;
  suite: string;
  mode: string;
  subjects: SubjectSummary[];
  /** Cells that make up the comparison: every subject has a result for the task and repetition. */
  pairedCells: number;
  /** `task::repetition` keys left out because some subject has no result. */
  unmatched: string[];
  /** Cells with no selectable result at all. */
  missingCells: number;
}

export async function loadRows(spec: ExperimentSpec, store: AttemptStore): Promise<CellRow[]> {
  const rows: CellRow[] = [];
  for (const cell of expandExperiment(spec)) {
    const attempt = selectCellResult(await store.list(cell.id));
    if (!attempt) continue;
    const { result } = attempt;
    rows.push({
      cellId: cell.id,
      taskId: cell.task.id,
      subjectId: cell.subject.id,
      repetition: cell.repetition,
      status: result.status,
      resolved: result.score === null ? null : result.score >= 1,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      failureReason: result.failureReason,
      proof: proofFromArtifacts(result.artifacts),
    });
  }
  return rows;
}

const round = (value: number, digits = 6): number => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

export function summarize(spec: ExperimentSpec, rows: readonly CellRow[]): Summary {
  const subjectIds = spec.subjects.map((subject) => subject.id);
  const byKey = new Map<string, Map<string, CellRow>>();
  for (const row of rows) {
    const key = `${row.taskId}::${row.repetition}`;
    const group = byKey.get(key) ?? new Map<string, CellRow>();
    group.set(row.subjectId, row);
    byKey.set(key, group);
  }
  const paired: string[] = [];
  const unmatched: string[] = [];
  for (const task of spec.tasks) {
    for (let repetition = 1; repetition <= spec.repetitions; repetition += 1) {
      const key = `${task.id}::${repetition}`;
      const group = byKey.get(key);
      const complete =
        group !== undefined &&
        subjectIds.every((id) => {
          const row = group.get(id);
          return row !== undefined && row.resolved !== null;
        });
      (complete ? paired : unmatched).push(key);
    }
  }
  const pairedSet = new Set(paired);
  const total = spec.tasks.length * spec.repetitions * subjectIds.length;

  const subjects: SubjectSummary[] = subjectIds.map((subjectId) => {
    const own = rows.filter(
      (row) => row.subjectId === subjectId && pairedSet.has(`${row.taskId}::${row.repetition}`),
    );
    const resolved = own.filter((row) => row.resolved === true);
    const known = own.filter((row) => row.costUsd !== null);
    const totalCost = known.reduce((sum, row) => sum + (row.costUsd as number), 0);
    const distinct = [
      ...new Set(
        resolved.filter((row) => row.costUsd !== null).map((row) => row.costUsd as number),
      ),
    ].sort((a, b) => a - b);
    const curve: CurvePoint[] = [{ costUsd: 0, resolveRate: 0 }];
    for (const cap of distinct) {
      const within = resolved.filter((row) => row.costUsd !== null && row.costUsd <= cap).length;
      curve.push({ costUsd: round(cap), resolveRate: round(within / Math.max(own.length, 1)) });
    }
    return {
      subjectId,
      cells: own.length,
      resolved: resolved.length,
      resolveRate: own.length === 0 ? 0 : round(resolved.length / own.length),
      meanCostUsd: known.length === 0 ? null : round(totalCost / known.length),
      totalCostUsd: round(totalCost),
      costPerResolvedUsd:
        resolved.length === 0 || known.length < own.length
          ? null
          : round(totalCost / resolved.length),
      costUnknown: own.length - known.length,
      onFrontier: false,
      curve,
    };
  });
  const comparable = subjects.filter(
    (subject) => subject.meanCostUsd !== null && subject.cells > 0,
  );
  for (const subject of comparable) {
    subject.onFrontier = !comparable.some(
      (other) =>
        other !== subject &&
        (other.meanCostUsd as number) <= (subject.meanCostUsd as number) &&
        other.resolveRate >= subject.resolveRate &&
        ((other.meanCostUsd as number) < (subject.meanCostUsd as number) ||
          other.resolveRate > subject.resolveRate),
    );
  }
  return {
    experimentId: spec.id,
    suite: spec.benchmark.id,
    mode: String(spec.executor.config.mode ?? 'unknown'),
    subjects,
    pairedCells: paired.length * subjectIds.length,
    unmatched,
    missingCells: total - rows.length,
  };
}

// -- renderings ------------------------------------------------------------------------------------

const CSV_HEADER = 'task,repetition,subject,status,resolved,cost_usd,duration_ms,failure_reason';

function csvCell(value: string): string {
  return /[",\n\r]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}

export function renderCsv(rows: readonly CellRow[]): string {
  const sorted = [...rows].sort((a, b) =>
    a.taskId === b.taskId
      ? a.repetition - b.repetition || (a.subjectId < b.subjectId ? -1 : 1)
      : a.taskId < b.taskId
        ? -1
        : 1,
  );
  const lines = sorted.map((row) =>
    [
      row.taskId,
      String(row.repetition),
      row.subjectId,
      row.status,
      row.resolved === null ? '' : row.resolved ? '1' : '0',
      row.costUsd === null ? '' : String(row.costUsd),
      String(row.durationMs),
      row.failureReason ?? '',
    ]
      .map(csvCell)
      .join(','),
  );
  return `${[CSV_HEADER, ...lines].join('\n')}\n`;
}

const COLORS = ['#2a6fdb', '#d9691f', '#168a6a', '#8a4fd1', '#b8860b'];
const SHAPES = ['circle', 'square', 'triangle', 'diamond', 'circle'] as const;

function marker(
  shape: (typeof SHAPES)[number],
  x: number,
  y: number,
  color: string,
  ring: boolean,
) {
  const r = 6;
  let body: string;
  if (shape === 'circle') body = `<circle cx="${f(x)}" cy="${f(y)}" r="${r}" fill="${color}"/>`;
  else if (shape === 'square')
    body = `<rect x="${f(x - r)}" y="${f(y - r)}" width="${2 * r}" height="${2 * r}" fill="${color}"/>`;
  else if (shape === 'triangle')
    body = `<polygon points="${f(x)},${f(y - r - 1)} ${f(x + r + 1)},${f(y + r)} ${f(x - r - 1)},${f(y + r)}" fill="${color}"/>`;
  else
    body = `<polygon points="${f(x)},${f(y - r - 2)} ${f(x + r + 2)},${f(y)} ${f(x)},${f(y + r + 2)} ${f(x - r - 2)},${f(y)}" fill="${color}"/>`;
  return ring
    ? `${body}<circle cx="${f(x)}" cy="${f(y)}" r="${r + 5}" fill="none" stroke="${color}" stroke-width="2"/>`
    : body;
}

const f = (value: number): string => (Math.round(value * 100) / 100).toFixed(2);

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exponent = 10 ** Math.floor(Math.log10(value));
  const fraction = value / exponent;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * exponent;
}

/** Cost versus resolve rate: one step curve and one mean point per subject, frontier ringed. */
export function renderParetoSvg(summary: Summary): string {
  const width = 760;
  const height = 480;
  const left = 64;
  const right = 24;
  const top = 48;
  const bottom = 130;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const maxCost = niceMax(
    Math.max(
      0.01,
      ...summary.subjects.flatMap((subject) => [
        subject.meanCostUsd ?? 0,
        ...subject.curve.map((point) => point.costUsd),
      ]),
    ),
  );
  const x = (cost: number) => left + (cost / maxCost) * plotW;
  const y = (rate: number) => top + (1 - rate) * plotH;
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Cost versus resolve rate">`,
    '<style>',
    ':root{--bg:#ffffff;--fg:#1f2328;--muted:#6b7280;--grid:#d8dee4}',
    '@media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9aa4af;--grid:#30363d}}',
    'text{font:12px system-ui,sans-serif;fill:var(--fg)} .muted{fill:var(--muted)} .grid{stroke:var(--grid);stroke-width:1}',
    '</style>',
    `<rect width="${width}" height="${height}" fill="var(--bg)"/>`,
    `<text x="${left}" y="24" font-size="14" font-weight="600">Cost versus resolve rate${summary.mode === 'dry-run' ? ' (synthetic dry run)' : ''}</text>`,
  );
  for (let i = 0; i <= 5; i += 1) {
    const rate = i / 5;
    out.push(
      `<line class="grid" x1="${left}" x2="${left + plotW}" y1="${f(y(rate))}" y2="${f(y(rate))}"/>`,
      `<text class="muted" x="${left - 8}" y="${f(y(rate) + 4)}" text-anchor="end">${Math.round(rate * 100)}%</text>`,
    );
    const cost = (maxCost * i) / 5;
    out.push(
      `<line class="grid" x1="${f(x(cost))}" x2="${f(x(cost))}" y1="${top}" y2="${top + plotH}"/>`,
      `<text class="muted" x="${f(x(cost))}" y="${top + plotH + 18}" text-anchor="middle">$${cost < 10 ? cost.toFixed(2) : cost.toFixed(0)}</text>`,
    );
  }
  out.push(
    `<text class="muted" x="${left + plotW / 2}" y="${top + plotH + 38}" text-anchor="middle">cost per task (USD, as reported by the agent CLIs)</text>`,
    `<text class="muted" transform="translate(16 ${top + plotH / 2}) rotate(-90)" text-anchor="middle">tasks resolved</text>`,
  );
  summary.subjects.forEach((subject, index) => {
    const color = COLORS[index % COLORS.length] as string;
    const shape = SHAPES[index % SHAPES.length] as (typeof SHAPES)[number];
    const steps: string[] = [];
    let previousRate = 0;
    for (const point of subject.curve) {
      steps.push(
        `${f(x(point.costUsd))},${f(y(previousRate))}`,
        `${f(x(point.costUsd))},${f(y(point.resolveRate))}`,
      );
      previousRate = point.resolveRate;
    }
    steps.push(`${f(x(maxCost))},${f(y(previousRate))}`);
    out.push(
      `<polyline fill="none" stroke="${color}" stroke-width="2" stroke-opacity="0.55" points="${steps.join(' ')}"/>`,
    );
    if (subject.meanCostUsd !== null) {
      out.push(
        marker(shape, x(subject.meanCostUsd), y(subject.resolveRate), color, subject.onFrontier),
      );
    }
  });
  const legendTop = top + plotH + 58;
  summary.subjects.forEach((subject, index) => {
    const color = COLORS[index % COLORS.length] as string;
    const shape = SHAPES[index % SHAPES.length] as (typeof SHAPES)[number];
    const lx = left + index * 220;
    out.push(marker(shape, lx + 6, legendTop, color, false));
    out.push(
      `<text x="${lx + 20}" y="${legendTop + 4}">${escapeXml(subject.subjectId)}${subject.onFrontier ? ' (frontier)' : ''}</text>`,
      `<text class="muted" x="${lx + 20}" y="${legendTop + 20}">${pct(subject.resolveRate)} at ${usd(subject.meanCostUsd)} mean</text>`,
    );
  });
  out.push(
    `<text class="muted" x="${left}" y="${height - 14}">Line: share of tasks resolved within a dollar cap. Marker: the subject's mean cost and resolve rate; ringed = Pareto frontier.</text>`,
    '</svg>',
  );
  return `${out.join('\n')}\n`;
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"]/gu, (char) =>
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : '&quot;',
  );
}

const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;
const usd = (value: number | null): string => (value === null ? 'n/a' : `$${value.toFixed(2)}`);

export function renderMarkdown(summary: Summary): string {
  const lines: string[] = [`# Benchmark report: ${summary.experimentId}`, ''];
  if (summary.mode === 'dry-run') {
    lines.push(
      '> **Synthetic dry run.** These numbers come from fake subjects and a fake grader. They show that the harness works, not how any agent performs.',
      '',
    );
  }
  lines.push(
    `Suite: \`${summary.suite}\`. Cells compared: ${summary.pairedCells} (${summary.unmatched.length} task repetitions left out because a subject has no result; ${summary.missingCells} cells have no result at all).`,
    '',
    '| Subject | Cells | Resolved | Resolve rate | Mean cost / task | Cost / resolved | Cells without cost | Pareto frontier |',
    '|---|---|---|---|---|---|---|---|',
  );
  for (const s of summary.subjects) {
    lines.push(
      `| ${s.subjectId} | ${s.cells} | ${s.resolved} | ${pct(s.resolveRate)} | ${usd(s.meanCostUsd)} | ${usd(s.costPerResolvedUsd)} | ${s.costUnknown} | ${s.onFrontier ? 'yes' : 'no'} |`,
    );
  }
  lines.push('', '![Cost versus resolve rate](pareto.svg)', '', '## How to read this', '');
  lines.push(
    '- **Self-setup, not comparable to published numbers.** On SWE-bench the agents get the repository at the base commit and set up its environment themselves; there is no per-instance image in the sandbox. Absolute resolve rates therefore sit below published SWE-bench figures and must not be compared with them. The comparison between the subjects in this report is like for like: same issue text, same budget cap, same time limit, same way of taking the change out.',
    '- **Cost** is what the agent CLIs report through the runners, priced with the runners\' price table. It is not an invoice, and grading is not included. A cell whose run reported no cost is counted in "Cells without cost", never as zero, and is left out of the means.',
    "- **Curve.** A run stops when it reaches its budget and behaves the same below it, so the share of tasks resolved within a cap `c` is read off the one run: resolved cells whose cost is at most `c`, over all compared cells. This can be slightly off for the playbook, whose per-agent budget is what is left of the task's.",
    '- **Pairing.** Only task repetitions where every subject has a result are compared. Left out: ' +
      (summary.unmatched.length === 0
        ? 'none.'
        : summary.unmatched.map((key) => `\`${key}\``).join(', ') + '.'),
    '- **Residual contamination.** The agents can reach the public internet, where upstream fixes for these issues exist. The base commit is fetched alone with no history, but a determined search is not blocked.',
    "- **Visible tests.** The coding playbook is given an import smoke test as the repository's test command, not the repository's suite; its reproduction-test check is the real gate.",
    '',
  );
  return `${lines.join('\n')}`;
}

/** Writes `per-task.json`, `per-task.csv`, `summary.json`, `pareto.svg` and `report.md`. */
export async function writeReport(
  spec: ExperimentSpec,
  store: AttemptStore,
  outDir: string,
): Promise<Summary> {
  const rows = await loadRows(spec, store);
  const summary = summarize(spec, rows);
  await mkdir(outDir, { recursive: true });
  await Promise.all([
    writeFile(join(outDir, 'per-task.json'), `${JSON.stringify(rows, null, 2)}\n`),
    writeFile(join(outDir, 'per-task.csv'), renderCsv(rows)),
    writeFile(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`),
    writeFile(join(outDir, 'pareto.svg'), renderParetoSvg(summary)),
    writeFile(join(outDir, 'report.md'), renderMarkdown(summary)),
  ]);
  return summary;
}
