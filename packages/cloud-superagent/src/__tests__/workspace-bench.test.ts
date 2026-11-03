import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatWorkspaceBenchTable,
  percentile,
  runWorkspaceBench,
  summarize,
} from '../workspace-bench.js';

test('percentile uses nearest rank and summarize reports the bounds', () => {
  assert.equal(percentile([50, 10, 40, 20, 30], 50), 30);
  assert.equal(percentile([50, 10, 40, 20, 30], 95), 50);
  assert.ok(Number.isNaN(percentile([], 50)));
  assert.deepEqual(summarize([4, 2, 8, 6]), { n: 4, min: 2, p50: 4, p95: 8, max: 8, mean: 5 });
});

test('workspace bench report has one row per mode and assignment count', async () => {
  const report = await runWorkspaceBench({
    assignmentCounts: [1, 2],
    reps: 1,
    files: 40,
    overlay: 'off',
  });
  assert.equal(report.rows.length, 4);
  assert.deepEqual(
    report.rows.map((row) => `${row.mode}:${row.assignments}`),
    ['clone:1', 'clone:2', 'layered:1', 'layered:2'],
  );
  for (const row of report.rows) {
    assert.equal(row.startMs.n, row.assignments * report.reps);
    assert.equal(Number.isFinite(row.startMs.p50), true);
    assert.equal(Number.isFinite(row.startMs.p95), true);
    assert.equal(row.diskTotalKb > 0, true);
    assert.equal(row.diskPerAssignmentKb > 0, true);
    assert.equal(row.peakRssKb > 0, true);
    assert.equal(['time', 'self'].includes(row.rssSource), true);
  }
  const layered = report.rows.filter((row) => row.mode === 'layered');
  for (const row of layered) {
    assert.equal(row.layer, 'clone-shared');
    assert.equal(row.baseBuildMs.n, report.reps);
  }
  assert.equal(report.fixture.files >= 40, true);
  const table = formatWorkspaceBenchTable(report);
  assert.equal(table.includes('| layered | 2 |'), true);
});
