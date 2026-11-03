import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { arch, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { LayeredStore } from './layered-workspace.js';
import { GitCloneStore, initLocalRepo, type WorkspaceHandle } from './workspace.js';

const run = promisify(execFile);

/**
 * Compares today's workspace path (GitCloneStore plus an install per
 * assignment) with LayeredStore for N assignments on one base. The install is
 * simulated by copying a generated `node_modules` (no network). Start time is
 * the `prepare` call (for `clone`: prepare plus the install); the layered
 * base build is reported apart as `baseBuildMs`.
 */

export type WorkspaceBenchMode = 'clone' | 'layered';
export type RssSource = 'time' | 'self';

export interface Stats {
  n: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

export interface WorkspaceBenchRow {
  mode: WorkspaceBenchMode;
  assignments: number;
  reps: number;
  /** Layer backing the assignments: `overlay`, `clone-shared`, or `git-clone` for the clone mode. */
  layer: string;
  /** How dependency directories were copied (clone-shared layers only). */
  copyMethod: string;
  /** Per-assignment start time, all assignments of all reps. */
  startMs: Stats;
  /** Layered only: building the base (clone + install), once per rep. */
  baseBuildMs: Stats;
  /** `du -skx` of everything the mode keeps on disk (hard links counted once). */
  diskTotalKb: number;
  diskPerAssignmentKb: number;
  /** (total after N assignments - total with only the base) / N. */
  diskMarginalPerAssignmentKb: number;
  /** Peak RSS of a child process that runs one prepare (median over reps). */
  peakRssKb: number;
  rssSource: RssSource;
}

export interface WorkspaceBenchReport {
  generatedAt: string;
  platform: string;
  kernel: string;
  arch: string;
  node: string;
  overlayRequested: 'auto' | 'off';
  fixture: { packages: number; filesPerPackage: number; files: number };
  assignmentCounts: number[];
  reps: number;
  rows: WorkspaceBenchRow[];
}

export interface WorkspaceBenchOptions {
  assignmentCounts?: number[];
  reps?: number;
  overlay?: 'auto' | 'off';
  modes?: WorkspaceBenchMode[];
  /** Files in the generated node_modules (rounded to whole packages of 20). */
  files?: number;
  /** Parent directory for scratch data. Overlay needs a filesystem that supports it. */
  workDir?: string;
  measureRss?: boolean;
}

const FILES_PER_PACKAGE = 20;

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

export function summarize(values: readonly number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    n: sorted.length,
    min: sorted[0] ?? Number.NaN,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? Number.NaN,
    mean: sorted.length === 0 ? Number.NaN : sum / sorted.length,
  };
}

function median(values: readonly number[]): number {
  return percentile(values, 50);
}

async function makeFixture(dir: string, packages: number): Promise<void> {
  const body = 'x'.repeat(900);
  for (let p = 0; p < packages; p += 1) {
    const pkg = join(dir, 'node_modules', `pkg-${p}`);
    await mkdir(join(pkg, 'lib'), { recursive: true });
    await writeFile(join(pkg, 'package.json'), `{"name":"pkg-${p}","version":"1.0.0"}\n`);
    for (let f = 1; f < FILES_PER_PACKAGE; f += 1) {
      await writeFile(join(pkg, 'lib', `f${f}.js`), `// ${p}/${f}\n${body}\n`);
    }
  }
}

function installCommand(fixture: string): string {
  return `cp -R '${fixture}/node_modules' node_modules`;
}

async function duKb(path: string): Promise<number> {
  const { stdout } = await run('du', ['-skx', path]);
  return Number.parseInt(stdout.split('\t')[0] ?? '0', 10);
}

async function removeTree(path: string): Promise<void> {
  await run('find', [path, '-type', 'd', '-exec', 'chmod', 'u+w', '{}', '+']).catch(() => {});
  await rm(path, { recursive: true, force: true });
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

interface ChildJob {
  mode: WorkspaceBenchMode;
  root: string;
  repo: string;
  fixture: string;
  overlay: 'auto' | 'off';
}

interface ChildResult {
  ms: number;
  layer: string;
  selfRssKb: number;
}

/** One prepare (and release), run in the current process. Used by the child mode. */
async function runChildJob(job: ChildJob): Promise<ChildResult> {
  const install = installCommand(job.fixture);
  const start = performance.now();
  let layer = 'git-clone';
  if (job.mode === 'clone') {
    const store = new GitCloneStore();
    const dir = join(job.root, 'rss-clone');
    const handle = await store.prepare({
      tenantId: 'bench',
      workerId: 'rss',
      repoUrl: job.repo,
      workDir: dir,
    });
    await run('sh', ['-c', install], { cwd: dir });
    const ms = performance.now() - start;
    await store.release(handle);
    return { ms, layer, selfRssKb: process.resourceUsage().maxRSS };
  }
  const store = new LayeredStore({ root: job.root, installCommand: install, overlay: job.overlay });
  const handle = await store.prepare({
    tenantId: 'bench',
    workerId: 'rss',
    repoUrl: job.repo,
  });
  const ms = performance.now() - start;
  layer = handle.layer ?? 'layered';
  await store.release(handle);
  return { ms, layer, selfRssKb: process.resourceUsage().maxRSS };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function measureChild(
  job: ChildJob,
  useTime: boolean,
): Promise<{ result: ChildResult; rssKb: number; source: RssSource }> {
  const script = fileURLToPath(new URL('../scripts/workspace-bench.mjs', import.meta.url));
  const args = [process.execPath, script, '--child', JSON.stringify(job)];
  const timeBinary = '/usr/bin/time';
  if (useTime && (await fileExists(timeBinary))) {
    const flag = platform() === 'darwin' ? '-l' : '-v';
    const { stdout, stderr } = await run(timeBinary, [flag, ...args], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const result = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as ChildResult;
    const mac = /(\d+)\s+maximum resident set size/.exec(stderr);
    const linux = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(stderr);
    const parsed = mac ? Number(mac[1]) / 1024 : linux ? Number(linux[1]) : Number.NaN;
    if (!Number.isNaN(parsed)) return { result, rssKb: Math.round(parsed), source: 'time' };
    return { result, rssKb: result.selfRssKb, source: 'self' };
  }
  const { stdout } = await run(args[0] as string, args.slice(1), { maxBuffer: 16 * 1024 * 1024 });
  const result = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as ChildResult;
  return { result, rssKb: result.selfRssKb, source: 'self' };
}

interface RepSample {
  startMs: number[];
  baseBuildMs?: number;
  diskTotalKb: number;
  diskMarginalKb: number;
  layer: string;
  copyMethod: string;
  rssKb: number;
  rssSource: RssSource;
}

async function benchOnce(
  mode: WorkspaceBenchMode,
  n: number,
  scratch: string,
  repo: string,
  fixture: string,
  options: Required<Pick<WorkspaceBenchOptions, 'overlay' | 'measureRss'>>,
): Promise<RepSample> {
  const root = await mkdtemp(join(scratch, `${mode}-`));
  const install = installCommand(fixture);
  const startMs: number[] = [];
  const handles: WorkspaceHandle[] = [];
  let baseBuildMs: number | undefined;
  let baseKb = 0;
  let layer = 'git-clone';
  let copyMethod = 'n/a';
  let releaseOne: (handle: WorkspaceHandle) => Promise<void>;
  if (mode === 'clone') {
    const store = new GitCloneStore();
    releaseOne = (handle) => store.release(handle);
    for (let i = 0; i < n; i += 1) {
      const dir = join(root, `a${i}`);
      const { value, ms } = await timed(async () => {
        const handle = await store.prepare({
          tenantId: 'bench',
          workerId: `w${i}`,
          repoUrl: repo,
          workDir: dir,
        });
        await run('sh', ['-c', install], { cwd: dir });
        return handle;
      });
      handles.push(value);
      startMs.push(ms);
    }
  } else {
    const store = new LayeredStore({ root, installCommand: install, overlay: options.overlay });
    releaseOne = (handle) => store.release(handle);
    const base = await timed(() => store.ensureBase({ repoUrl: repo }));
    baseBuildMs = base.ms;
    baseKb = await duKb(root);
    for (let i = 0; i < n; i += 1) {
      const { value, ms } = await timed(() =>
        store.prepare({ tenantId: 'bench', workerId: `w${i}`, repoUrl: repo }),
      );
      handles.push(value);
      startMs.push(ms);
    }
    layer = handles[0]?.layer ?? 'layered';
    copyMethod = layer === 'overlay' ? 'n/a' : (store.lastCopyMethod ?? 'n/a');
  }
  const diskTotalKb = await duKb(root);
  let rssKb = Number.NaN;
  let rssSource: RssSource = 'self';
  if (options.measureRss) {
    const measured = await measureChild(
      { mode, root, repo, fixture, overlay: options.overlay },
      true,
    );
    rssKb = measured.rssKb;
    rssSource = measured.source;
  }
  for (const handle of handles) await releaseOne(handle);
  await removeTree(root);
  return {
    startMs,
    baseBuildMs,
    diskTotalKb,
    diskMarginalKb: (diskTotalKb - baseKb) / n,
    layer,
    copyMethod,
    rssKb,
    rssSource,
  };
}

export async function runWorkspaceBench(
  options: WorkspaceBenchOptions = {},
): Promise<WorkspaceBenchReport> {
  const assignmentCounts = options.assignmentCounts ?? [1, 4, 8];
  const reps = options.reps ?? 3;
  const overlay = options.overlay ?? 'auto';
  const modes = options.modes ?? ['clone', 'layered'];
  const packages = Math.max(1, Math.round((options.files ?? 3000) / FILES_PER_PACKAGE));
  const scratch = await mkdtemp(join(options.workDir ?? tmpdir(), 'maka-ws-bench-'));
  try {
    const fixture = join(scratch, 'fixture');
    await makeFixture(fixture, packages);
    const repo = await initLocalRepo(
      {
        'package.json': '{"name":"bench","private":true}\n',
        'package-lock.json': '{"lockfileVersion":3}\n',
        '.gitignore': 'node_modules/\n',
        'src/index.js': 'export const x = 1;\n',
      },
      join(scratch, 'repo'),
    );
    const rows: WorkspaceBenchRow[] = [];
    for (const mode of modes) {
      for (const n of assignmentCounts) {
        const samples: RepSample[] = [];
        for (let rep = 0; rep < reps; rep += 1) {
          samples.push(
            await benchOnce(mode, n, scratch, repo, fixture, {
              overlay,
              measureRss: options.measureRss ?? true,
            }),
          );
        }
        const totals = samples.map((s) => s.diskTotalKb);
        rows.push({
          mode,
          assignments: n,
          reps,
          layer: samples[0]?.layer ?? 'n/a',
          copyMethod: samples[0]?.copyMethod ?? 'n/a',
          startMs: summarize(samples.flatMap((s) => s.startMs)),
          baseBuildMs: summarize(
            samples.flatMap((s) => (s.baseBuildMs === undefined ? [] : [s.baseBuildMs])),
          ),
          diskTotalKb: median(totals),
          diskPerAssignmentKb: median(totals) / n,
          diskMarginalPerAssignmentKb: median(samples.map((s) => s.diskMarginalKb)),
          peakRssKb: median(samples.map((s) => s.rssKb)),
          rssSource: samples[0]?.rssSource ?? 'self',
        });
      }
    }
    return {
      generatedAt: new Date().toISOString(),
      platform: platform(),
      kernel: release(),
      arch: arch(),
      node: process.version,
      overlayRequested: overlay,
      fixture: {
        packages,
        filesPerPackage: FILES_PER_PACKAGE,
        files: packages * FILES_PER_PACKAGE,
      },
      assignmentCounts,
      reps,
      rows,
    };
  } finally {
    await removeTree(scratch);
  }
}

const fmt = (value: number, digits = 0): string =>
  Number.isFinite(value) ? value.toFixed(digits) : 'n/a';

export function formatWorkspaceBenchTable(report: WorkspaceBenchReport): string {
  const lines = [
    `workspace-bench ${report.platform} ${report.kernel} ${report.arch} node ${report.node}, ` +
      `fixture ${report.fixture.files} files, ${report.reps} reps, overlay=${report.overlayRequested}`,
    '',
    '| mode | N | layer | copy | start p50 ms | start p95 ms | base build ms | disk total MB | disk/assign MB | marginal/assign MB | peak RSS MB |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const row of report.rows) {
    lines.push(
      `| ${row.mode} | ${row.assignments} | ${row.layer} | ${row.copyMethod} | ${fmt(row.startMs.p50)} | ${fmt(row.startMs.p95)} | ${fmt(row.baseBuildMs.p50)} | ${fmt(row.diskTotalKb / 1024, 1)} | ${fmt(row.diskPerAssignmentKb / 1024, 1)} | ${fmt(row.diskMarginalPerAssignmentKb / 1024, 1)} | ${fmt(row.peakRssKb / 1024, 1)} (${row.rssSource}) |`,
    );
  }
  return lines.join('\n');
}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

export async function runWorkspaceBenchCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const childJob = flag(argv, '--child');
  if (childJob) {
    const result = await runChildJob(JSON.parse(childJob) as ChildJob);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  const overlay = flag(argv, '--overlay') === 'off' ? 'off' : 'auto';
  const counts = flag(argv, '--assignments')
    ?.split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  const modes = flag(argv, '--modes')
    ?.split(',')
    .filter((m): m is WorkspaceBenchMode => m === 'clone' || m === 'layered');
  const report = await runWorkspaceBench({
    assignmentCounts: counts?.length ? counts : undefined,
    reps: flag(argv, '--reps') ? Number(flag(argv, '--reps')) : undefined,
    files: flag(argv, '--files') ? Number(flag(argv, '--files')) : undefined,
    workDir: flag(argv, '--work-dir'),
    modes: modes?.length ? modes : undefined,
    overlay,
  });
  const jsonPath = flag(argv, '--json');
  if (jsonPath) await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(report, null, 2)}\n\n`);
  process.stdout.write(`${formatWorkspaceBenchTable(report)}\n`);
  return 0;
}
