import { rm } from 'node:fs/promises';
import type { IngestInput } from './events.js';
import { ExecutorCoder, type ExecutorKind } from './executor.js';
import { BoxProcessRunner } from './executor-process.js';
import { ClaudeCodeExecutor } from './claude-code-executor.js';
import { sequentialIds } from './ids.js';
import { BOX_REPO } from './loop-box.js';
import {
  CodingLoopHandler,
  FakeGitHost,
  NodeFileTestPort,
  mergeAction,
  scratchFiles,
  type CoderPort,
  type GitHostPort,
} from './loop.js';
import { FakeReviewer } from './review.js';
import { Superagent } from './runtime.js';
import type { SandboxPort } from './sandbox.js';
import { actMandate } from './types.js';
import { initLocalRepo } from './workspace.js';

/**
 * Executor benchmark (efficiency.md §4): the same small tasks per executor,
 * each in a fresh box, through the real loop up to the merge gate. The gate
 * is only checked; nothing is ever approved or merged.
 */
export interface BenchTask {
  id: string;
  title: string;
  files: Record<string, string>;
  testCommand: string;
}

export const BENCH_TASKS: readonly BenchTask[] = [
  {
    id: 'fix-add',
    title: 'add(2, 3) should be 5: fix add.js so add.test.js passes',
    files: scratchFiles(),
    testCommand: 'node add.test.js',
  },
  {
    id: 'new-sub',
    title: 'Add sub.js exporting sub(a, b) so sub.test.js passes',
    files: {
      'package.json': '{ "type": "module" }\n',
      'sub.test.js': [
        "import assert from 'node:assert/strict';",
        "import { sub } from './sub.js';",
        'assert.equal(sub(5, 3), 2);',
        'assert.equal(sub(0, 4), -4);',
        '',
      ].join('\n'),
    },
    testCommand: 'node sub.test.js',
  },
  {
    id: 'fix-slug',
    title:
      "slugify('  Hello, World!  ') should be 'hello-world': fix slug.js so slug.test.js passes",
    files: {
      'package.json': '{ "type": "module" }\n',
      'slug.js': 'export function slugify(text) {\n  return text.replace(/ /g, "-");\n}\n',
      'slug.test.js': [
        "import assert from 'node:assert/strict';",
        "import { slugify } from './slug.js';",
        "assert.equal(slugify('  Hello, World!  '), 'hello-world');",
        "assert.equal(slugify('A  b'), 'a-b');",
        '',
      ].join('\n'),
    },
    testCommand: 'node slug.test.js',
  },
];

export interface BenchBox {
  sandbox: SandboxPort;
  machineId: string;
  createMs: number;
  destroy(): Promise<void>;
}

export interface BenchExecutor {
  kind: ExecutorKind;
  /** Why this executor cannot run here, or undefined when it can. */
  skip?: string;
  coder(box: BenchBox): { coder: CoderPort; peakRssKb?: () => number | undefined };
}

export interface BenchRow {
  executor: ExecutorKind;
  task: string;
  ok: boolean;
  /** Box tests green after the executor. */
  green: boolean;
  /** Pushed and a PR opened (only with a real git host). */
  pr: string | null;
  mergeGate: 'held' | 'allowed' | 'refused' | 'n/a';
  usdMicros: number;
  tokens: number;
  /** Ingest of the opened event until the loop returned. */
  toGreenMs: number;
  boxCreateMs: number;
  /** Repo materialized in the box (upload + extract). */
  workspaceStartMs: number;
  editMs: number;
  testMs: number;
  peakRssKb: number | null;
  error?: string;
  /** Short evidence (executor summary, usage, test output) for a failed row. */
  detail?: string;
}

export interface BenchReport {
  startedAt: string;
  publish: boolean;
  rows: BenchRow[];
  skipped: Array<{ executor: ExecutorKind; reason: string }>;
  summary: Array<{
    executor: ExecutorKind;
    tasks: number;
    passRate: number;
    usdPerGreen: number | null;
    tokensPerGreen: number | null;
    toGreenMsP50: number | null;
    peakRssKbMax: number | null;
    workspaceStartMsP50: number | null;
  }>;
}

export interface BenchOptions {
  tasks?: readonly BenchTask[];
  executors: readonly BenchExecutor[];
  newBox(): Promise<BenchBox>;
  /** A real git host publishes worker branches and PRs; default FakeGitHost. */
  git?: () => { git: GitHostPort; repo: string };
  budgets?: { usd?: number; tokens?: number; wallMs?: number; turns?: number };
  log?: (line: string) => void;
}

export async function runExecutorBench(options: BenchOptions): Promise<BenchReport> {
  const tasks = options.tasks ?? BENCH_TASKS;
  const report: BenchReport = {
    startedAt: new Date().toISOString(),
    publish: Boolean(options.git),
    rows: [],
    skipped: [],
    summary: [],
  };
  for (const executor of options.executors) {
    if (executor.skip) {
      report.skipped.push({ executor: executor.kind, reason: executor.skip });
      options.log?.(`skip ${executor.kind}: ${executor.skip}`);
      continue;
    }
    for (const task of tasks) {
      const row = await runTask(executor, task, options);
      report.rows.push(row);
      options.log?.(
        `${executor.kind} ${task.id}: ok=${row.ok} green=${row.green} usd=${(row.usdMicros / 1e6).toFixed(4)} tokens=${row.tokens} toGreen=${row.toGreenMs}ms gate=${row.mergeGate}${row.error ? ` error=${row.error}` : ''}`,
      );
    }
  }
  report.summary = summarize(report.rows);
  return report;
}

async function runTask(
  executor: BenchExecutor,
  task: BenchTask,
  options: BenchOptions,
): Promise<BenchRow> {
  const row: BenchRow = {
    executor: executor.kind,
    task: task.id,
    ok: false,
    green: false,
    pr: null,
    mergeGate: 'n/a',
    usdMicros: 0,
    tokens: 0,
    toGreenMs: 0,
    boxCreateMs: 0,
    workspaceStartMs: 0,
    editMs: 0,
    testMs: 0,
    peakRssKb: null,
  };
  let box: BenchBox | undefined;
  let dir: string | undefined;
  try {
    box = await options.newBox();
    row.boxCreateMs = box.createMs;
    dir = await initLocalRepo(task.files);
    const made = executor.coder(box);
    const hosted = options.git?.();
    const git = hosted?.git ?? new FakeGitHost();
    const repo = hosted?.repo ?? 'local/bench';
    const handler = new CodingLoopHandler({
      coder: made.coder,
      tests: new NodeFileTestPort(task.testCommand),
      git,
      sandbox: box.sandbox,
      repoUrl: dir,
      boxSource: 'upload',
      testCommand: task.testCommand,
      publish: true,
    });
    const agent = new Superagent({
      handler,
      sandbox: box.sandbox,
      sandboxRef: box.machineId,
      reviewer: new FakeReviewer(),
      judge: {
        async decide() {
          return {
            action: 'spawn',
            mandate: {
              ...actMandate([repo]),
              budgets: {
                usd: 1,
                tokens: 2_000_000,
                wallMs: 15 * 60_000,
                turns: 60,
                ...options.budgets,
              },
              allowNoCi: true,
            },
            title: `bench ${task.id}`,
          };
        },
      },
      ids: sequentialIds(500),
      admission: { allowActors: ['alice'] },
    });
    try {
      const started = Date.now();
      const opened = await agent.ingest(openedEvent(repo, task));
      row.toGreenMs = Date.now() - started;
      if (opened.result !== 'spawned') throw new Error(`expected spawn, got ${opened.result}`);
      const worker = agent.store.worker('bench', opened.workerId);
      row.usdMicros = worker?.usage.usdMicros ?? 0;
      row.tokens = worker?.usage.tokens ?? 0;
      row.workspaceStartMs = handler.lastTimings.materialize;
      row.editMs = handler.lastTimings.edit;
      row.testMs = handler.lastTimings.test;
      row.peakRssKb = made.peakRssKb?.() ?? null;
      const tested = [...(worker?.evidence ?? [])].reverse().find((block) => block.kind === 'test');
      row.green = /^exit=0$/m.test(tested?.body ?? '');
      const pr = handler.lastPr.get(opened.workerId);
      const sha = handler.lastPush.get(opened.workerId)?.sha;
      if (pr && sha && hosted) {
        row.pr = pr.url;
        await agent.review('bench', opened.workerId, { repo, number: pr.number, sha });
        const waiting = agent.store.worker('bench', opened.workerId);
        if (waiting) {
          const gate = agent.safety.gate(waiting, mergeAction(repo, pr.number, sha), Date.now());
          // Never approved here: a held merge is where the bench stops.
          row.mergeGate = gate.allowed ? 'allowed' : gate.reason === 'held' ? 'held' : 'refused';
        }
      }
      row.ok = row.green && (!hosted || row.mergeGate === 'held');
      if (!row.green) {
        row.error = (
          worker?.memory || `tests not green (worker ${worker?.state ?? 'missing'})`
        ).slice(0, 200);
        row.detail = (worker?.evidence ?? [])
          .filter(
            (block) =>
              block.kind === 'test' ||
              /box-edit|usage|needs-person|blocked|executor/.test(block.label),
          )
          .map((block) => `${block.label}: ${block.body.slice(0, 300)}`)
          .join('\n');
      }
    } finally {
      agent.close();
    }
  } catch (error) {
    row.error = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  } finally {
    if (box) await box.destroy().catch(() => undefined);
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  return row;
}

function openedEvent(repo: string, task: BenchTask): IngestInput {
  return {
    source: 'github',
    tenantId: 'bench',
    deliveryId: `bench-${task.id}-${Date.now()}`,
    event: 'pull_request',
    payload: {
      action: 'opened',
      pull_request: {
        number: 1,
        title: task.title,
        body: `${task.title}\nRun \`${task.testCommand}\` until it passes. Change only what the task needs.`,
        user: { login: 'alice', type: 'User' },
        head: { ref: `bench/${task.id}` },
      },
      repository: { full_name: repo },
      sender: { login: 'alice', type: 'User' },
    },
  };
}

function p50(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

export function summarize(rows: readonly BenchRow[]): BenchReport['summary'] {
  const kinds = [...new Set(rows.map((row) => row.executor))];
  return kinds.map((executor) => {
    const mine = rows.filter((row) => row.executor === executor);
    const green = mine.filter((row) => row.ok);
    const spent = mine.reduce((sum, row) => sum + row.usdMicros, 0);
    const tokens = mine.reduce((sum, row) => sum + row.tokens, 0);
    const rss = mine.map((row) => row.peakRssKb).filter((value): value is number => value !== null);
    return {
      executor,
      tasks: mine.length,
      passRate: mine.length ? green.length / mine.length : 0,
      // Everything spent, failures included, per green task.
      usdPerGreen: green.length ? spent / 1e6 / green.length : null,
      tokensPerGreen: green.length ? Math.round(tokens / green.length) : null,
      toGreenMsP50: p50(green.map((row) => row.toGreenMs)),
      peakRssKbMax: rss.length ? Math.max(...rss) : null,
      workspaceStartMsP50: p50(mine.map((row) => row.workspaceStartMs)),
    };
  });
}

export function formatBenchTable(report: BenchReport): string {
  const lines = [
    '| executor | tasks | pass | $/green | tokens/green | to-green p50 | peak RSS | workspace start p50 |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const row of report.summary) {
    lines.push(
      `| ${row.executor} | ${row.tasks} | ${(row.passRate * 100).toFixed(0)}% | ${row.usdPerGreen === null ? '—' : `$${row.usdPerGreen.toFixed(4)}`} | ${row.tokensPerGreen ?? '—'} | ${row.toGreenMsP50 === null ? '—' : `${(row.toGreenMsP50 / 1000).toFixed(1)} s`} | ${row.peakRssKbMax === null ? '—' : `${(row.peakRssKbMax / 1024).toFixed(0)} MiB`} | ${row.workspaceStartMsP50 ?? '—'} ms |`,
    );
  }
  for (const skip of report.skipped)
    lines.push(`| ${skip.executor} | skipped: ${skip.reason} |||||||`);
  return lines.join('\n');
}

/** Claude Code inside the box on the box's Secret-backed login. */
export function claudeCodeBenchExecutor(options: {
  env: NodeJS.ProcessEnv;
  model: string;
  secret?: string;
  timeBin?: string;
}): BenchExecutor {
  return {
    kind: 'claude-code',
    coder(box) {
      const runner = new BoxProcessRunner(box.sandbox, {
        ...(options.timeBin ? { timeBin: options.timeBin } : {}),
      });
      const coder = new ExecutorCoder(
        new ClaudeCodeExecutor({
          env: options.env,
          model: options.model,
          runner,
          permissionMode: 'bypassPermissions',
          ...(options.secret ? { boxSecretEnv: { CLAUDE_CODE_OAUTH_TOKEN: options.secret } } : {}),
        }),
        { box: { sandbox: box.sandbox, workdir: BOX_REPO } },
      );
      return { coder, peakRssKb: () => runner.peakRssKb.get(box.machineId) };
    },
  };
}

/**
 * `npm run executor-bench`: live Instabox boxes (`INSTABOX_API_KEY`), Claude
 * Code on the box Secret named by `MAKA_CLOUD_EXECUTOR_CLAUDE_SECRET`, model
 * `MAKA_CLOUD_EXECUTOR_MODEL` (default Haiku 5.5). `MAKA_CLOUD_BENCH_PUBLISH=1`
 * with `MAKA_GITHUB_TOKEN` and `MAKA_CLOUD_LOOP_REPO` opens real PRs and stops
 * at the held merge. Keys are read from env only and never printed.
 */
export async function runExecutorBenchCli(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { HttpSandbox, SMALLEST_SANDBOX, instaboxApiFromEnv, instaboxCreateSourceFromEnv } =
    await import('./sandbox.js');
  const { createGitHostFromEnv } = await import('./loop-github.js');
  const { boxSecretsFromEnv } = await import('./real-loop.js');
  const api = instaboxApiFromEnv(env);
  const sandbox = new HttpSandbox({ apiKey: api.apiKey, baseUrl: api.baseUrl });
  const secrets = boxSecretsFromEnv(env);
  let timeBin: string | undefined;
  const newBox = async (): Promise<BenchBox> => {
    const started = Date.now();
    const created = await sandbox.createMachine({
      name: `maka-bench-${Date.now()}`,
      ...instaboxCreateSourceFromEnv(env),
      desiredState: 'running',
      vcpus: SMALLEST_SANDBOX.vcpus,
      memMiB: SMALLEST_SANDBOX.memMiB,
      metadata: { 'maka.purpose': 'executor-bench' },
      ...secrets,
    });
    const settled =
      created.state === 'succeeded' ? created : await sandbox.waitForOperation(created.id);
    const machineId = settled.machineId ?? created.machineId;
    if (!machineId) throw new Error('Instabox create returned no machine id.');
    if (timeBin === undefined) {
      const probe = await sandbox.exec(machineId, { cmd: 'test -x /usr/bin/time && echo yes' });
      timeBin = probe.stdout.includes('yes') ? '/usr/bin/time' : '';
    }
    return {
      sandbox,
      machineId,
      createMs: Date.now() - started,
      destroy: async () => {
        await sandbox.destroyMachine(machineId);
      },
    };
  };
  const model = env.MAKA_CLOUD_EXECUTOR_MODEL?.trim() || 'claude-haiku-5-5';
  const secret = env.MAKA_CLOUD_EXECUTOR_CLAUDE_SECRET?.trim();
  const claude = claudeCodeBenchExecutor({ env, model, ...(secret ? { secret } : {}) });
  const executors: BenchExecutor[] = [
    {
      ...claude,
      coder: (box) =>
        claudeCodeBenchExecutor({
          env,
          model,
          ...(secret ? { secret } : {}),
          ...(timeBin ? { timeBin } : {}),
        }).coder(box),
    },
    {
      kind: 'codex',
      skip:
        env.MAKA_CLOUD_BENCH_CODEX_SKIP?.trim() ||
        'no CodexExecutor run configured (needs an OpenAI Secret in the Instabox org or the Magpie route)',
      coder: () => {
        throw new Error('codex skipped');
      },
    },
    {
      kind: 'maka',
      skip: 'the maka engine is not behind the Executor interface yet',
      coder: () => {
        throw new Error('maka skipped');
      },
    },
  ];
  const publish = env.MAKA_CLOUD_BENCH_PUBLISH === '1';
  const report = await runExecutorBench({
    executors,
    newBox,
    ...(publish
      ? {
          git: () => {
            const hosted = createGitHostFromEnv({ ...env, MAKA_CLOUD_LOOP_LIVE: '1' });
            if (hosted.kind !== 'github' || !hosted.repo) {
              throw new Error(
                'MAKA_CLOUD_BENCH_PUBLISH=1 needs MAKA_GITHUB_TOKEN and MAKA_CLOUD_LOOP_REPO.',
              );
            }
            return { git: hosted.git, repo: hosted.repo };
          },
        }
      : {}),
    log: (line) => console.log(line),
  });
  console.log(JSON.stringify(report, null, 2));
  console.log(formatBenchTable(report));
  return report.rows.length > 0 ? 0 : 1;
}
