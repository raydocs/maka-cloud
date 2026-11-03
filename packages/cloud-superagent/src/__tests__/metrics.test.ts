import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { formatMetricsMarkdown, runMetrics } from '../metrics.js';

test('metrics harness runs N fake loops in parallel and writes JSON plus markdown', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'maka-metrics-'));
  let clock = 1_000;
  const report = await runMetrics({
    n: 3,
    parallel: 2,
    outDir,
    now: () => {
      clock += 50;
      return clock;
    },
  });
  assert.equal(report.n, 3);
  assert.equal(report.success, 3);
  assert.equal(report.successRate, 1);
  assert.ok(report.timeToGreenMs.mean > 0);
  assert.equal(report.wastedRouterWakeups, 3);
  assert.ok(report.usdPerPr > 0);
  assert.equal(report.humanInterventions, 0);
  const json = JSON.parse(await readFile(join(outDir, 'metrics.json'), 'utf8')) as { n: number };
  assert.equal(json.n, 3);
  const md = await readFile(join(outDir, 'metrics.md'), 'utf8');
  assert.match(md, /success rate/);
  assert.match(formatMetricsMarkdown(report), /wasted Router wakeups/);
});
