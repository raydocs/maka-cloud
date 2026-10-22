import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { UnrecordedSpend } from '@maka-cloud/gateway';
import { type ExperimentSpec, expandExperiment, FileAttemptStore } from '@maka/eval';
import { budgetOf } from './cloud.js';

/**
 * What earlier processes of a run spent through the model gateway, as their spend journal holds
 * it. `SqliteSpendJournal` has this shape.
 */
export interface RecoveredSpend {
  unrecorded(): UnrecordedSpend[];
  /** Forget what `unrecorded` returned, once it is kept elsewhere. */
  recorded(): void;
}

export const CARRIED_SPEND_FILE = 'carried-spend.json';

async function readCarried(path: string): Promise<Map<string, number>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(`${path} is not a map of task ids to dollars`);
  const carried = new Map<string, number>();
  for (const [taskId, usd] of Object.entries(parsed)) {
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0)
      throw new Error(`${path} has an invalid amount for ${taskId}`);
    carried.set(taskId, usd);
  }
  return carried;
}

async function writeDurably(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  const file = await open(temp, 'w');
  try {
    await file.writeFile(body);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
}

/**
 * Moves the journal's earlier-process spend into `carried-spend.json` in the experiment
 * directory, then tells the journal to forget it. The file is written and synced first, so a
 * crash between the two steps repeats the move (a task's amount is replaced, never added twice)
 * and no step can lose spend. Returns every amount carried so far, by gateway task id.
 */
export async function carrySpend(
  dir: string,
  recovered: RecoveredSpend | undefined,
): Promise<Map<string, number>> {
  const path = join(dir, CARRIED_SPEND_FILE);
  const carried = await readCarried(path);
  const fresh = recovered?.unrecorded() ?? [];
  if (recovered && fresh.length > 0) {
    // Rows are per task and attempt (an eval's grants have none, so one row each): a task's
    // attempts add up, and a task already carried keeps the larger figure.
    const perTask = new Map<string, number>();
    for (const { taskId, usd } of fresh) perTask.set(taskId, (perTask.get(taskId) ?? 0) + usd);
    for (const [taskId, usd] of perTask)
      carried.set(taskId, Math.max(carried.get(taskId) ?? 0, usd));
    await writeDurably(path, `${JSON.stringify(Object.fromEntries(carried), null, 2)}\n`);
  }
  recovered?.recorded();
  return carried;
}

/** The gateway task ids an attempt record names. */
function gatewayTaskIds(artifacts: readonly unknown[]): string[] {
  return artifacts.flatMap((artifact) => {
    const entry = artifact as { kind?: unknown; taskId?: unknown } | null;
    return entry?.kind === 'gateway' && typeof entry.taskId === 'string' ? [entry.taskId] : [];
  });
}

/**
 * Dollars an experiment has already spent, to start the budget ledger from. For each recorded
 * attempt, what the gateway's journal says it cost when the journal has it (the journal is what
 * the vendor was asked to bill), else its recorded cost, and its whole cap when it started and
 * reported none. Spend the journal holds for attempts that were never recorded (the process
 * died first) counts in full.
 */
export async function priorSpentUsd(
  spec: ExperimentSpec,
  attemptsDir: string,
  carried: ReadonlyMap<string, number> = new Map(),
): Promise<number> {
  const store = new FileAttemptStore(attemptsDir);
  const cap = budgetOf(spec.budget).taskBudgetUsd;
  const matched = new Set<string>();
  let spent = 0;
  for (const cell of expandExperiment(spec)) {
    for (const attempt of await store.list(cell.id)) {
      const { costUsd, status } = attempt.result;
      const journaled = gatewayTaskIds(attempt.result.artifacts ?? []).find((id) =>
        carried.has(id),
      );
      if (journaled !== undefined) {
        matched.add(journaled);
        spent += Math.max(carried.get(journaled) ?? 0, costUsd ?? 0);
        continue;
      }
      // An attempt that reported no cost but did real work is charged its cap.
      spent += costUsd ?? (status === 'infra_failed' ? 0 : cap);
    }
  }
  for (const [taskId, usd] of carried) if (!matched.has(taskId)) spent += usd;
  return spent;
}
