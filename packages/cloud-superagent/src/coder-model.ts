import { DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_JUDGE_MODEL } from './judge-client.js';
import type { ContentBlock } from './prompt-cache.js';

const ANTHROPIC_VERSION = '2023-06-01';

export interface LoopUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LoopModelTurn {
  /** Assistant content blocks exactly as the provider streamed them (thinking included). */
  content: ContentBlock[];
  stopReason: string;
  usage: LoopUsage;
  model: string;
  wallMs: number;
  /** `tool_use` ids whose streamed input was not valid JSON. */
  invalidToolInputs?: string[];
}

/** One Messages request of a tool loop. `onEvent` fires on every streamed token or block. */
export interface LoopModel {
  readonly model: string;
  readonly endpoint: string;
  next(
    body: Record<string, unknown>,
    options?: { signal?: AbortSignal; onEvent?: () => void },
  ): Promise<LoopModelTurn>;
}

/** No tokens for `streamSilenceMs`; the stream was dropped. Retry the same request. */
export class StreamSilenceError extends Error {
  override readonly name = 'StreamSilenceError';
}

export class LoopProviderError extends Error {
  override readonly name = 'LoopProviderError';
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/**
 * Standard-tier list prices per million tokens (2026-10). Cache writes are the
 * 5-minute TTL (1.25x input). Haiku 5.5 doubles above 100K prompt tokens; the
 * coder loop stays far below that. Unknown models price as Haiku 5.5, like
 * `estimateUsdMicros`.
 */
export const LOOP_PRICES: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

export function loopUsdMicros(model: string, usage: LoopUsage): number {
  const price = LOOP_PRICES[model] ?? LOOP_PRICES[DEFAULT_JUDGE_MODEL];
  if (!price) return 0;
  const usd =
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite) /
    1_000_000;
  return Math.round(usd * 1_000_000);
}

export interface AnthropicLoopModelOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
  /** Drop the stream after this long without a token. */
  streamSilenceMs?: number;
}

/**
 * Streaming Anthropic Messages client for the coder tool loop. Same
 * `/v1/messages` + `x-api-key` path as `FetchJudgeClient`; the key stays on the
 * host. Silence is measured between streamed events (pings do not count).
 */
export class AnthropicLoopModel implements LoopModel {
  readonly model: string;
  readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly streamSilenceMs: number;

  constructor(options: AnthropicLoopModelOptions) {
    if (!options.apiKey) throw new Error('AnthropicLoopModel requires an API key.');
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_JUDGE_MODEL;
    this.endpoint = `${(options.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, '')}/v1/messages`;
    this.fetchImpl = options.fetch ?? fetch;
    this.streamSilenceMs = options.streamSilenceMs ?? 4 * 60_000;
  }

  async next(
    body: Record<string, unknown>,
    options: { signal?: AbortSignal; onEvent?: () => void } = {},
  ): Promise<LoopModelTurn> {
    const started = Date.now();
    const ac = new AbortController();
    let silent = false;
    const onOuterAbort = () => ac.abort();
    options.signal?.addEventListener('abort', onOuterAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        silent = true;
        ac.abort();
      }, this.streamSilenceMs);
    };
    try {
      arm();
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify({ ...body, model: this.model, stream: true }),
          signal: ac.signal,
        });
      } catch (error) {
        if (silent) throw new StreamSilenceError('no response before the silence limit');
        throw new LoopProviderError(
          `provider request failed: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          !options.signal?.aborted,
        );
      }
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '');
        throw new LoopProviderError(
          `provider HTTP ${response.status}: ${text.slice(0, 200)}`,
          response.status,
          response.status === 429 || response.status >= 500,
        );
      }
      const parsed = new StreamAccumulator();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut = buffer.indexOf('\n\n');
          while (cut >= 0) {
            const raw = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            if (parsed.push(raw)) {
              arm();
              options.onEvent?.();
            }
            cut = buffer.indexOf('\n\n');
          }
        }
      } catch (error) {
        if (silent) throw new StreamSilenceError('stream went silent');
        if (error instanceof LoopProviderError) throw error;
        throw new LoopProviderError(
          `stream broke: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          !options.signal?.aborted,
        );
      }
      if (buffer.trim()) parsed.push(buffer);
      if (!parsed.stopped) {
        throw new LoopProviderError('stream ended before message_stop', undefined, true);
      }
      return parsed.result(this.model, Date.now() - started);
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}

/** Builds assistant blocks from Messages SSE events. Exported for tests. */
export class StreamAccumulator {
  stopped = false;
  private readonly blocks: Array<ContentBlock & { _json?: string }> = [];
  private readonly invalid: string[] = [];
  private stopReason = 'end_turn';
  private model = '';
  private readonly usage: LoopUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  /** Returns true when the event carried model progress (not a ping). */
  push(raw: string): boolean {
    let type = '';
    const data: string[] = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (data.length === 0) return false;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data.join('\n')) as Record<string, unknown>;
    } catch {
      return false;
    }
    type = type || String(event.type ?? '');
    if (type === 'ping') return false;
    if (type === 'error') {
      const error = (event.error ?? {}) as { type?: string; message?: string };
      throw new LoopProviderError(
        `provider stream error ${error.type ?? ''}: ${error.message ?? ''}`.trim(),
        undefined,
        error.type === 'overloaded_error' || error.type === 'api_error',
      );
    }
    if (type === 'message_start') {
      const message = (event.message ?? {}) as { model?: string; usage?: Record<string, unknown> };
      this.model = message.model ?? '';
      this.addUsage(message.usage);
      return true;
    }
    if (type === 'content_block_start') {
      const index = Number(event.index ?? this.blocks.length);
      const block = { ...((event.content_block ?? {}) as ContentBlock) };
      if (block.type === 'tool_use' || block.type === 'server_tool_use') block._json = '';
      this.blocks[index] = block;
      return true;
    }
    if (type === 'content_block_delta') {
      const block = this.blocks[Number(event.index ?? -1)];
      const delta = (event.delta ?? {}) as Record<string, unknown>;
      if (!block) return true;
      if (delta.type === 'text_delta') block.text = `${block.text ?? ''}${delta.text ?? ''}`;
      else if (delta.type === 'input_json_delta') {
        block._json = `${block._json ?? ''}${delta.partial_json ?? ''}`;
      } else if (delta.type === 'thinking_delta') {
        block.thinking = `${block.thinking ?? ''}${delta.thinking ?? ''}`;
      } else if (delta.type === 'signature_delta') block.signature = delta.signature;
      return true;
    }
    if (type === 'content_block_stop') {
      const block = this.blocks[Number(event.index ?? -1)];
      if (block && block._json !== undefined) {
        const json = block._json.trim();
        try {
          block.input = json ? JSON.parse(json) : {};
        } catch {
          block.input = {};
          if (typeof block.id === 'string') this.invalid.push(block.id);
        }
        delete block._json;
      }
      return true;
    }
    if (type === 'message_delta') {
      const delta = (event.delta ?? {}) as { stop_reason?: string };
      if (delta.stop_reason) this.stopReason = delta.stop_reason;
      const usage = (event.usage ?? {}) as Record<string, unknown>;
      const output = Number(usage.output_tokens);
      if (Number.isFinite(output)) this.usage.outputTokens = output;
      return true;
    }
    if (type === 'message_stop') {
      this.stopped = true;
      return true;
    }
    return false;
  }

  result(fallbackModel: string, wallMs: number): LoopModelTurn {
    return {
      content: this.blocks.filter(Boolean).map((block) => {
        const { _json: _drop, ...rest } = block;
        return rest;
      }),
      stopReason: this.stopReason,
      usage: { ...this.usage },
      model: this.model || fallbackModel,
      wallMs,
      ...(this.invalid.length > 0 ? { invalidToolInputs: [...this.invalid] } : {}),
    };
  }

  private addUsage(usage: Record<string, unknown> | undefined): void {
    if (!usage) return;
    const read = (key: string) => {
      const value = Number(usage[key] ?? 0);
      return Number.isFinite(value) ? value : 0;
    };
    this.usage.inputTokens += read('input_tokens');
    this.usage.outputTokens += read('output_tokens');
    this.usage.cacheReadTokens += read('cache_read_input_tokens');
    this.usage.cacheWriteTokens += read('cache_creation_input_tokens');
  }
}

export type FakeLoopStep =
  | LoopModelTurn
  | ((body: Record<string, unknown>) => LoopModelTurn)
  | { hang: true }
  | { error: LoopProviderError };

/**
 * Scripted model for tests. Records every request body. A `hang` step waits
 * for the caller's abort (the loop's silence timer); `error` throws.
 */
export class FakeLoopModel implements LoopModel {
  readonly bodies: Array<Record<string, unknown>> = [];
  readonly endpoint = 'fake://loop-model';
  private readonly steps: FakeLoopStep[];
  private index = 0;

  constructor(
    steps: FakeLoopStep[],
    readonly model = 'claude-haiku-5-5',
    private readonly fallback: (body: Record<string, unknown>) => LoopModelTurn = () =>
      textTurn('done'),
  ) {
    this.steps = [...steps];
  }

  get calls(): number {
    return this.bodies.length;
  }

  async next(
    body: Record<string, unknown>,
    options: { signal?: AbortSignal; onEvent?: () => void } = {},
  ): Promise<LoopModelTurn> {
    this.bodies.push(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
    const step = this.steps[this.index] ?? this.fallback;
    this.index += 1;
    if ('hang' in step) {
      return new Promise((_resolve, reject) => {
        const onAbort = () => reject(new StreamSilenceError('fake stream went silent'));
        if (options.signal?.aborted) onAbort();
        else options.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if ('error' in step) throw step.error;
    options.onEvent?.();
    return typeof step === 'function' ? step(body) : step;
  }
}

export function textTurn(text: string, usage: Partial<LoopUsage> = {}): LoopModelTurn {
  return {
    content: text ? [{ type: 'text', text }] : [],
    stopReason: 'end_turn',
    usage: { ...ZERO_USAGE, ...usage },
    model: 'claude-haiku-5-5',
    wallMs: 1,
  };
}

let fakeToolSeq = 0;

export function toolTurn(
  calls: Array<{ name: string; input: Record<string, unknown>; id?: string }>,
  usage: Partial<LoopUsage> = {},
  text = '',
): LoopModelTurn {
  return {
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      ...calls.map((call, i) => ({
        type: 'tool_use',
        id: call.id ?? `toolu_fake_${(fakeToolSeq += 1)}_${i}`,
        name: call.name,
        input: call.input,
      })),
    ],
    stopReason: 'tool_use',
    usage: { ...ZERO_USAGE, ...usage },
    model: 'claude-haiku-5-5',
    wallMs: 1,
  };
}

const ZERO_USAGE: LoopUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
