import type { ModelRef } from './intake.js';
import { HeuristicJudge, ModelJudge, type JudgeClient, type ModelCompletion } from './router.js';
import type { RouterJudge } from './types.js';

export const DEFAULT_JUDGE_MODEL = 'claude-haiku-5-5';
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
/** Coder completions need more than the Router's 256. */
export const CODER_MAX_TOKENS = 4096;

/**
 * Same list prices as `@maka-cloud/gateway` `BUILT_IN_MODELS` for Haiku 5.5
 * (standard tier, 2026-10): $0.10 input / $0.50 output per million tokens.
 * Super-agent stays zod-only and does not depend on the gateway package.
 */
export const HAIKU_55_INPUT_PER_MTOK_USD = 0.1;
export const HAIKU_55_OUTPUT_PER_MTOK_USD = 0.5;

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
export function estimateUsdMicros(inputTokens: number, outputTokens: number): number {
  const usd =
    (inputTokens * HAIKU_55_INPUT_PER_MTOK_USD + outputTokens * HAIKU_55_OUTPUT_PER_MTOK_USD) /
    1_000_000;
  return Math.round(usd * 1_000_000);
}

export function parseMessagesUsage(
  body: unknown,
  model: string,
  wallMs: number,
): ModelCompletion['usage'] {
  const usage =
    typeof body === 'object' && body !== null && 'usage' in body
      ? (body as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage
      : undefined;
  const inputTokens = Number(usage?.input_tokens ?? 0);
  const outputTokens = Number(usage?.output_tokens ?? 0);
  const input = Number.isFinite(inputTokens) ? inputTokens : 0;
  const output = Number.isFinite(outputTokens) ? outputTokens : 0;
  return {
    inputTokens: input,
    outputTokens: output,
    tokens: input + output,
    usdMicros: estimateUsdMicros(input, output),
    wallMs,
    model,
  };
}

export class FetchJudgeClient implements JudgeClient {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
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
    return (await this.completeDetailed(prompt)).text;
  }

  async completeDetailed(prompt: string): Promise<ModelCompletion> {
    const started = Date.now();
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return {
      text: textOf(text),
      usage: parseMessagesUsage(parsed, this.model, Date.now() - started),
    };
  }
}

export class FakeJudgeClient implements JudgeClient {
  readonly prompts: string[] = [];
  constructor(
    private readonly reply:
      | string
      | ((prompt: string) => string) = '{"action":"ignore","reason":"fake"}',
  ) {}
  async complete(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return typeof this.reply === 'function' ? this.reply(prompt) : this.reply;
  }
  async completeDetailed(prompt: string): Promise<ModelCompletion> {
    const text = await this.complete(prompt);
    return {
      text,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        tokens: 0,
        usdMicros: 0,
        wallMs: 0,
        model: 'fake',
      },
    };
  }
}

export class FetchOpenAiJudgeClient implements JudgeClient {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FetchJudgeClientOptions) {
    if (!options.apiKey) throw new Error('FetchOpenAiJudgeClient requires an API key.');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com').replace(/\/+$/, '');
    this.model = options.model ?? 'gpt-4.1-mini';
    this.fetchImpl = options.fetch ?? fetch;
  }

  async complete(prompt: string): Promise<string> {
    return (await this.completeDetailed(prompt)).text;
  }

  async completeDetailed(prompt: string): Promise<ModelCompletion> {
    const started = Date.now();
    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Judge provider HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const message = openAiText(parsed) || text;
    return {
      text: message,
      usage: parseMessagesUsage(toAnthropicUsage(parsed), this.model, Date.now() - started),
    };
  }
}

export function routerModelRefFromEnv(env: NodeJS.ProcessEnv = process.env): ModelRef {
  const provider = (env.MAKA_CLOUD_ROUTER_PROVIDER ?? 'anthropic').trim().toLowerCase();
  return {
    provider:
      provider === 'openai' || provider === 'gateway' || provider === 'fake' ? provider : 'anthropic',
    model:
      env.MAKA_CLOUD_ROUTER_MODEL?.trim() ||
      env.MAKA_CLOUD_JUDGE_MODEL?.trim() ||
      env.MAKA_CLOUD_SUMMARY_MODEL?.trim() ||
      DEFAULT_JUDGE_MODEL,
    ...(env.MAKA_CLOUD_ROUTER_BASE_URL?.trim() ||
    env.MAKA_CLOUD_JUDGE_BASE_URL?.trim() ||
    env.ANTHROPIC_BASE_URL?.trim()
      ? {
          baseUrl: (
            env.MAKA_CLOUD_ROUTER_BASE_URL?.trim() ||
            env.MAKA_CLOUD_JUDGE_BASE_URL?.trim() ||
            env.ANTHROPIC_BASE_URL?.trim() ||
            ''
          ).replace(/\/+$/, ''),
        }
      : {}),
    apiKeyEnv: env.MAKA_CLOUD_ROUTER_API_KEY
      ? 'MAKA_CLOUD_ROUTER_API_KEY'
      : env.MAKA_CLOUD_JUDGE_API_KEY
        ? 'MAKA_CLOUD_JUDGE_API_KEY'
        : 'ANTHROPIC_API_KEY',
  };
}

export function workerModelRefFromEnv(env: NodeJS.ProcessEnv = process.env): ModelRef {
  return {
    provider: (env.MAKA_CLOUD_WORKER_PROVIDER ?? 'anthropic').trim().toLowerCase() === 'openai'
      ? 'openai'
      : 'anthropic',
    model: env.MAKA_CLOUD_WORKER_MODEL?.trim() || env.MAKA_CLOUD_LOOP_MODEL?.trim() || 'claude-opus-4-6',
    ...(env.MAKA_CLOUD_WORKER_BASE_URL?.trim()
      ? { baseUrl: env.MAKA_CLOUD_WORKER_BASE_URL.trim().replace(/\/+$/, '') }
      : {}),
    apiKeyEnv: env.MAKA_CLOUD_WORKER_API_KEY ? 'MAKA_CLOUD_WORKER_API_KEY' : 'ANTHROPIC_API_KEY',
  };
}

export function createJudgeClientFromRef(
  ref: ModelRef,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  extras: { maxTokens?: number } = {},
): JudgeClient {
  if (ref.provider === 'fake') return new FakeJudgeClient();
  const keyName = ref.apiKeyEnv ?? (ref.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY');
  const apiKey = env[keyName]?.trim() || '';
  if (!apiKey) {
    throw new Error(`Router model needs ${keyName}. Put the key in the environment, not in config.`);
  }
  if (ref.provider === 'openai') {
    return new FetchOpenAiJudgeClient({
      apiKey,
      baseUrl: ref.baseUrl,
      model: ref.model,
      fetch: fetchImpl,
    });
  }
  return new FetchJudgeClient({
    apiKey,
    baseUrl: ref.baseUrl,
    model: ref.model,
    fetch: fetchImpl,
    ...(extras.maxTokens !== undefined ? { maxTokens: extras.maxTokens } : {}),
  });
}

export function createJudgeClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  extras: { maxTokens?: number } = {},
): JudgeClient {
  const ref = routerModelRefFromEnv(env);
  if (ref.provider === 'fake') return new FakeJudgeClient();
  const apiKey =
    env.MAKA_CLOUD_ROUTER_API_KEY?.trim() ||
    env.MAKA_CLOUD_JUDGE_API_KEY?.trim() ||
    env.ANTHROPIC_API_KEY?.trim() ||
    '';
  if (!apiKey) {
    throw new Error(
      'ModelJudge needs MAKA_CLOUD_ROUTER_API_KEY, MAKA_CLOUD_JUDGE_API_KEY or ANTHROPIC_API_KEY. HeuristicJudge stays the default; set MAKA_CLOUD_SUPERAGENT_JUDGE=model only when a key is present.',
    );
  }
  const baseUrl = (
    env.MAKA_CLOUD_ROUTER_BASE_URL?.trim() ||
    env.MAKA_CLOUD_JUDGE_BASE_URL?.trim() ||
    env.ANTHROPIC_BASE_URL?.trim() ||
    DEFAULT_ANTHROPIC_BASE_URL
  ).replace(/\/+$/, '');
  const model =
    env.MAKA_CLOUD_ROUTER_MODEL?.trim() ||
    env.MAKA_CLOUD_JUDGE_MODEL?.trim() ||
    env.MAKA_CLOUD_SUMMARY_MODEL?.trim() ||
    DEFAULT_JUDGE_MODEL;
  if (ref.provider === 'openai') {
    return new FetchOpenAiJudgeClient({ apiKey, baseUrl, model, fetch: fetchImpl });
  }
  return new FetchJudgeClient({
    apiKey,
    baseUrl,
    model,
    fetch: fetchImpl,
    ...(extras.maxTokens !== undefined ? { maxTokens: extras.maxTokens } : {}),
  });
}

/**
 * Default is heuristic when no key is set. With a key (and no override)
 * ModelJudge runs with the heuristic as a prefilter. `=heuristic` / `=model`
 * force one or the other.
 */
export function createJudgeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): RouterJudge {
  const kind = (env.MAKA_CLOUD_SUPERAGENT_JUDGE ?? '').trim().toLowerCase();
  const hasKey = Boolean(
    env.MAKA_CLOUD_ROUTER_API_KEY?.trim() ||
      env.MAKA_CLOUD_JUDGE_API_KEY?.trim() ||
      env.ANTHROPIC_API_KEY?.trim(),
  );
  if (kind === 'heuristic' || (kind === '' && !hasKey)) return new HeuristicJudge();
  if (kind === 'model') return new ModelJudge(createJudgeClientFromEnv(env, fetchImpl));
  if (kind === '' || kind === 'prefilter') {
    if (!hasKey) return new HeuristicJudge();
    return new ModelJudge(createJudgeClientFromEnv(env, fetchImpl), new HeuristicJudge(), {
      prefilter: true,
    });
  }
  throw new Error(
    `MAKA_CLOUD_SUPERAGENT_JUDGE must be heuristic, prefilter or model, not ${kind}.`,
  );
}

function openAiText(body: unknown): string {
  if (typeof body !== 'object' || body === null || !('choices' in body)) return '';
  const choices = (body as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
  const content = choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

function toAnthropicUsage(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || !('usage' in body)) return body;
  const usage = (body as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
  return {
    usage: {
      input_tokens: usage?.prompt_tokens,
      output_tokens: usage?.completion_tokens,
    },
  };
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
