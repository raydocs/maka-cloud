import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CellRow, renderCsv, renderMarkdown, renderParetoSvg, summarize } from '../report.js';
import { makeSpec } from '../spec-gen.js';
import type { PublicTask } from '../types.js';

const tasks: PublicTask[] = ['t1', 't2', 't3', 't4'].map((id) => ({
  id,
  suite: 'swe-bench-verified',
  repo: 'a/a',
  baseCommit: 'b'.repeat(40),
  statement: 'S',
  testCommand: null,
}));

const spec = makeSpec({
  suite: 'swe-bench-verified',
  tasks,
  benchmarkVersion: 'x',
  taskBudgetUsd: 5,
  totalBudgetUsd: 100,
  mode: 'live',
});

function row(
  taskId: string,
  subjectId: string,
  resolved: boolean | null,
  costUsd: number | null,
  status = 'completed',
): CellRow {
  return {
    cellId: `${taskId}::1::${subjectId}`,
    taskId,
    subjectId,
    repetition: 1,
    status,
    resolved,
    costUsd,
    durationMs: 1,
    failureReason: null,
  };
}

/** claude resolves 2 of 4 for ~1, codex 1 of 4 for ~0.5, playbook 3 of 4 for ~2. */
const FULL: CellRow[] = [
  row('t1', 'claude-agent-sdk', true, 1),
  row('t2', 'claude-agent-sdk', true, 1.5),
  row('t3', 'claude-agent-sdk', false, 0.5),
  row('t4', 'claude-agent-sdk', false, 1),
  row('t1', 'codex', true, 0.5),
  row('t2', 'codex', false, 0.5),
  row('t3', 'codex', false, 0.5),
  row('t4', 'codex', false, 0.5),
  row('t1', 'coding-playbook', true, 2),
  row('t2', 'coding-playbook', true, 2),
  row('t3', 'coding-playbook', true, 3),
  row('t4', 'coding-playbook', false, 1),
];

const by = (summary: ReturnType<typeof summarize>, id: string) => {
  const found = summary.subjects.find((s) => s.subjectId === id);
  assert.ok(found);
  return found;
};

test('resolve rate, mean cost and cost per resolved task per subject', () => {
  const summary = summarize(spec, FULL);
  assert.equal(summary.pairedCells, 12);
  assert.equal(summary.missingCells, 0);
  const claude = by(summary, 'claude-agent-sdk');
  assert.equal(claude.resolveRate, 0.5);
  assert.equal(claude.meanCostUsd, 1);
  assert.equal(claude.costPerResolvedUsd, 2);
  const playbook = by(summary, 'coding-playbook');
  assert.equal(playbook.resolveRate, 0.75);
  assert.equal(playbook.meanCostUsd, 2);
});

test('the curve is the share resolved within a cap: it only goes up, and ends at the resolve rate', () => {
  const summary = summarize(spec, FULL);
  for (const subject of summary.subjects) {
    for (let i = 1; i < subject.curve.length; i += 1) {
      const [a, b] = [subject.curve[i - 1], subject.curve[i]];
      assert.ok(a && b && b.costUsd > a.costUsd && b.resolveRate >= a.resolveRate);
    }
    assert.equal(subject.curve.at(-1)?.resolveRate, subject.resolveRate);
    assert.deepEqual(subject.curve[0], { costUsd: 0, resolveRate: 0 });
  }
  assert.deepEqual(by(summary, 'claude-agent-sdk').curve, [
    { costUsd: 0, resolveRate: 0 },
    { costUsd: 1, resolveRate: 0.25 },
    { costUsd: 1.5, resolveRate: 0.5 },
  ]);
});

test('the frontier holds the points nothing beats on both cost and resolve rate', () => {
  const summary = summarize(spec, FULL);
  // codex is cheapest, the playbook resolves most, claude (1.0, 0.5) beats neither: it is dominated by nothing
  // only if no one is both cheaper and better. Here codex is cheaper but worse, the playbook better but dearer.
  assert.deepEqual(
    summary.subjects.map((s) => [s.subjectId, s.onFrontier]),
    [
      ['claude-agent-sdk', true],
      ['codex', true],
      ['coding-playbook', true],
    ],
  );
  const dominated = summarize(spec, [
    ...FULL.filter((r) => r.subjectId !== 'claude-agent-sdk'),
    row('t1', 'claude-agent-sdk', false, 4),
    row('t2', 'claude-agent-sdk', false, 4),
    row('t3', 'claude-agent-sdk', false, 4),
    row('t4', 'claude-agent-sdk', false, 4),
  ]);
  assert.equal(by(dominated, 'claude-agent-sdk').onFrontier, false);
});

test('a task a subject has no result for is left out for all of them and listed', () => {
  const summary = summarize(
    spec,
    FULL.filter((r) => !(r.taskId === 't4' && r.subjectId === 'codex')),
  );
  assert.deepEqual(summary.unmatched, ['t4::1']);
  assert.equal(summary.pairedCells, 9);
  assert.equal(summary.missingCells, 1);
  assert.equal(by(summary, 'coding-playbook').cells, 3);
  assert.equal(by(summary, 'coding-playbook').resolved, 3);
});

test('a cell with no reported cost is counted apart, never as zero', () => {
  const rows = FULL.map((r) => (r.cellId === 't2::1::codex' ? { ...r, costUsd: null } : r));
  const codex = by(summarize(spec, rows), 'codex');
  assert.equal(codex.costUnknown, 1);
  assert.equal(codex.meanCostUsd, 0.5, 'the mean is over the three known costs');
  assert.equal(
    codex.costPerResolvedUsd,
    null,
    'a partial total is not turned into a per-task figure',
  );
  const allUnknown = summarize(
    spec,
    rows.map((r) => (r.subjectId === 'codex' ? { ...r, costUsd: null } : r)),
  );
  assert.equal(by(allUnknown, 'codex').meanCostUsd, null);
  assert.equal(by(allUnknown, 'codex').onFrontier, false);
});

test('csv quotes what needs it and is sorted', () => {
  const csv = renderCsv([
    {
      ...row('t2', 'codex', false, null, 'subject_failed'),
      failureReason: 'said "no", then\nstopped',
    },
    row('t1', 'codex', true, 0.5),
  ]);
  const lines = csv.split('\n');
  assert.equal(
    lines[0],
    'task,repetition,subject,status,resolved,cost_usd,duration_ms,failure_reason',
  );
  assert.equal(lines[1], 't1,1,codex,completed,1,0.5,1,');
  assert.ok(csv.includes('"said ""no"", then\nstopped"'));
});

test('the chart is deterministic, names every subject and has no broken numbers', () => {
  const summary = summarize(spec, FULL);
  const svg = renderParetoSvg(summary);
  assert.equal(svg, renderParetoSvg(summary));
  assert.ok(svg.startsWith('<svg '));
  assert.ok(svg.trimEnd().endsWith('</svg>'));
  for (const id of ['claude-agent-sdk', 'codex', 'coding-playbook']) assert.ok(svg.includes(id));
  assert.ok(!/NaN|undefined|Infinity/u.test(svg));
  assert.equal((svg.match(/<text/gu) ?? []).length, (svg.match(/<\/text>/gu) ?? []).length);
  assert.ok(svg.includes('prefers-color-scheme: dark'));
});

test('the report says what the numbers are and are not', () => {
  const live = renderMarkdown(summarize(spec, FULL));
  assert.match(live, /Self-setup, not comparable to published numbers/u);
  assert.match(live, /not an invoice/u);
  assert.ok(!live.includes('Synthetic dry run'));
  const dry = renderMarkdown(
    summarize(
      makeSpec({
        suite: 'swe-bench-verified',
        tasks,
        benchmarkVersion: 'x',
        taskBudgetUsd: 5,
        totalBudgetUsd: 100,
        mode: 'dry-run',
      }),
      FULL,
    ),
  );
  assert.match(dry, /Synthetic dry run/u);
  assert.match(dry, /Self-setup, not comparable to published numbers/u);
});
