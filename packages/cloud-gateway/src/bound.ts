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

/** A cache hint: ephemeral, with the default or a listed lifetime. */
function cacheControl(value: unknown): value is Json {
  return (
    isObject(value) &&
    value.type === 'ephemeral' &&
    unknownField(value, CACHE_FIELDS) === undefined &&
    (value.ttl === undefined || value.ttl === '5m' || value.ttl === '1h')
  );
}

const CACHE_FIELDS = new Set(['type', 'ttl']);
const BAD_CACHE = 'a cache hint is not valid';

/**
 * Every content block type a Messages request may carry, with every key each may have. Anything
 * else is refused wherever it sits: an image, a document, a file, a search result, server-tool
 * history (fetched pages, search results, code output) or a type added later. Each of those can
 * bill more than its bytes, and coding and research need only text, thinking and local tools.
 */
const ANTHROPIC_BLOCK_KEYS = new Map<string, ReadonlySet<string>>([
  ['text', new Set(['type', 'text', 'cache_control', 'citations'])],
  ['thinking', new Set(['type', 'thinking', 'signature'])],
  ['redacted_thinking', new Set(['type', 'data'])],
  ['tool_use', new Set(['type', 'id', 'name', 'input', 'cache_control'])],
  ['tool_result', new Set(['type', 'tool_use_id', 'content', 'is_error', 'cache_control'])],
]);

const NOT_TEXT = 'only text, thinking, tool calls and text tool results are allowed in a request';

/** Why a block is refused, if it is: an unlisted type or key, or content that is not text. */
function anthropicBlock(
  block: unknown,
  allowed: ReadonlySet<string>,
  cached: (value: Json) => boolean,
): string | undefined {
  if (!isObject(block) || typeof block.type !== 'string' || !allowed.has(block.type)) {
    return NOT_TEXT;
  }
  const keys = ANTHROPIC_BLOCK_KEYS.get(block.type);
  if (keys === undefined || unknownField(block, keys) !== undefined) return NOT_TEXT;
  if (!cached(block)) return BAD_CACHE;
  switch (block.type) {
    case 'text':
      // Citations point into documents or search results, which are refused.
      if (typeof block.text !== 'string' || (block.citations ?? null) !== null) return NOT_TEXT;
      return undefined;
    case 'tool_result':
      if (block.content === undefined || typeof block.content === 'string') return undefined;
      if (!Array.isArray(block.content)) return NOT_TEXT;
      for (const inner of block.content) {
        const refused = anthropicBlock(inner, TEXT_ONLY, cached);
        if (refused !== undefined) return refused;
      }
      return undefined;
    default:
      return undefined;
  }
}

const TEXT_ONLY: ReadonlySet<string> = new Set(['text']);
const MESSAGE_BLOCKS: ReadonlySet<string> = new Set(ANTHROPIC_BLOCK_KEYS.keys());

/** Why the system prompt or the messages are refused, if they are. */
function anthropicContent(body: Json, cached: (value: Json) => boolean): string | undefined {
  const blocks = (content: unknown, allowed: ReadonlySet<string>): string | undefined => {
    if (typeof content === 'string') return undefined;
    if (!Array.isArray(content)) return NOT_TEXT;
    for (const block of content) {
      const refused = anthropicBlock(block, allowed, cached);
      if (refused !== undefined) return refused;
    }
    return undefined;
  };
  if (body.system !== undefined) {
    const refused = blocks(body.system, TEXT_ONLY);
    if (refused !== undefined) return refused;
  }
  if (!Array.isArray(body.messages)) return 'the request has no messages';
  for (const message of body.messages) {
    if (
      !isObject(message) ||
      unknownField(message, MESSAGE_FIELDS) !== undefined ||
      (message.role !== 'user' && message.role !== 'assistant')
    ) {
      return 'a message is not valid';
    }
    const refused = blocks(message.content, MESSAGE_BLOCKS);
    if (refused !== undefined) return refused;
  }
  return undefined;
}

const MESSAGE_FIELDS = new Set(['role', 'content']);

/**
 * The worst case of a Messages API request, or why it has none. Bytes bound the text it may
 * carry; every other content type is refused.
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
  const cached = (value: Json): boolean => {
    if (value.cache_control === undefined) return true;
    if (!cacheControl(value.cache_control)) return false;
    if (value.cache_control.ttl === '1h') oneHour = true;
    return true;
  };
  if (!cached(body)) return { ok: false, reason: BAD_CACHE };
  const content = anthropicContent(body, cached);
  if (content !== undefined) return { ok: false, reason: content };
  for (const tool of list(body.tools)) {
    if (!isObject(tool)) return { ok: false, reason: 'a tool definition is not an object' };
    if (tool.type !== undefined && tool.type !== 'custom') {
      return { ok: false, reason: 'hosted tools are not allowed' };
    }
    if (!cached(tool)) return { ok: false, reason: BAD_CACHE };
  }

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

  if (body.instructions !== undefined && typeof body.instructions !== 'string') {
    return { ok: false, reason: 'the instructions must be text' };
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
    // Any input token may be written to the cache, which GPT-5.6 and later bill at 1.25x input
    // (the default 30-minute lifetime; the field that asks for 12 hours is refused).
    inputMultiplier: CACHE_WRITE_5M,
    oneHourCache: false,
    stream: body.stream === true,
  };
}

/**
 * Every typed object a Responses input may carry, at any depth: messages and their text, the
 * caller's own tool calls and their text outputs, reasoning, and the small typed values inside
 * local tool calls (a shell action or outcome, a patch operation). Anything else is refused
 * wherever it sits: an image, a file, a screenshot, a stored item, hosted-tool history or a type
 * added later. Each of those can bill more than its bytes.
 */
const OPENAI_INPUT_TYPES: ReadonlySet<string> = new Set([
  'message',
  'input_text',
  'output_text',
  'refusal',
  'reasoning',
  'summary_text',
  'reasoning_text',
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'local_shell_call',
  'local_shell_call_output',
  'shell_call',
  'shell_call_output',
  'apply_patch_call',
  'apply_patch_call_output',
  'exec',
  'exit',
  'timeout',
  'create_file',
  'update_file',
  'delete_file',
]);

/** Why a Responses input cannot be bounded by its bytes, if it cannot. */
function refusedContent(input: unknown): string | undefined {
  const stack: unknown[] = [input];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const value of node) stack.push(value);
      continue;
    }
    if (!isObject(node)) continue;
    if (node.type !== undefined) {
      if (node.type === 'item_reference') return 'stored items are not allowed';
      if (typeof node.type !== 'string' || !OPENAI_INPUT_TYPES.has(node.type)) {
        return 'only text, reasoning and local tool calls are allowed in the input';
      }
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
