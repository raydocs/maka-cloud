import type { ExecutorUsage } from './executor.js';
import type { Mandate, Usage } from './types.js';

/**
 * Per-Assignment budget (efficiency.md §3): what is left of the Mandate's
 * budgets after the worker's earlier runs. At 80% the executor is told to
 * wrap up; at 100% it is stopped and the Ticket waits on a person.
 */
export interface AssignmentBudget {
  tokens?: number;
  usdMicros?: number;
  wallMs?: number;
  turns?: number;
}

export const WRAP_UP_AT = 0.8;

export const WRAP_UP_TEXT =
  'Budget notice: about 80% of this Assignment is used. Finish the smallest safe change now, run the tests once, and end with the status line. Do not start new work.';

export type BudgetLevel = 'ok' | 'wrap-up' | 'stop';

export interface BudgetCheck {
  level: BudgetLevel;
  /** e.g. `tokens 820/1000`. Empty when `ok`. */
  reason: string;
}

/** Remaining budget for one run. `spentTurns` is what earlier runs of the session used. */
export function assignmentBudget(
  mandate: Mandate | undefined,
  spent: Partial<Usage> | undefined,
  spentTurns = 0,
): AssignmentBudget {
  const budgets = mandate?.budgets;
  if (!budgets) return {};
  const left = (cap: number | undefined, used: number | undefined) =>
    cap === undefined ? undefined : Math.max(0, cap - (used ?? 0));
  const out: AssignmentBudget = {};
  const tokens = left(budgets.tokens, spent?.tokens);
  const usdMicros = left(
    budgets.usd === undefined ? undefined : Math.round(budgets.usd * 1_000_000),
    spent?.usdMicros,
  );
  const wallMs = left(budgets.wallMs, spent?.wallMs);
  const turns = left(budgets.turns, spentTurns);
  if (tokens !== undefined) out.tokens = tokens;
  if (usdMicros !== undefined) out.usdMicros = usdMicros;
  if (wallMs !== undefined) out.wallMs = wallMs;
  if (turns !== undefined) out.turns = turns;
  return out;
}

export function executorTokens(usage: ExecutorUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** Checks one run's usage against its budget. The worst dimension wins. */
export function checkBudget(
  budget: AssignmentBudget,
  usage: ExecutorUsage,
  elapsedMs: number,
  wrapUpAt = WRAP_UP_AT,
): BudgetCheck {
  const dims: Array<[string, number, number | undefined]> = [
    ['tokens', executorTokens(usage), budget.tokens],
    ['usd_micros', usage.usdMicros, budget.usdMicros],
    ['wall_ms', Math.max(elapsedMs, usage.wallMs), budget.wallMs],
    ['turns', usage.turns, budget.turns],
  ];
  let wrap = '';
  for (const [name, used, cap] of dims) {
    if (cap === undefined) continue;
    if (used >= cap) return { level: 'stop', reason: `${name} ${used}/${cap}` };
    if (!wrap && used >= cap * wrapUpAt) wrap = `${name} ${used}/${cap}`;
  }
  return wrap ? { level: 'wrap-up', reason: wrap } : { level: 'ok', reason: '' };
}

/** List prices per million tokens, as `@maka-cloud/gateway` BUILT_IN_MODELS (2026-10). */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'gpt-6.1-sol': { input: 2, output: 10, cacheRead: 0.1 },
};

/** Cache writes cost 1.25× input (five-minute cache). Unknown models price at Opus. */
export function estimateUsdMicros(
  model: string | undefined,
  usage: Partial<ExecutorUsage>,
): number {
  const key = Object.keys(PRICES).find((name) => model?.startsWith(name));
  const price = PRICES[key ?? 'claude-opus-5-5'] as Price;
  const usd =
    ((usage.inputTokens ?? 0) * price.input +
      (usage.outputTokens ?? 0) * price.output +
      (usage.cacheReadTokens ?? 0) * price.cacheRead +
      (usage.cacheWriteTokens ?? 0) * price.input * 1.25) /
    1_000_000;
  return Math.round(usd * 1_000_000);
}

export function budgetReport(input: {
  reason: string;
  usage: ExecutorUsage;
  progress: readonly string[];
  changed: readonly string[];
}): string {
  const last = input.progress.slice(-3).map((line) => `- ${line.slice(0, 160)}`);
  return [
    `Stopped at 100% of the Assignment budget (${input.reason}).`,
    `Used this run: tokens=${executorTokens(input.usage)} usd=${(input.usage.usdMicros / 1_000_000).toFixed(4)} turns=${input.usage.turns}.`,
    `Changed files: ${input.changed.join(', ') || '(none)'}.`,
    ...(last.length ? ['Last progress:', ...last] : []),
  ].join('\n');
}
