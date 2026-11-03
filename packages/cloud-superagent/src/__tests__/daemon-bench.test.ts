import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type DaemonBenchReport,
  formatDaemonBenchMarkdown,
  percentile,
  runDaemonBench,
  summarize,
} from '../daemon-bench.js';

test('percentile uses nearest rank and ignores input order', () => {
  const values = [50, 10, 40, 20, 30];
  assert.equal(percentile(values, 0), 10);
  assert.equal(percentile(values, 50), 30);
  assert.equal(percentile(values, 95), 50);
  assert.equal(percentile(values, 100), 50);
  assert.equal(percentile([7], 95), 7);
  assert.ok(Number.isNaN(percentile([], 50)));
  assert.deepEqual(values, [50, 10, 40, 20, 30]);
});

test('summarize reports count, bounds, mean and percentiles', () => {
  const stats = summarize([4, 2, 8, 6]);
  assert.deepEqual(stats, { n: 4, min: 2, p50: 4, p95: 8, max: 8, mean: 5 });
});

test('markdown report lists one row per mode and worker count', () => {
  const stats = summarize([1, 2, 3]);
  const report: DaemonBenchReport = {
    generatedAt: '2026-01-01T00:00:00.000Z',
    platform: 'linux',
    kernel: '6.0',
    arch: 'x64',
    node: 'v22.0.0',
    rssSource: 'proc',
    workerCounts: [2],
    reps: 3,
    rows: [
      {
        mode: 'shared',
        workers: 2,
        reps: 3,
        processes: 1,
        totalRssBytes: summarize([100 * 1024 * 1024]),
        rssPerWorkerBytes: summarize([50 * 1024 * 1024]),
        coldStartMs: stats,
        coldStartAllMs: stats,
        attachMs: stats,
        wakeMs: stats,
        wakeAfterReapMs: stats,
      },
      {
        mode: 'per-process',
        workers: 2,
        reps: 3,
        processes: 2,
        totalRssBytes: summarize([200 * 1024 * 1024]),
        rssPerWorkerBytes: summarize([100 * 1024 * 1024]),
        coldStartMs: stats,
        coldStartAllMs: stats,
        wakeMs: stats,
        wakeAfterReapMs: stats,
      },
    ],
  };
  const text = formatDaemonBenchMarkdown(report);
  assert.match(text, /\| shared \| 2 \| 1 \| 100\.0 \| 50\.0 \| 2\.0 \/ 3\.0 /);
  assert.match(text, /\| per-process \| 2 \| 2 \| 200\.0 \| 100\.0 /);
  assert.match(text, /n\/a/);
});

test('smoke run produces a report for both modes and writes json and md', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'daemon-bench-test-'));
  try {
    const report = await runDaemonBench({ workerCounts: [2], reps: 1, outDir });
    assert.equal(report.rows.length, 2);
    const shared = report.rows.find((row) => row.mode === 'shared');
    const perProcess = report.rows.find((row) => row.mode === 'per-process');
    assert.ok(shared && perProcess);
    assert.equal(shared.processes, 1);
    assert.equal(perProcess.processes, 2);
    for (const row of report.rows) {
      assert.equal(row.workers, 2);
      assert.equal(row.wakeMs.n, 2);
      assert.equal(row.wakeAfterReapMs.n, 2);
      assert.equal(row.totalRssBytes.n, 1);
      assert.ok(row.totalRssBytes.p50 > 0);
      assert.ok(row.coldStartMs.p50 > 0);
    }
    assert.equal(shared.attachMs?.n, 1);
    assert.equal(perProcess.attachMs, undefined);
    assert.equal(perProcess.coldStartMs.n, 2);

    const json = JSON.parse(await readFile(join(outDir, 'daemon-bench.json'), 'utf8'));
    assert.equal(json.rows.length, 2);
    assert.match(await readFile(join(outDir, 'daemon-bench.md'), 'utf8'), /Daemon bench/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
