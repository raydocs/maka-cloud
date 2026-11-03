import { type ChildProcess, execFileSync, fork } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVmRss } from './box-daemon.js';
import type { BenchChildReply, BenchChildRequest } from './daemon-bench-child.js';

/**
 * Compares one process hosting N workers (`BoxDaemon` sessions) with one
 * process per worker. Each worker does the same unit of work per wake: one
 * `exec` through a `DaemonBox` backed by `FakeSandbox`, i.e. the path a worker
 * tool call takes. It is not a model turn.
 */

export type DaemonBenchMode = 'shared' | 'per-process';
type RssSource = 'proc' | 'ps';

export interface Stats {
  n: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

export interface DaemonBenchRow {
  mode: DaemonBenchMode;
  workers: number;
  reps: number;
  /** Processes alive while memory is sampled (1 for shared, N for per-process). */
  processes: number;
  totalRssBytes: Stats;
  rssPerWorkerBytes: Stats;
  /** Spawn -> child reports ready. Per-process: one sample per process. */
  coldStartMs: Stats;
  /** Spawn of the first process -> every process ready. */
  coldStartAllMs: Stats;
  /** Shared only: attach of one extra worker in an already-running daemon. */
  attachMs?: Stats;
  /** Wake message -> first exec result, process alive and worker idle. */
  wakeMs: Stats;
  /**
   * Worker was reaped while asleep. Per-process: stop, respawn, wake (spawn ->
   * first exec result). Shared: detach, attach, wake inside the live daemon.
   */
  wakeAfterReapMs: Stats;
}

export interface DaemonBenchReport {
  generatedAt: string;
  platform: string;
  kernel: string;
  arch: string;
  node: string;
  rssSource: RssSource;
  workerCounts: number[];
  reps: number;
  rows: DaemonBenchRow[];
}

export interface DaemonBenchOptions {
  workerCounts?: number[];
  reps?: number;
  outDir?: string;
  /** Overrides the compiled child entry (tests only). */
  childPath?: string;
}

export const DEFAULT_WORKER_COUNTS = [1, 4, 8, 16];
export const DEFAULT_REPS = 5;

/** Nearest-rank percentile of an unsorted sample; `p` in [0, 100]. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)] ?? Number.NaN;
}

export function summarize(values: readonly number[]): Stats {
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    n: values.length,
    min: percentile(values, 0),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: percentile(values, 100),
    mean: values.length === 0 ? Number.NaN : sum / values.length,
  };
}

export function formatDaemonBenchMarkdown(report: DaemonBenchReport): string {
  const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);
  const ms = (value: number): string => (Number.isFinite(value) ? value.toFixed(1) : 'n/a');
  const pair = (stats: Stats | undefined): string =>
    stats ? `${ms(stats.p50)} / ${ms(stats.p95)}` : 'n/a';
  const lines = [
    '# Daemon bench: shared process vs one process per worker',
    '',
    `- generated: ${report.generatedAt}`,
    `- platform: ${report.platform} ${report.kernel} (${report.arch}), node ${report.node}`,
    `- RSS source: ${report.rssSource === 'proc' ? '/proc/<pid>/status VmRSS' : 'ps -o rss (not Linux)'}`,
    `- repetitions: ${report.reps}; times are ms, p50 / p95`,
    '',
    '| mode | N | procs | total RSS MiB (p50) | RSS/worker MiB (p50) | cold start | cold start, all ready | attach extra | wake | wake after reap |',
    '|---|---:|---:|---:|---:|---|---|---|---|---|',
  ];
  for (const row of report.rows) {
    lines.push(
      `| ${row.mode} | ${row.workers} | ${row.processes} | ${mib(row.totalRssBytes.p50)} | ${mib(
        row.rssPerWorkerBytes.p50,
      )} | ${pair(row.coldStartMs)} | ${pair(row.coldStartAllMs)} | ${pair(row.attachMs)} | ${pair(
        row.wakeMs,
      )} | ${pair(row.wakeAfterReapMs)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** VmRSS in bytes: `/proc` on Linux, `ps` elsewhere. */
export function sampleRss(pid: number): { bytes: number; source: RssSource } | undefined {
  const proc = readVmRss(pid);
  if (proc !== undefined) return { bytes: proc, source: 'proc' };
  try {
    const kib = Number(
      execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim(),
    );
    return Number.isFinite(kib) && kib > 0 ? { bytes: kib * 1024, source: 'ps' } : undefined;
  } catch {
    return undefined;
  }
}

class BenchChild {
  private constructor(
    readonly proc: ChildProcess,
    readonly readyMs: number,
  ) {}

  /** Resolves when the child reports ready. `readyMs` is spawn -> ready. */
  static async spawn(childPath: string, workerIds: string[]): Promise<BenchChild> {
    const started = performance.now();
    const proc = fork(childPath, workerIds, { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    await new Promise<void>((resolve, reject) => {
      const onMessage = (message: BenchChildReply): void => {
        if (message.type !== 'ready') return;
        proc.off('message', onMessage);
        resolve();
      };
      proc.on('message', onMessage);
      proc.once('error', reject);
      proc.once('exit', (code) => reject(new Error(`bench child exited early (${code})`)));
    });
    return new BenchChild(proc, performance.now() - started);
  }

  get pid(): number {
    if (this.proc.pid === undefined) throw new Error('bench child has no pid');
    return this.proc.pid;
  }

  request<T extends BenchChildReply['type']>(
    message: BenchChildRequest,
    expect: T,
  ): Promise<Extract<BenchChildReply, { type: T }>> {
    return new Promise((resolve, reject) => {
      const onMessage = (reply: BenchChildReply): void => {
        if (reply.type !== expect) return;
        this.proc.off('message', onMessage);
        resolve(reply as Extract<BenchChildReply, { type: T }>);
      };
      this.proc.on('message', onMessage);
      this.proc.send(message, (error) => {
        if (error) reject(error);
      });
    });
  }

  async wake(workerId: string): Promise<number> {
    const started = performance.now();
    const reply = await this.request({ type: 'wake', workerId }, 'woke');
    const elapsed = performance.now() - started;
    if (reply.exitCode !== 0 || reply.stdout !== 'wake') {
      throw new Error(`bench worker ${workerId} failed: exit ${reply.exitCode}`);
    }
    return elapsed;
  }

  async stop(): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.proc.once('exit', () => resolve()));
    this.proc.send({ type: 'exit' } satisfies BenchChildRequest);
    await exited;
  }
}

interface RepSamples {
  totalRss: number[];
  rssPerWorker: number[];
  coldStart: number[];
  coldStartAll: number[];
  attach: number[];
  wake: number[];
  wakeAfterReap: number[];
}

const emptySamples = (): RepSamples => ({
  totalRss: [],
  rssPerWorker: [],
  coldStart: [],
  coldStartAll: [],
  attach: [],
  wake: [],
  wakeAfterReap: [],
});

function sumRss(children: BenchChild[], sources: Set<RssSource>): number {
  let total = 0;
  for (const child of children) {
    const sample = sampleRss(child.pid);
    if (!sample) throw new Error(`could not read RSS of pid ${child.pid}`);
    sources.add(sample.source);
    total += sample.bytes;
  }
  return total;
}

const workerName = (index: number): string => `wrk_${index}`;

async function sharedRep(
  childPath: string,
  workers: number,
  out: RepSamples,
  sources: Set<RssSource>,
): Promise<void> {
  const ids = Array.from({ length: workers }, (_, i) => workerName(i));
  const daemon = await BenchChild.spawn(childPath, ids);
  out.coldStart.push(daemon.readyMs);
  out.coldStartAll.push(daemon.readyMs);
  try {
    // Every worker sleeps until its wake message; wake them one at a time.
    for (const id of ids) out.wake.push(await daemon.wake(id));
    const total = sumRss([daemon], sources);
    out.totalRss.push(total);
    out.rssPerWorker.push(total / workers);

    const attachStarted = performance.now();
    await daemon.request({ type: 'attach', workerId: 'wrk_extra' }, 'attached');
    out.attach.push(performance.now() - attachStarted);
    await daemon.request({ type: 'detach', workerId: 'wrk_extra' }, 'detached');

    // Reaped while asleep: the session goes away, the daemon stays.
    for (const id of ids) {
      await daemon.request({ type: 'detach', workerId: id }, 'detached');
      const started = performance.now();
      await daemon.request({ type: 'attach', workerId: id }, 'attached');
      await daemon.wake(id);
      out.wakeAfterReap.push(performance.now() - started);
    }
  } finally {
    await daemon.stop();
  }
}

async function perProcessRep(
  childPath: string,
  workers: number,
  out: RepSamples,
  sources: Set<RssSource>,
): Promise<void> {
  const ids = Array.from({ length: workers }, (_, i) => workerName(i));
  const children: BenchChild[] = [];
  try {
    const allStarted = performance.now();
    children.push(...(await Promise.all(ids.map((id) => BenchChild.spawn(childPath, [id])))));
    out.coldStartAll.push(performance.now() - allStarted);
    for (const child of children) out.coldStart.push(child.readyMs);

    for (const [i, child] of children.entries()) {
      out.wake.push(await child.wake(workerName(i)));
    }
    const total = sumRss(children, sources);
    out.totalRss.push(total);
    out.rssPerWorker.push(total / workers);

    // Reaped while asleep: stop the process, then spawn and wake it again.
    for (const [i, child] of children.entries()) {
      await child.stop();
      const started = performance.now();
      const fresh = await BenchChild.spawn(childPath, [workerName(i)]);
      children[i] = fresh;
      await fresh.wake(workerName(i));
      out.wakeAfterReap.push(performance.now() - started);
    }
  } finally {
    await Promise.all(children.map((child) => child.stop().catch(() => undefined)));
  }
}

function toRow(
  mode: DaemonBenchMode,
  workers: number,
  reps: number,
  samples: RepSamples,
): DaemonBenchRow {
  return {
    mode,
    workers,
    reps,
    processes: mode === 'shared' ? 1 : workers,
    totalRssBytes: summarize(samples.totalRss),
    rssPerWorkerBytes: summarize(samples.rssPerWorker),
    coldStartMs: summarize(samples.coldStart),
    coldStartAllMs: summarize(samples.coldStartAll),
    ...(mode === 'shared' ? { attachMs: summarize(samples.attach) } : {}),
    wakeMs: summarize(samples.wake),
    wakeAfterReapMs: summarize(samples.wakeAfterReap),
  };
}

export async function runDaemonBench(options: DaemonBenchOptions = {}): Promise<DaemonBenchReport> {
  const workerCounts = options.workerCounts ?? DEFAULT_WORKER_COUNTS;
  const reps = Math.max(1, options.reps ?? DEFAULT_REPS);
  const childPath =
    options.childPath ?? fileURLToPath(new URL('./daemon-bench-child.js', import.meta.url));
  const sources = new Set<RssSource>();
  const rows: DaemonBenchRow[] = [];

  for (const workers of workerCounts) {
    for (const mode of ['shared', 'per-process'] as const) {
      const samples = emptySamples();
      for (let rep = 0; rep < reps; rep += 1) {
        if (mode === 'shared') await sharedRep(childPath, workers, samples, sources);
        else await perProcessRep(childPath, workers, samples, sources);
      }
      rows.push(toRow(mode, workers, reps, samples));
    }
  }

  const report: DaemonBenchReport = {
    generatedAt: new Date().toISOString(),
    platform: platform(),
    kernel: release(),
    arch: arch(),
    node: process.version,
    rssSource: sources.has('ps') ? 'ps' : 'proc',
    workerCounts,
    reps,
    rows,
  };
  if (options.outDir) {
    await mkdir(options.outDir, { recursive: true });
    await writeFile(
      join(options.outDir, 'daemon-bench.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await writeFile(join(options.outDir, 'daemon-bench.md'), formatDaemonBenchMarkdown(report));
  }
  return report;
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

export async function runDaemonBenchCli(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const list = flag(argv, '--n') ?? env.MAKA_CLOUD_DAEMON_BENCH_N;
  const workerCounts = list
    ? list
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isInteger(value) && value > 0)
    : DEFAULT_WORKER_COUNTS;
  const reps = Number(flag(argv, '--reps') ?? env.MAKA_CLOUD_DAEMON_BENCH_REPS ?? DEFAULT_REPS);
  const outDir = flag(argv, '--out') ?? env.MAKA_CLOUD_DAEMON_BENCH_OUT ?? '';
  if (workerCounts.length === 0) {
    console.error('daemon-bench: --n needs a comma list of positive integers');
    return 2;
  }
  const report = await runDaemonBench({
    workerCounts,
    reps: Number.isFinite(reps) ? reps : DEFAULT_REPS,
    ...(outDir ? { outDir } : {}),
  });
  console.log(formatDaemonBenchMarkdown(report));
  return 0;
}
