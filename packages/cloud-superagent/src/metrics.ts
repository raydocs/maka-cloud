import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IngestInput } from './events.js';
import { sequentialIds } from './ids.js';
import { CodingLoopHandler, FakeCoder, FakeGitHost, NodeFileTestPort } from './loop.js';
import { Superagent } from './runtime.js';
import { FakeSandbox } from './sandbox.js';
import { actMandate } from './types.js';
import { scratchAddRepo } from './real-loop.js';

export interface MetricsCase {
  id: string;
  /** When omitted, a broken add() fixture is created. */
  repoDir?: string;
  /** Extra unowned events that should be ignored (wasted Router wakeups). */
  noise?: IngestInput[];
}

export interface MetricsCaseRow {
  id: string;
  ok: boolean;
  timeToGreenMs: number;
  humanInterventions: number;
  usd: number;
  wastedRouterWakeups: number;
  judgeCalls: number;
  prUrl: string | null;
}

export interface MetricsReport {
  n: number;
  success: number;
  successRate: number;
  timeToGreenMs: { mean: number; p50: number };
  humanInterventions: number;
  usdPerPr: number;
  wastedRouterWakeups: number;
  cases: MetricsCaseRow[];
}

export interface MetricsOptions {
  cases?: MetricsCase[];
  n?: number;
  parallel?: number;
  outDir?: string;
  now?: () => number;
}

/**
 * Runs the coding loop over N scratch issues/PRs with a bounded number of
 * parallel FakeSandbox workers. Writes metrics.json and metrics.md when outDir
 * is set. Never talks to Instabox or a live model.
 */
export async function runMetrics(options: MetricsOptions = {}): Promise<MetricsReport> {
  const n = options.n ?? options.cases?.length ?? 3;
  const parallel = Math.max(1, options.parallel ?? 2);
  const cases =
    options.cases ??
    Array.from({ length: n }, (_, i) => ({ id: `case-${i + 1}` }) satisfies MetricsCase);
  const rows: MetricsCaseRow[] = [];
  for (let i = 0; i < cases.length; i += parallel) {
    const batch = cases.slice(i, i + parallel);
    const part = await Promise.all(batch.map((row) => runCase(row, options.now)));
    rows.push(...part);
  }
  const success = rows.filter((row) => row.ok).length;
  const times = rows.map((row) => row.timeToGreenMs).sort((a, b) => a - b);
  const usd = rows.reduce((sum, row) => sum + row.usd, 0);
  const humans = rows.reduce((sum, row) => sum + row.humanInterventions, 0);
  const waste = rows.reduce((sum, row) => sum + row.wastedRouterWakeups, 0);
  const report: MetricsReport = {
    n: rows.length,
    success,
    successRate: rows.length === 0 ? 0 : success / rows.length,
    timeToGreenMs: {
      mean: rows.length === 0 ? 0 : times.reduce((a, b) => a + b, 0) / rows.length,
      p50: times[Math.floor(times.length / 2)] ?? 0,
    },
    humanInterventions: humans,
    usdPerPr: success === 0 ? 0 : usd / success,
    wastedRouterWakeups: waste,
    cases: rows,
  };
  if (options.outDir) {
    await mkdir(options.outDir, { recursive: true });
    await writeFile(join(options.outDir, 'metrics.json'), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(options.outDir, 'metrics.md'), formatMetricsMarkdown(report));
  }
  return report;
}

export function formatMetricsMarkdown(report: MetricsReport): string {
  const lines = [
    '# Super-agent loop metrics',
    '',
    `| cases | ${report.n} |`,
    `| success rate | ${(report.successRate * 100).toFixed(0)}% (${report.success}/${report.n}) |`,
    `| time-to-green mean | ${report.timeToGreenMs.mean.toFixed(0)} ms |`,
    `| time-to-green p50 | ${report.timeToGreenMs.p50.toFixed(0)} ms |`,
    `| human interventions | ${report.humanInterventions} |`,
    `| $/PR | ${report.usdPerPr.toFixed(6)} |`,
    `| wasted Router wakeups | ${report.wastedRouterWakeups} |`,
    '',
    '| id | ok | ttg ms | humans | $ | waste |',
    '|---|---|---|---|---|---|',
  ];
  for (const row of report.cases) {
    lines.push(
      `| ${row.id} | ${row.ok} | ${row.timeToGreenMs} | ${row.humanInterventions} | ${row.usd.toFixed(6)} | ${row.wastedRouterWakeups} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export async function runMetricsCli(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const n = Number(flag(argv, '--n') ?? env.MAKA_CLOUD_METRICS_N ?? 3);
  const parallel = Number(flag(argv, '--parallel') ?? env.MAKA_CLOUD_METRICS_PARALLEL ?? 2);
  const outDir = flag(argv, '--out') ?? env.MAKA_CLOUD_METRICS_OUT ?? '';
  const report = await runMetrics({
    n: Number.isFinite(n) ? n : 3,
    parallel: Number.isFinite(parallel) ? parallel : 2,
    ...(outDir ? { outDir } : {}),
  });
  console.log(formatMetricsMarkdown(report));
  return report.success === report.n ? 0 : 1;
}

async function runCase(input: MetricsCase, now?: () => number): Promise<MetricsCaseRow> {
  const started = now?.() ?? Date.now();
  const repoDir = input.repoDir ?? (await scratchAddRepo());
  const git = new FakeGitHost();
  const sandbox = new FakeSandbox();
  const handler = new CodingLoopHandler({
    coder: new FakeCoder(),
    tests: new NodeFileTestPort(),
    git,
    sandbox,
    repoUrl: repoDir,
  });
  let wasted = 0;
  const agent = new Superagent({
    handler,
    sandbox,
    clock: now,
    ids: sequentialIds(),
    admission: { allowActors: ['alice'] },
    judge: {
      async decide(event) {
        if (event.type === 'user_message') {
          return { action: 'ignore', reason: 'noise', confidence: 0.8 };
        }
        return {
          action: 'spawn',
          mandate: actMandate(event.subject?.repo ? [event.subject.repo] : ['local/scratch']),
          title: input.id,
        };
      },
    },
  });
  const opened = await agent.ingest(prOpened(input.id));
  for (const extra of input.noise ?? [statusNoise(input.id)]) {
    const result = await agent.ingest(extra);
    if (result.result === 'ignored' && result.judgeCalls > 0) wasted += result.judgeCalls;
  }
  const worker =
    opened.result === 'spawned' ? agent.store.worker('inv_metrics', opened.workerId) : undefined;
  const usd = (worker?.usage.usdMicros ?? 0) / 1_000_000;
  const humans = agent.store.pendingApprovals(
    'inv_metrics',
    opened.result === 'spawned' ? opened.workerId : '',
  ).length;
  const ok = opened.result === 'spawned' && git.pushes.length > 0 && git.pullRequests.length > 0;
  const ended = now?.() ?? Date.now();
  agent.close();
  return {
    id: input.id,
    ok,
    timeToGreenMs: Math.max(0, ended - started),
    humanInterventions: humans,
    usd,
    wastedRouterWakeups: wasted,
    judgeCalls: agent.judgeCalls,
    prUrl: git.pullRequests[0]?.url ?? null,
  };
}

function prOpened(id: string): IngestInput {
  const n = Number.parseInt(id.replace(/\D/g, ''), 10) || 1;
  return {
    source: 'github',
    tenantId: 'inv_metrics',
    deliveryId: `m-open-${id}`,
    event: 'pull_request',
    payload: {
      action: 'opened',
      pull_request: {
        number: n,
        title: `fix ${id}`,
        user: { login: 'alice', type: 'User' },
        head: { ref: `maka/${id}` },
      },
      repository: { full_name: 'local/scratch' },
      sender: { login: 'alice', type: 'User' },
    },
  };
}

function statusNoise(id: string): IngestInput {
  return {
    source: 'chat',
    tenantId: 'inv_metrics',
    conversationId: `noise-${id}`,
    messageId: `noise-${id}`,
    text: 'status?',
    actor: 'alice',
  };
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return argv[i + 1];
}
