import { rm } from 'node:fs/promises';
import type { IngestInput } from './events.js';
import { ExecutorCoder, type ExecutorKind, type ExecutorRoute } from './executor.js';
import { executorTokens, hasListPrice } from './executor-budget.js';
import { ExecutorReviewer, crossVendorKind } from './executor-review.js';
import { BoxProcessRunner } from './executor-process.js';
import { sequentialIds } from './ids.js';
import { BOX_REPO } from './loop-box.js';
import { createCoderFromEnv, createExecutorFromEnv, gatewayFromEnv } from './loop-coder.js';
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
  /** Model and auth route the session ran on (from the stored session). */
  model?: string;
  route?: ExecutorRoute;
  /** The other vendor's review of the green change, when asked for. */
  review?: { verdict: 'CLEAR' | 'BLOCK' | null; usdMicros: number; tokens: number; ms: number };
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
    /** Null when a green row's model has no list price (its USD would be a guess). */
    usdPerGreen: number | null;
    models: string[];
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
  /** Cross-vendor review of each green task (`MAKA_CLOUD_BENCH_REVIEW=cross`). */
  reviewer?: (box: BenchBox, author: ExecutorKind) => ExecutorReviewer | undefined;
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
    const reviewer = options.reviewer?.(box, executor.kind);
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
      reviewer: reviewer ?? new FakeReviewer(),
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
      if (made.coder instanceof ExecutorCoder) {
        const session = await made.coder.session(opened.workerId, 'bench');
        if (session?.model) row.model = session.model;
        if (session?.route) row.route = session.route;
      }
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
      if (reviewer && row.green) {
        // Unpublished runs have no PR: review the box's working-tree change.
        if (!hosted) {
          await reviewer.review({ repo, number: 0, sha: sha ?? 'HEAD' });
        }
        const last = reviewer.records.at(-1);
        if (last) {
          row.review = {
            verdict: last.verdict ?? null,
            usdMicros: last.usage.usdMicros,
            tokens: executorTokens(last.usage),
            ms: last.ms,
          };
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
      usdPerGreen:
        green.length && mine.every((row) => hasListPrice(row.model))
          ? spent / 1e6 / green.length
          : null,
      models: [...new Set(mine.map((row) => `${row.model ?? '?'} (${row.route ?? '?'})`))],
      tokensPerGreen: green.length ? Math.round(tokens / green.length) : null,
      toGreenMsP50: p50(green.map((row) => row.toGreenMs)),
      peakRssKbMax: rss.length ? Math.max(...rss) : null,
      workspaceStartMsP50: p50(mine.map((row) => row.workspaceStartMs)),
    };
  });
}

export function formatBenchTable(report: BenchReport): string {
  const lines = [
    '| executor | model (route) | tasks | pass | $/green | tokens/green | to-green p50 | peak RSS | workspace start p50 |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const row of report.summary) {
    lines.push(
      `| ${row.executor} | ${row.models.join(', ')} | ${row.tasks} | ${(row.passRate * 100).toFixed(0)}% | ${row.usdPerGreen === null ? 'unpriced' : `$${row.usdPerGreen.toFixed(4)}`} | ${row.tokensPerGreen ?? '—'} | ${row.toGreenMsP50 === null ? '—' : `${(row.toGreenMsP50 / 1000).toFixed(1)} s`} | ${row.peakRssKbMax === null ? '—' : `${(row.peakRssKbMax / 1024).toFixed(0)} MiB`} | ${row.workspaceStartMsP50 ?? '—'} ms |`,
    );
  }
  for (const skip of report.skipped)
    lines.push(`| ${skip.executor} | skipped: ${skip.reason} ||||||||`);
  return lines.join('\n');
}

/**
 * A CLI executor in the box, built the way `createCoderFromEnv` builds it
 * (box Secret login, or Magpie per `MAKA_CLOUD_EXECUTOR_GATEWAY`).
 */
export function cliBenchExecutor(
  kind: 'claude-code' | 'codex',
  env: NodeJS.ProcessEnv,
  options: { timeBin?: () => string | undefined; skip?: string } = {},
): BenchExecutor {
  return {
    kind,
    ...(options.skip ? { skip: options.skip } : {}),
    coder(box) {
      const timeBin = options.timeBin?.();
      const runner = new BoxProcessRunner(box.sandbox, timeBin ? { timeBin } : {});
      const made = createCoderFromEnv({ ...env, MAKA_CLOUD_EXECUTOR: kind }, fetch, {
        sandbox: box.sandbox,
        runner,
      });
      return { coder: made.coder, peakRssKb: () => runner.peakRssKb.get(box.machineId) };
    },
  };
}

/**
 * `npm run executor-bench`: live Instabox boxes (`INSTABOX_API_KEY`).
 * `MAKA_CLOUD_BENCH_EXECUTORS` picks executors (default `claude-code,codex`);
 * `MAKA_CLOUD_BENCH_CLAUDE_MODEL` (default Haiku 5.5) and
 * `MAKA_CLOUD_BENCH_CODEX_MODEL` set each one's model on its built-in login,
 * and `MAKA_CLOUD_BENCH_<KIND>_MAGPIE_MODEL` its Magpie model. Auth is as in
 * `createCoderFromEnv`: box Secrets, else Magpie. `MAKA_CLOUD_BENCH_PUBLISH=1`
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
  const picked = (env.MAKA_CLOUD_BENCH_EXECUTORS?.trim() || 'claude-code,codex')
    .split(',')
    .map((kind) => kind.trim());
  const { gateway } = gatewayFromEnv(env);
  const forKind = (kind: 'claude-code' | 'codex'): NodeJS.ProcessEnv => {
    const tag = kind === 'codex' ? 'CODEX' : 'CLAUDE';
    const model =
      env[`MAKA_CLOUD_BENCH_${tag}_MODEL`]?.trim() ||
      (kind === 'claude-code' ? 'claude-haiku-5-5' : undefined);
    const magpieModel = env[`MAKA_CLOUD_BENCH_${tag}_MAGPIE_MODEL`]?.trim();
    const out: NodeJS.ProcessEnv = { ...env };
    delete out.MAKA_CLOUD_EXECUTOR_MODEL;
    delete out.MAKA_CLOUD_MAGPIE_MODEL;
    if (model) out.MAKA_CLOUD_EXECUTOR_MODEL = model;
    if (magpieModel) out.MAKA_CLOUD_MAGPIE_MODEL = magpieModel;
    return out;
  };
  const executors: BenchExecutor[] = [];
  for (const kind of ['claude-code', 'codex'] as const) {
    if (!picked.includes(kind)) continue;
    const secret =
      kind === 'codex'
        ? env.MAKA_CLOUD_EXECUTOR_CODEX_SECRET?.trim()
        : env.MAKA_CLOUD_EXECUTOR_CLAUDE_SECRET?.trim();
    const skip =
      !gateway && !secret
        ? `no box login (Secret) and no Magpie route (MAKA_CLOUD_MAGPIE_URL / MAKA_CLOUD_MAGPIE_KEY)`
        : undefined;
    executors.push(
      cliBenchExecutor(kind, forKind(kind), {
        timeBin: () => timeBin || undefined,
        ...(skip ? { skip } : {}),
      }),
    );
  }
  executors.push({
    kind: 'maka',
    skip: 'the maka engine is not behind the Executor interface yet',
    coder: () => {
      throw new Error('maka skipped');
    },
  });
  const publish = env.MAKA_CLOUD_BENCH_PUBLISH === '1';
  const cross = env.MAKA_CLOUD_BENCH_REVIEW === 'cross';
  const report = await runExecutorBench({
    executors,
    newBox,
    ...(cross
      ? {
          reviewer: (box: BenchBox, author: ExecutorKind) => {
            const kind = crossVendorKind(author);
            return new ExecutorReviewer(
              createExecutorFromEnv(kind, forKind(kind), { sandbox: box.sandbox }),
              {
                locate: () => ({
                  workdir: BOX_REPO,
                  boxId: box.machineId,
                  // The loop keeps the edits uncommitted in the box checkout.
                  show: 'git status --short && git diff HEAD',
                }),
              },
            );
          },
        }
      : {}),
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
