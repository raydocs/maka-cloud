import type { ModelPrice, Vendor } from './pricing.js';
import { CACHE_WRITE_1H, CACHE_WRITE_5M } from './pricing.js';

/** The constants the worst-case bound adds to what the body shows. */
export interface BoundLimits {
  /** Tokens added to every request for what the vendor adds and the body does not show. */
  requestOverheadTokens: number;
  /** Added to a vendor's token count, as a fraction of it: the count is an estimate. */
  countMargin: number;
}

export const DEFAULT_BOUND_LIMITS: BoundLimits = {
  requestOverheadTokens: 4_000,
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

/**
 * OpenAI tools the caller runs itself, with every key each may carry. Hosted tools bill work the
 * body does not show, and a shell with an environment other than `local` runs in a vendor container.
 */
const OPENAI_TOOL_KEYS = new Map<string, ReadonlySet<string>>([
  ['function', new Set(['type', 'name', 'description', 'parameters', 'strict'])],
  ['custom', new Set(['type', 'name', 'description', 'format'])],
  ['local_shell', new Set(['type'])],
  ['shell', new Set(['type', 'environment'])],
  ['apply_patch', new Set(['type'])],
]);

function localOpenAITool(tool: unknown): boolean {
  if (!isObject(tool) || typeof tool.type !== 'string') return false;
  const keys = OPENAI_TOOL_KEYS.get(tool.type);
  if (keys === undefined || unknownField(tool, keys) !== undefined) return false;
  if (tool.type !== 'shell') return true;
  const environment = tool.environment;
  return (
    isObject(environment) && environment.type === 'local' && Object.keys(environment).length === 1
  );
}

/**
 * Images and files are refused: what a model bills for one depends on the model and the detail
 * level (tile-based models bill far more than their pixels suggest), and no rule is verified for
 * every model. Coding and research send text only.
 */
const NO_IMAGES = 'images and files are not allowed';

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
 * The worst case of a Messages API request, or why it has none. Bytes bound text, including a
 * document whose source is text; an image or any other document is refused.
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
        refusal = NO_IMAGES;
        break;
      case 'document':
        if (source?.type === 'text') break;
        if (source?.type === 'content') {
          for (const inner of list(source.content)) visit(inner);
          break;
        }
        refusal = NO_IMAGES;
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
    inputTokens: raw.byteLength + limits.requestOverheadTokens,
    outputTokens: output,
    inputMultiplier: oneHour ? CACHE_WRITE_1H : CACHE_WRITE_5M,
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
    if (!localOpenAITool(tool)) return { ok: false, reason: 'hosted tools are not allowed' };
  }

  const content = refusedContent(body.input);
  if (content !== undefined) return { ok: false, reason: content };

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
    inputTokens: sent.byteLength + limits.requestOverheadTokens,
    outputTokens: output,
    inputMultiplier: 1,
    oneHourCache: false,
    stream: body.stream === true,
  };
}

/**
 * Why a Responses input cannot be bounded by its bytes, if it cannot: an image or a file anywhere
 * (message content, tool outputs), or a stored item.
 */
function refusedContent(input: unknown): string | undefined {
  const stack: unknown[] = [input];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const value of node) stack.push(value);
      continue;
    }
    if (!isObject(node)) continue;
    switch (node.type) {
      case 'item_reference':
        return 'stored items are not allowed';
      case 'input_file':
      case 'input_image':
      case 'computer_screenshot':
        return NO_IMAGES;
      default:
        break;
    }
    for (const value of Object.values(node)) {
      if (typeof value === 'object' && value !== null) stack.push(value);
    }
  }
  return undefined;
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
