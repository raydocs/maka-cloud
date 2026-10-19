/** The model that may check finished work, as the operator configures it. Keys come from the environment, never from here. */
export interface VerifierPoolEntry {
  vendor: 'anthropic' | 'openai';
  model: string;
  /** Dollars per million tokens. The verification budget is worked out from these, so they are never guessed. */
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  maxInputChars: number;
  maxOutputTokens: number;
  baseUrl?: string;
}

export interface InboxConfig {
  /** Models of other vendors than the runner that did the work. Empty: only the checks that need no model run. */
  verifierModels: VerifierPoolEntry[];
  summaryModel: string;
  /** Default of the daily cap on model checks; the human can change it at run time. */
  dailyCapUsd: number;
}

export const DEFAULT_SUMMARY_MODEL = 'claude-haiku-5-5';
const DEFAULT_MAX_INPUT_CHARS = 200_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2_000;
const DEFAULT_DAILY_CAP_USD = 5;

const VENDORS = ['anthropic', 'openai'] as const;

/** Reads the inbox settings. Problems are appended to `problems`, so the caller reports all of them at once. */
export function readInboxConfig(
  value: (name: string) => string | undefined,
  problems: string[],
): InboxConfig {
  const config: InboxConfig = {
    verifierModels: [],
    summaryModel: value('MAKA_CLOUD_SUMMARY_MODEL') ?? DEFAULT_SUMMARY_MODEL,
    dailyCapUsd: DEFAULT_DAILY_CAP_USD,
  };
  const cap = value('MAKA_CLOUD_VERIFIER_DAILY_CAP_USD');
  if (cap !== undefined) {
    const parsed = Number(cap);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1000) {
      problems.push('MAKA_CLOUD_VERIFIER_DAILY_CAP_USD must be a number from 0 to 1000');
    } else {
      config.dailyCapUsd = parsed;
    }
  }
  const raw = value('MAKA_CLOUD_VERIFIER_MODELS');
  if (raw === undefined) return config;
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    problems.push('MAKA_CLOUD_VERIFIER_MODELS is not valid JSON');
    return config;
  }
  if (!Array.isArray(list)) {
    problems.push('MAKA_CLOUD_VERIFIER_MODELS must be a JSON array');
    return config;
  }
  for (const [index, entry] of list.entries()) {
    const parsed = parseEntry(entry, `MAKA_CLOUD_VERIFIER_MODELS[${index}]`, problems);
    if (!parsed) continue;
    if (parsed.vendor === 'openai' && value('OPENAI_API_KEY') === undefined) {
      problems.push(
        `MAKA_CLOUD_VERIFIER_MODELS[${index}] is an openai model but OPENAI_API_KEY is not set`,
      );
      continue;
    }
    config.verifierModels.push(parsed);
  }
  // The same key twice would make the pool order decide which model checks.
  const seen = new Set<string>();
  for (const entry of config.verifierModels) {
    const key = `${entry.vendor}:${entry.model}`;
    if (seen.has(key)) problems.push(`MAKA_CLOUD_VERIFIER_MODELS lists ${key} twice`);
    seen.add(key);
  }
  return config;
}

const ENTRY_KEYS = new Set([
  'vendor',
  'model',
  'inputPerMTokUsd',
  'outputPerMTokUsd',
  'maxInputChars',
  'maxOutputTokens',
  'baseUrl',
]);

function parseEntry(
  entry: unknown,
  where: string,
  problems: string[],
): VerifierPoolEntry | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    problems.push(`${where} must be an object`);
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  const before = problems.length;
  for (const key of Object.keys(record)) {
    if (!ENTRY_KEYS.has(key)) problems.push(`${where} has an unknown field ${key}`);
  }
  const vendor = record.vendor;
  if (!(VENDORS as readonly unknown[]).includes(vendor)) {
    problems.push(`${where}.vendor must be "anthropic" or "openai"`);
  }
  const model = record.model;
  if (typeof model !== 'string' || !/^[\w.:/-]{1,128}$/u.test(model)) {
    problems.push(`${where}.model must be a model id`);
  }
  const price = (name: 'inputPerMTokUsd' | 'outputPerMTokUsd'): number => {
    const found = record[name];
    if (typeof found !== 'number' || !Number.isFinite(found) || found < 0 || found > 1000) {
      problems.push(`${where}.${name} must be a number of dollars per million tokens`);
      return 0;
    }
    return found;
  };
  const count = (name: 'maxInputChars' | 'maxOutputTokens', fallback: number, max: number) => {
    const found = record[name];
    if (found === undefined) return fallback;
    if (typeof found !== 'number' || !Number.isInteger(found) || found < 1 || found > max) {
      problems.push(`${where}.${name} must be a whole number from 1 to ${max}`);
      return fallback;
    }
    return found;
  };
  const inputPerMTokUsd = price('inputPerMTokUsd');
  const outputPerMTokUsd = price('outputPerMTokUsd');
  const maxInputChars = count('maxInputChars', DEFAULT_MAX_INPUT_CHARS, 2_000_000);
  const maxOutputTokens = count('maxOutputTokens', DEFAULT_MAX_OUTPUT_TOKENS, 32_000);
  let baseUrl: string | undefined;
  if (record.baseUrl !== undefined) {
    baseUrl = typeof record.baseUrl === 'string' ? httpUrl(record.baseUrl) : undefined;
    if (baseUrl === undefined) problems.push(`${where}.baseUrl must be an http or https URL`);
  }
  if (problems.length > before) return undefined;
  return {
    vendor: vendor as VerifierPoolEntry['vendor'],
    model: model as string,
    inputPerMTokUsd,
    outputPerMTokUsd,
    maxInputChars,
    maxOutputTokens,
    ...(baseUrl === undefined ? {} : { baseUrl }),
  };
}

function httpUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    const ok = url.protocol === 'https:' || url.protocol === 'http:';
    return ok && url.username === '' && url.password === '' ? raw : undefined;
  } catch {
    return undefined;
  }
}
