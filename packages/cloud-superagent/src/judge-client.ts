import { HeuristicJudge, ModelJudge, type JudgeClient } from './router.js';
import type { RouterJudge } from './types.js';

export const DEFAULT_JUDGE_MODEL = 'claude-haiku-5-5';
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

export interface FetchJudgeClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
  maxTokens?: number;
}

/**
 * Anthropic Messages API client — the same `/v1/messages` + `x-api-key` +
 * `anthropic-version` path the host gateway and runtime already use.
 * Point `baseUrl` at `ANTHROPIC_BASE_URL` or at the gateway's `/anthropic` prefix.
 */
export class FetchJudgeClient implements JudgeClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxTokens: number;

  constructor(options: FetchJudgeClientOptions) {
    if (!options.apiKey) throw new Error('FetchJudgeClient requires an API key.');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, '');
    this.model = options.model ?? DEFAULT_JUDGE_MODEL;
    this.fetchImpl = options.fetch ?? fetch;
    this.maxTokens = options.maxTokens ?? 256;
  }

  async complete(prompt: string): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Judge provider HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    return textOf(text);
  }
}

export function createJudgeClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): JudgeClient {
  const apiKey = env.MAKA_CLOUD_JUDGE_API_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim() || '';
  if (!apiKey) {
    throw new Error(
      'ModelJudge needs MAKA_CLOUD_JUDGE_API_KEY or ANTHROPIC_API_KEY. HeuristicJudge stays the default; set MAKA_CLOUD_SUPERAGENT_JUDGE=model only when a key is present.',
    );
  }
  const baseUrl = (
    env.MAKA_CLOUD_JUDGE_BASE_URL?.trim() ||
    env.ANTHROPIC_BASE_URL?.trim() ||
    DEFAULT_ANTHROPIC_BASE_URL
  ).replace(/\/+$/, '');
  const model =
    env.MAKA_CLOUD_JUDGE_MODEL?.trim() ||
    env.MAKA_CLOUD_SUMMARY_MODEL?.trim() ||
    DEFAULT_JUDGE_MODEL;
  return new FetchJudgeClient({ apiKey, baseUrl, model, fetch: fetchImpl });
}

/** Heuristic stays the default. `MAKA_CLOUD_SUPERAGENT_JUDGE=model` wires FetchJudgeClient. */
export function createJudgeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): RouterJudge {
  const kind = (env.MAKA_CLOUD_SUPERAGENT_JUDGE ?? 'heuristic').trim().toLowerCase();
  if (kind === '' || kind === 'heuristic') return new HeuristicJudge();
  if (kind === 'model') return new ModelJudge(createJudgeClientFromEnv(env, fetchImpl));
  throw new Error(`MAKA_CLOUD_SUPERAGENT_JUDGE must be heuristic or model, not ${kind}.`);
}

function textOf(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (typeof parsed !== 'object' || parsed === null || !('content' in parsed)) return raw;
  const content = (parsed as { content: unknown }).content;
  if (!Array.isArray(content)) return raw;
  const texts: string[] = [];
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      'type' in block &&
      (block as { type: unknown }).type === 'text' &&
      'text' in block &&
      typeof (block as { text: unknown }).text === 'string'
    ) {
      texts.push((block as { text: string }).text);
    }
  }
  return texts.join('') || raw;
}
