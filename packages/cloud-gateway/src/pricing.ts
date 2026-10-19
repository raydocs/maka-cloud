export type Vendor = 'anthropic' | 'openai';

export const VENDORS: readonly Vendor[] = ['anthropic', 'openai'];

/** Prices of one model, in dollars per million tokens. */
export interface ModelPrice {
  vendor: Vendor;
  /** The model id as the request names it. */
  model: string;
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  /** Cached input read back. Default: the input price. */
  cacheReadPerMTokUsd?: number;
  /** The most output tokens one request may ask for. */
  maxOutputTokens: number;
  /** A higher tier for the whole request once its input passes `aboveInputTokens`. */
  longContext?: { aboveInputTokens: number; inputPerMTokUsd: number; outputPerMTokUsd: number };
}

/**
 * Anthropic list prices (Claude API, standard speed and tier) as of 2026-10. Configuration
 * replaces an entry by model id; OpenAI models are configuration only.
 */
export const BUILT_IN_MODELS: readonly ModelPrice[] = [
  {
    vendor: 'anthropic',
    model: 'claude-opus-5-5',
    inputPerMTokUsd: 4,
    outputPerMTokUsd: 20,
    cacheReadPerMTokUsd: 0.2,
    maxOutputTokens: 128_000,
  },
  {
    vendor: 'anthropic',
    model: 'claude-sonnet-5-5',
    inputPerMTokUsd: 2,
    outputPerMTokUsd: 10,
    cacheReadPerMTokUsd: 0.2,
    maxOutputTokens: 128_000,
  },
  {
    vendor: 'anthropic',
    model: 'claude-haiku-5-5',
    inputPerMTokUsd: 0.1,
    outputPerMTokUsd: 0.5,
    cacheReadPerMTokUsd: 0.01,
    maxOutputTokens: 128_000,
    longContext: { aboveInputTokens: 100_000, inputPerMTokUsd: 0.5, outputPerMTokUsd: 2.5 },
  },
];

/** Cache writes cost this multiple of the input price: five minutes, one hour. */
export const CACHE_WRITE_5M = 1.25;
export const CACHE_WRITE_1H = 2;

/** Token counts as the vendor reported them. `input` excludes cached and cache-written tokens. */
export interface Usage {
  input: number;
  cacheRead: number;
  /** Written to the five-minute cache. */
  cacheWrite5m: number;
  /** Written to the one-hour cache. */
  cacheWrite1h: number;
  output: number;
}

export function emptyUsage(): Usage {
  return { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 };
}

export function inputTokensOf(usage: Usage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;
}

function tier(
  price: ModelPrice,
  inputTokens: number,
): { input: number; output: number; scale: number } {
  const long = price.longContext;
  if (long && inputTokens > long.aboveInputTokens) {
    return {
      input: long.inputPerMTokUsd,
      output: long.outputPerMTokUsd,
      scale: price.inputPerMTokUsd > 0 ? long.inputPerMTokUsd / price.inputPerMTokUsd : 1,
    };
  }
  return { input: price.inputPerMTokUsd, output: price.outputPerMTokUsd, scale: 1 };
}

/** Dollars for reported usage, at the tier its input falls in. */
export function costUsd(price: ModelPrice, usage: Usage): number {
  const rates = tier(price, inputTokensOf(usage));
  const cacheRead = (price.cacheReadPerMTokUsd ?? price.inputPerMTokUsd) * rates.scale;
  return (
    (usage.input * rates.input +
      usage.cacheRead * cacheRead +
      usage.cacheWrite5m * rates.input * CACHE_WRITE_5M +
      usage.cacheWrite1h * rates.input * CACHE_WRITE_1H +
      usage.output * rates.output) /
    1_000_000
  );
}

/**
 * The most a request can cost: every input token at the dearest input rate it could be billed
 * at (a cache write, which Anthropic bills above plain input), the output cap in full, and the
 * long-context tier when the input bound passes its threshold.
 */
export function worstCaseUsd(
  price: ModelPrice,
  bound: { inputTokens: number; outputTokens: number; inputMultiplier: number },
): number {
  const rates = tier(price, bound.inputTokens);
  return (
    (bound.inputTokens * rates.input * bound.inputMultiplier + bound.outputTokens * rates.output) /
    1_000_000
  );
}

/** The model table: built-in entries, replaced and extended by configuration. */
export function modelTable(configured: readonly ModelPrice[] = []): Map<string, ModelPrice> {
  const table = new Map<string, ModelPrice>();
  for (const entry of [...BUILT_IN_MODELS, ...configured]) {
    table.set(`${entry.vendor}:${entry.model}`, entry);
  }
  return table;
}

/** Why a configured entry cannot be used, or undefined. */
export function priceProblem(entry: ModelPrice): string | undefined {
  const finite = (value: unknown): boolean =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (entry.vendor !== 'anthropic' && entry.vendor !== 'openai')
    return 'vendor must be anthropic or openai';
  if (typeof entry.model !== 'string' || entry.model.trim() === '')
    return 'model must be a model id';
  if (!finite(entry.inputPerMTokUsd) || !finite(entry.outputPerMTokUsd)) {
    return 'inputPerMTokUsd and outputPerMTokUsd must be numbers of at least 0';
  }
  if (entry.cacheReadPerMTokUsd !== undefined && !finite(entry.cacheReadPerMTokUsd)) {
    return 'cacheReadPerMTokUsd must be a number of at least 0';
  }
  if (!Number.isInteger(entry.maxOutputTokens) || entry.maxOutputTokens < 1) {
    return 'maxOutputTokens must be a positive whole number';
  }
  const long = entry.longContext;
  if (long !== undefined) {
    if (
      !Number.isInteger(long.aboveInputTokens) ||
      long.aboveInputTokens < 1 ||
      !finite(long.inputPerMTokUsd) ||
      !finite(long.outputPerMTokUsd)
    ) {
      return 'longContext needs aboveInputTokens, inputPerMTokUsd and outputPerMTokUsd';
    }
  }
  return undefined;
}
