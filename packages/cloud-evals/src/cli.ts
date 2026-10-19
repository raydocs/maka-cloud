import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  FileAttemptStore,
  expandExperiment,
  parseExperimentSpec,
  runMakaEvalCli,
  type ExperimentSpec,
} from '@maka/eval';
import { budgetOf, createCloudEvals } from './cloud.js';
import { FAKE_PROFILES, FakeDriver, FakeGrader, FakeHiddenTests } from './fake.js';
import { BudgetLedger } from './ledger.js';
import { type EvalDeps, assertLiveApproved, createLiveDeps } from './live.js';
import { carrySpend, priorSpentUsd } from './recovery.js';
import { writeReport } from './report.js';
import { SweBenchDataset, selectStratified, terminalBenchTasks } from './suites.js';
import { makeSpec } from './spec-gen.js';
import {
  SUBJECT_IDS,
  type PublicTask,
  type SubjectDriver,
  type SubjectId,
  type SuiteId,
} from './types.js';

const USAGE = [
  'usage:',
  '  cloud-evals select --suite swe-bench-verified --dataset <jsonl> --size <n> --seed <text> [--out <ids.json>]',
  '  cloud-evals select --suite terminal-bench --from <experiment.json> --size <n> --seed <text> [--out <ids.json>]',
  '  cloud-evals make-spec --suite <suite> (--dataset <jsonl> | --from <experiment.json> | --synthetic <n>)',
  '      [--ids-file <ids.json> | --size <n> --seed <text>] [--subjects a,b,c] [--repetitions <n>]',
  '      --task-budget-usd <usd> --total-budget-usd <usd> [--timeout-seconds <s>] [--mode dry-run|live] --out <spec.json>',
  '  cloud-evals run <spec.json> --out <dir> [--cell <id>]... [--live --approve-budget <usd>]',
  '  cloud-evals report <dir>',
].join('\n');

export interface CloudEvalsCliDependencies {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  signal?: AbortSignal;
  /** Replaces the real subjects, sandbox and grader of a live run (tests). */
  liveDeps?: (spec: ExperimentSpec, workRoot: string, stateDir: string) => Promise<EvalDeps>;
}

type Flags = Map<string, string[]>;

function parseFlags(
  argv: readonly string[],
  booleans: readonly string[] = [],
): {
  positional: string[];
  flags: Flags;
} {
  const positional: string[] = [];
  const flags: Flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (booleans.includes(name)) {
      flags.set(name, ['true']);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
    i += 1;
  }
  return { positional, flags };
}

function one(flags: Flags, name: string): string | undefined {
  const values = flags.get(name);
  if (values && values.length > 1) throw new Error(`--${name} was given more than once`);
  return values?.[0];
}

function required(flags: Flags, name: string): string {
  const value = one(flags, name);
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

function number(flags: Flags, name: string): number {
  const value = Number(required(flags, name));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`);
  return value;
}

function suiteOf(flags: Flags): SuiteId {
  const suite = required(flags, 'suite');
  if (suite !== 'swe-bench-verified' && suite !== 'terminal-bench')
    throw new Error(`unknown suite: ${suite}`);
  return suite;
}

async function loadTasks(
  flags: Flags,
  suite: SuiteId,
): Promise<{ tasks: PublicTask[]; version: string }> {
  const synthetic = one(flags, 'synthetic');
  if (synthetic !== undefined) {
    const count = Number(synthetic);
    if (!Number.isSafeInteger(count) || count < 1)
      throw new Error('--synthetic must be a positive integer');
    return {
      version: 'synthetic',
      tasks: Array.from({ length: count }, (_, index) => ({
        id: `synthetic-${String(index + 1).padStart(3, '0')}`,
        suite,
        repo: suite === 'swe-bench-verified' ? 'example/example' : null,
        baseCommit: suite === 'swe-bench-verified' ? 'a'.repeat(40) : null,
        statement: `Synthetic task ${index + 1}. It exists to exercise the harness.`,
        testCommand: null,
      })),
    };
  }
  if (suite === 'swe-bench-verified') {
    const dataset = await SweBenchDataset.read(required(flags, 'dataset'));
    return { tasks: dataset.rows.map((row) => row.task), version: dataset.version };
  }
  return {
    tasks: await terminalBenchTasks(required(flags, 'from')),
    version: 'terminal-bench-2.1',
  };
}

function pick(flags: Flags, all: PublicTask[], suite: SuiteId, idsFile?: string): PublicTask[] {
  if (idsFile) {
    const ids = (JSON.parse(idsFile) as { ids: string[] }).ids;
    const byId = new Map(all.map((task) => [task.id, task]));
    return ids.map((id) => {
      const task = byId.get(id);
      if (!task) throw new Error(`unknown task id: ${id}`);
      return task;
    });
  }
  const size = flags.has('size') ? number(flags, 'size') : all.length;
  return selectStratified(
    all,
    (task) => (suite === 'swe-bench-verified' ? (task.repo ?? '') : ''),
    size,
    one(flags, 'seed') ?? '1',
  );
}

async function selectCommand(
  argv: readonly string[],
  io: CloudEvalsCliDependencies,
): Promise<number> {
  const { flags } = parseFlags(argv);
  const suite = suiteOf(flags);
  const { tasks, version } = await loadTasks(flags, suite);
  const picked = pick(flags, tasks, suite);
  const body = `${JSON.stringify({ suite, version, seed: one(flags, 'seed') ?? '1', ids: picked.map((task) => task.id) }, null, 2)}\n`;
  const out = one(flags, 'out');
  if (out) await writeFile(resolve(out), body);
  else io.stdout(body);
  return 0;
}

async function makeSpecCommand(
  argv: readonly string[],
  io: CloudEvalsCliDependencies,
): Promise<number> {
  const { flags } = parseFlags(argv);
  const suite = suiteOf(flags);
  const { tasks, version } = await loadTasks(flags, suite);
  const idsPath = one(flags, 'ids-file');
  const picked = pick(
    flags,
    tasks,
    suite,
    idsPath ? await readFile(resolve(idsPath), 'utf8') : undefined,
  );
  const subjects = (one(flags, 'subjects') ?? SUBJECT_IDS.join(',')).split(',') as SubjectId[];
  for (const subject of subjects)
    if (!SUBJECT_IDS.includes(subject)) throw new Error(`unknown subject: ${subject}`);
  const mode = one(flags, 'mode') ?? 'dry-run';
  if (mode !== 'dry-run' && mode !== 'live') throw new Error('--mode must be dry-run or live');
  const spec = makeSpec({
    suite,
    tasks: picked,
    benchmarkVersion: version,
    subjects,
    repetitions: flags.has('repetitions') ? number(flags, 'repetitions') : 1,
    taskBudgetUsd: number(flags, 'task-budget-usd'),
    totalBudgetUsd: number(flags, 'total-budget-usd'),
    ...(flags.has('timeout-seconds') ? { timeoutSeconds: number(flags, 'timeout-seconds') } : {}),
    mode,
  });
  await writeFile(resolve(required(flags, 'out')), `${JSON.stringify(spec, null, 2)}\n`);
  io.stdout(`${JSON.stringify({ experimentId: spec.id, tasks: spec.tasks.length, mode })}\n`);
  return 0;
}

function dryRunDeps(spec: ExperimentSpec): EvalDeps {
  const drivers = new Map<string, SubjectDriver>(
    spec.subjects.map((subject) => [
      subject.id,
      new FakeDriver(subject.id, FAKE_PROFILES[subject.id] ?? FAKE_PROFILES['codex']),
    ]),
  );
  return { drivers, grader: new FakeGrader(), hidden: new FakeHiddenTests() };
}

async function runCommand(argv: readonly string[], io: CloudEvalsCliDependencies): Promise<number> {
  const { positional, flags } = parseFlags(argv, ['live']);
  const specPath = resolve(positional[0] ?? '');
  if (positional.length !== 1) throw new Error('run takes one spec path');
  const out = resolve(required(flags, 'out'));
  const spec = parseExperimentSpec(JSON.parse(await readFile(specPath, 'utf8')) as unknown);
  if (spec.executor.kind !== 'cloud') throw new Error('this spec is not for the cloud executor');
  const approvedRaw = one(flags, 'approve-budget');
  assertLiveApproved(spec, {
    live: flags.has('live'),
    approvedUsd: approvedRaw === undefined ? undefined : Number(approvedRaw),
  });
  const workRoot = await mkdtemp(join(tmpdir(), 'cloud-evals-'));
  let deps: EvalDeps | undefined;
  try {
    const live = spec.executor.config.mode === 'live';
    deps = live
      ? await (
          io.liveDeps ??
          ((given, root, stateDir) => createLiveDeps(given, root, process.env, { stateDir }))
        )(spec, workRoot, out)
      : dryRunDeps(spec);
    const budget = budgetOf(spec.budget);
    // Spend an earlier crashed process left in the journal is kept in the experiment directory
    // before the ledger starts, so no restart can forget it.
    const carried = await carrySpend(out, deps.recovered);
    const ledger = new BudgetLedger(
      budget.totalBudgetUsd,
      await priorSpentUsd(spec, join(out, 'attempts'), carried),
    );
    const { executor, subject } = createCloudEvals({
      mode: live ? 'live' : 'dry-run',
      drivers: deps.drivers,
      grader: deps.grader,
      hidden: deps.hidden,
      ledger,
      workRoot,
    });
    const cellArgs = (flags.get('cell') ?? []).flatMap((cell) => ['--cell', cell]);
    const code = await runMakaEvalCli(['run', specPath, '--out', out, ...cellArgs], {
      loadExecutor: () => executor,
      subjects: [subject],
      stdout: io.stdout,
      stderr: io.stderr,
      ...(io.signal ? { signal: io.signal } : {}),
    });
    await writeReport(spec, new FileAttemptStore(join(out, 'attempts')), join(out, 'report'));
    return code;
  } finally {
    // The gateway revokes every token it issued before the scratch directory goes.
    await deps?.close?.().catch(() => undefined);
    await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function reportCommand(
  argv: readonly string[],
  io: CloudEvalsCliDependencies,
): Promise<number> {
  const { positional } = parseFlags(argv);
  if (positional.length !== 1) throw new Error('report takes one experiment directory');
  const dir = resolve(positional[0] as string);
  const spec = parseExperimentSpec(
    JSON.parse(await readFile(join(dir, 'experiment.json'), 'utf8')) as unknown,
  );
  const summary = await writeReport(
    spec,
    new FileAttemptStore(join(dir, 'attempts')),
    join(dir, 'report'),
  );
  io.stdout(
    `${JSON.stringify({ experimentId: summary.experimentId, pairedCells: summary.pairedCells })}\n`,
  );
  return 0;
}

export async function runCloudEvalsCli(
  argv: readonly string[],
  overrides: Partial<CloudEvalsCliDependencies> = {},
): Promise<number> {
  const io: CloudEvalsCliDependencies = {
    stdout: overrides.stdout ?? process.stdout.write.bind(process.stdout),
    stderr: overrides.stderr ?? process.stderr.write.bind(process.stderr),
    ...(overrides.signal ? { signal: overrides.signal } : {}),
    ...(overrides.liveDeps ? { liveDeps: overrides.liveDeps } : {}),
  };
  try {
    const [command, ...rest] = argv;
    switch (command) {
      case 'select':
        return await selectCommand(rest, io);
      case 'make-spec':
        return await makeSpecCommand(rest, io);
      case 'run':
        return await runCommand(rest, io);
      case 'report':
        return await reportCommand(rest, io);
      default:
        throw new Error('unknown command');
    }
  } catch (error) {
    io.stderr(`cloud-evals: ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 2;
  }
}
