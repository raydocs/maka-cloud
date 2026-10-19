import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { HiddenTests, HiddenTestSource, PublicTask } from './types.js';

/**
 * The repository's visible test command for the playbook's checks, by repository. It is an import
 * smoke test, not the repository's suite: a whole suite cannot finish inside a check's time limit
 * and would grade the environment instead of the change. The agent's own reproduction test is the
 * real check. A task can override it with `config.testCommand`. Nothing here comes from hidden tests.
 */
const SMOKE_MODULES: Readonly<Record<string, string>> = {
  'astropy/astropy': 'astropy',
  'django/django': 'django',
  'matplotlib/matplotlib': 'matplotlib',
  'mwaskom/seaborn': 'seaborn',
  'pallets/flask': 'flask',
  'psf/requests': 'requests',
  'pydata/xarray': 'xarray',
  'pylint-dev/pylint': 'pylint',
  'pytest-dev/pytest': 'pytest',
  'scikit-learn/scikit-learn': 'sklearn',
  'sphinx-doc/sphinx': 'sphinx',
  'sympy/sympy': 'sympy',
};

export function defaultTestCommand(repo: string): string {
  const module = SMOKE_MODULES[repo];
  return module ? `python -c "import ${module}"` : 'true';
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${where} is required`);
  return value;
}

function list(value: unknown, where: string): string[] {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string'))
    throw new Error(`${where} must be a list of strings`);
  return parsed as string[];
}

export interface SweBenchRow {
  task: PublicTask;
  hidden: HiddenTests;
  repo: string;
}

/**
 * A prepared SWE-bench Verified dataset (one JSON object per line, the published field names).
 * The public and the hidden halves are split here, once; only `load` hands out the hidden half.
 */
export class SweBenchDataset implements HiddenTestSource {
  private constructor(
    readonly rows: readonly SweBenchRow[],
    /** `sha256:` of the file, to pin the benchmark version in a spec. */
    readonly version: string,
  ) {}

  static async read(path: string): Promise<SweBenchDataset> {
    const raw = await readFile(path);
    const rows = raw
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line, index): SweBenchRow => {
        const where = `${path}:${index + 1}`;
        const row = JSON.parse(line) as Record<string, unknown>;
        const id = text(row.instance_id, `${where} instance_id`);
        const repo = text(row.repo, `${where} repo`);
        return {
          repo,
          task: {
            id,
            suite: 'swe-bench-verified',
            repo,
            baseCommit: text(row.base_commit, `${where} base_commit`),
            statement: text(row.problem_statement, `${where} problem_statement`),
            testCommand: null,
          },
          hidden: {
            suite: 'swe-bench-verified',
            testPatch: text(row.test_patch, `${where} test_patch`),
            failToPass: list(row.FAIL_TO_PASS, `${where} FAIL_TO_PASS`),
            passToPass: list(row.PASS_TO_PASS, `${where} PASS_TO_PASS`),
          },
        };
      });
    if (new Set(rows.map((row) => row.task.id)).size !== rows.length)
      throw new Error(`${path} has duplicate instance ids`);
    return new SweBenchDataset(
      rows,
      `sha256:${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`,
    );
  }

  async load(taskId: string): Promise<HiddenTests> {
    const row = this.rows.find((candidate) => candidate.task.id === taskId);
    if (!row) throw new Error(`no hidden tests for ${taskId}`);
    return row.hidden;
  }
}

function rank(seed: string, id: string): string {
  return createHash('sha256').update(`${seed}\u0000${id}`).digest('hex');
}

/**
 * Picks `size` items, spread over groups in proportion to their size (largest remainder), and
 * inside a group in an order fixed by `seed`. The same input always gives the same pick.
 */
export function selectStratified<T extends { id: string }>(
  items: readonly T[],
  group: (item: T) => string,
  size: number,
  seed: string,
): T[] {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('size must be a positive integer');
  if (size > items.length) throw new Error(`cannot pick ${size} of ${items.length} tasks`);
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = group(item);
    const members = groups.get(key);
    if (members) members.push(item);
    else groups.set(key, [item]);
  }
  const keys = [...groups.keys()].sort();
  const shares = keys.map((key) => {
    const exact = ((groups.get(key) as T[]).length * size) / items.length;
    return { key, count: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let left = size - shares.reduce((sum, share) => sum + share.count, 0);
  for (const share of [...shares].sort(
    (a, b) => b.remainder - a.remainder || (a.key < b.key ? -1 : 1),
  )) {
    if (left === 0) break;
    if (share.count < (groups.get(share.key) as T[]).length) {
      share.count += 1;
      left -= 1;
    }
  }
  const picked = shares.flatMap((share) =>
    [...(groups.get(share.key) as T[])]
      .sort((a, b) => (rank(seed, a.id) < rank(seed, b.id) ? -1 : 1))
      .slice(0, share.count),
  );
  return picked.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Terminal-Bench tasks as pinned in an existing experiment spec. */
export async function terminalBenchTasks(specPath: string): Promise<PublicTask[]> {
  const spec = JSON.parse(await readFile(specPath, 'utf8')) as {
    benchmark?: { id?: string };
    tasks?: { id: string; input: string }[];
  };
  if (!spec.benchmark?.id?.startsWith('terminal-bench') || !Array.isArray(spec.tasks))
    throw new Error(`${specPath} is not a Terminal-Bench experiment spec`);
  return spec.tasks.map((task) => ({
    id: task.id,
    suite: 'terminal-bench' as const,
    repo: null,
    baseCommit: null,
    statement: task.input,
    testCommand: null,
  }));
}
