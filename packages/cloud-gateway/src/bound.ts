import type { ModelPrice, Vendor } from './pricing.js';
import { CACHE_WRITE_1H, CACHE_WRITE_5M } from './pricing.js';

/** The constants the worst-case bound adds to what the body shows. */
export interface BoundLimits {
  /** Tokens added to every request for what the vendor adds and the body does not show. */
  requestOverheadTokens: number;
  /** Tokens assumed for each image, whatever its size in bytes. */
  imageTokens: number;
  /** Added to a vendor's token count, as a fraction of it: the count is an estimate. */
  countMargin: number;
}

export const DEFAULT_BOUND_LIMITS: BoundLimits = {
  requestOverheadTokens: 4_000,
  imageTokens: 10_000,
  countMargin: 0.1,
};

export type Bounded =
  | { ok: false; reason: string }
  | {
      ok: true;
      price: ModelPrice;
      /** The body to send: the caller's bytes, or a copy with the output cap set. */
      body: Uint8Array;
      /** The input bound from the body's size. */
      inputTokens: number;
      outputTokens: number;
      /** The dearest rate an input token can be billed at, as a multiple of the input price. */
      inputMultiplier: number;
      /** The size cannot bound the input (a document, an image by reference): count it first. */
      mustCount: boolean;
      /** The request asks for a one-hour cache. */
      oneHourCache: boolean;
      stream: boolean;
    };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const ANTHROPIC_FIELDS = new Set([
  'model',
  'messages',
  'system',
  'max_tokens',
  'metadata',
  'stop_sequences',
  'stream',
  'temperature',
  'top_p',
  'top_k',
  'tools',
  'tool_choice',
  'thinking',
  'output_config',
  'cache_control',
  'context_management',
  'service_tier',
]);

const OPENAI_FIELDS = new Set([
  'model',
  'input',
  'instructions',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'reasoning',
  'store',
  'stream',
  'stream_options',
  'include',
  'prompt_cache_key',
  'text',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'temperature',
  'top_p',
  'truncation',
  'service_tier',
  'user',
  'safety_identifier',
]);

/** OpenAI tools the caller runs itself. Hosted tools bill work the body does not show. */
const OPENAI_TOOL_TYPES = new Set(['function', 'custom', 'local_shell', 'shell', 'apply_patch']);

function unknownField(body: Json, allowed: ReadonlySet<string>): string | undefined {
  return Object.keys(body).find((key) => !allowed.has(key));
}

function modelOf(
  body: Json,
  vendor: Vendor,
  table: ReadonlyMap<string, ModelPrice>,
): ModelPrice | string {
  if (typeof body.model !== 'string' || body.model === '') return 'the request names no model';
  return (
    table.get(`${vendor}:${body.model}`) ??
    'the requested model has no price, so its cost cannot be bounded'
  );
}

function outputCap(value: unknown, price: ModelPrice): number | string {
  if (!Number.isInteger(value) || (value as number) < 1) {
    return 'the request has no valid output token limit';
  }
  if ((value as number) > price.maxOutputTokens) {
    return 'the output token limit is above what this deployment allows';
  }
  return value as number;
}

/**
 * The worst case of a Messages API request, or why it has none. Bytes bound text; images get a
 * fixed bound each; a document or a reference to remote content needs the vendor's count.
 */
export function boundAnthropic(
  raw: Uint8Array,
  body: Json,
  table: ReadonlyMap<string, ModelPrice>,
  limits: BoundLimits,
): Bounded {
  const extra = unknownField(body, ANTHROPIC_FIELDS);
  if (extra !== undefined) return { ok: false, reason: `the field "${extra}" is not allowed` };
  const price = modelOf(body, 'anthropic', table);
  if (typeof price === 'string') return { ok: false, reason: price };
  const output = outputCap(body.max_tokens, price);
  if (typeof output === 'string') return { ok: false, reason: output };
  if (body.service_tier !== undefined && body.service_tier !== 'standard_only') {
    return { ok: false, reason: 'only the standard service tier is allowed' };
  }
  if (body.context_management !== undefined) {
    const edits = isObject(body.context_management) ? body.context_management.edits : undefined;
    const ok =
      Array.isArray(edits) &&
      Object.keys(body.context_management as Json).every((key) => key === 'edits') &&
      edits.every(
        (edit) => isObject(edit) && typeof edit.type === 'string' && edit.type.startsWith('clear_'),
      );
    if (!ok) return { ok: false, reason: 'only context edits that clear content are allowed' };
  }

  let images = 0;
  let mustCount = false;
  let oneHour = false;
  let refusal: string | undefined;
  const cached = (value: unknown): void => {
    if (isObject(value) && isObject(value.cache_control) && value.cache_control.ttl === '1h') {
      oneHour = true;
    }
  };
  const visit = (block: unknown): void => {
    if (!isObject(block)) return;
    cached(block);
    const source = isObject(block.source) ? block.source : undefined;
    switch (block.type) {
      case 'image':
        if (source?.type === 'base64') images++;
        else mustCount = true;
        break;
      case 'document':
        if (source?.type === 'text') break;
        if (source?.type === 'content') {
          for (const inner of list(source.content)) visit(inner);
          break;
        }
        mustCount = true;
        break;
      case 'tool_result':
      case 'search_result':
        for (const inner of list(block.content)) visit(inner);
        break;
      case 'container_upload':
        refusal = 'files uploaded to a container are not allowed';
        break;
      default:
        break;
    }
  };

  cached(body);
  for (const block of list(body.system)) visit(block);
  for (const message of list(body.messages)) {
    if (!isObject(message)) continue;
    for (const block of list(message.content)) visit(block);
  }
  for (const tool of list(body.tools)) {
    if (!isObject(tool)) return { ok: false, reason: 'a tool definition is not an object' };
    if (tool.type !== undefined && tool.type !== 'custom') {
      return { ok: false, reason: 'hosted tools are not allowed' };
    }
    cached(tool);
  }
  if (refusal !== undefined) return { ok: false, reason: refusal };

  return {
    ok: true,
    price,
    body: raw,
    inputTokens: raw.byteLength + limits.requestOverheadTokens + images * limits.imageTokens,
    outputTokens: output,
    inputMultiplier: oneHour ? CACHE_WRITE_1H : CACHE_WRITE_5M,
    mustCount,
    oneHourCache: oneHour,
    stream: body.stream === true,
  };
}

/**
 * The worst case of a Responses API request, or why it has none. Server-side state (an earlier
 * response, a conversation, a stored prompt or item) is refused: its tokens are not in the body.
 * Without an output cap the request is sent with the model's own cap, which it cannot exceed.
 */
export function boundOpenAI(
  raw: Uint8Array,
  body: Json,
  table: ReadonlyMap<string, ModelPrice>,
  limits: BoundLimits,
): Bounded {
  const extra = unknownField(body, OPENAI_FIELDS);
  if (extra !== undefined) return { ok: false, reason: `the field "${extra}" is not allowed` };
  const price = modelOf(body, 'openai', table);
  if (typeof price === 'string') return { ok: false, reason: price };
  if (body.service_tier !== undefined && body.service_tier !== 'default') {
    return { ok: false, reason: 'only the default service tier is allowed' };
  }
  for (const tool of list(body.tools)) {
    if (!isObject(tool) || typeof tool.type !== 'string' || !OPENAI_TOOL_TYPES.has(tool.type)) {
      return { ok: false, reason: 'hosted tools are not allowed' };
    }
  }

  let images = 0;
  for (const item of typeof body.input === 'string' ? [] : list(body.input)) {
    if (!isObject(item)) continue;
    if (item.type === 'item_reference')
      return { ok: false, reason: 'stored items are not allowed' };
    for (const part of list(item.content)) {
      if (!isObject(part)) continue;
      if (part.type === 'input_image') images++;
      if (part.type === 'input_file') return { ok: false, reason: 'input files are not allowed' };
    }
  }

  let sent = raw;
  let output: number | string;
  if (body.max_output_tokens === undefined) {
    output = price.maxOutputTokens;
    sent = new TextEncoder().encode(JSON.stringify({ ...body, max_output_tokens: output }));
  } else {
    output = outputCap(body.max_output_tokens, price);
    if (typeof output === 'string') return { ok: false, reason: output };
  }

  return {
    ok: true,
    price,
    body: sent,
    inputTokens: sent.byteLength + limits.requestOverheadTokens + images * limits.imageTokens,
    outputTokens: output,
    inputMultiplier: 1,
    mustCount: false,
    oneHourCache: false,
    stream: body.stream === true,
  };
}

/** The input bound from a vendor's count of the request. */
export function countedInputTokens(count: number, limits: BoundLimits): number {
  return Math.ceil(count * (1 + limits.countMargin)) + 256;
}

/** The fields of a Messages API request that the count endpoint takes. */
export function countBody(body: Json): Json {
  const out: Json = {};
  for (const key of ['model', 'messages', 'system', 'tools', 'tool_choice', 'thinking']) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}
