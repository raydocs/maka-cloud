import { dataUrlBytes, imageSize } from './image.js';
import type { ModelPrice, Vendor } from './pricing.js';
import { CACHE_WRITE_1H, CACHE_WRITE_5M } from './pricing.js';

/** The constants the worst-case bound adds to what the body shows. */
export interface BoundLimits {
  /** Tokens added to every request for what the vendor adds and the body does not show. */
  requestOverheadTokens: number;
  /** Tokens added to each image whatever its size. */
  imageBaseTokens: number;
  /**
   * Tokens per 32×32 patch of an image at the size its file declares. With `imageBaseTokens` it
   * covers what every model charges for an image at any detail level, since the vendors bill an
   * image by its pixels and only ever scale it down.
   */
  imagePatchTokens: number;
  /** Added to a vendor's token count, as a fraction of it: the count is an estimate. */
  countMargin: number;
}

export const DEFAULT_BOUND_LIMITS: BoundLimits = {
  requestOverheadTokens: 4_000,
  imageBaseTokens: 300,
  imagePatchTokens: 3,
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

/** The input bound of an image of this size. */
function imageTokens(width: number, height: number, limits: BoundLimits): number {
  const patches = Math.ceil(width / 32) * Math.ceil(height / 32);
  return limits.imageBaseTokens + patches * limits.imagePatchTokens;
}

/** The input bound of an image file, or undefined when its size cannot be read. */
function imageFileTokens(bytes: Uint8Array | undefined, limits: BoundLimits): number | undefined {
  const size = bytes === undefined ? undefined : imageSize(bytes);
  return size === undefined ? undefined : imageTokens(size.width, size.height, limits);
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

/**
 * The worst case of a Messages API request, or why it has none. Bytes bound text; an inline image
 * gets a bound from its pixel size; a document, a remote image or one whose size cannot be read
 * needs the vendor's count.
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

  let imageBound = 0;
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
      case 'image': {
        const tokens =
          source?.type === 'base64' && typeof source.data === 'string'
            ? imageFileTokens(Buffer.from(source.data, 'base64'), limits)
            : undefined;
        // A remote image, or one whose size the header does not give: the count covers it.
        if (tokens === undefined) mustCount = true;
        else imageBound += tokens;
        break;
      }
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
    inputTokens: raw.byteLength + limits.requestOverheadTokens + imageBound,
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
    if (!localOpenAITool(tool)) return { ok: false, reason: 'hosted tools are not allowed' };
  }

  const images = openAIImages(body.input, limits);
  if (typeof images === 'string') return { ok: false, reason: images };

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
    inputTokens: sent.byteLength + limits.requestOverheadTokens + images,
    outputTokens: output,
    inputMultiplier: 1,
    mustCount: false,
    oneHourCache: false,
    stream: body.stream === true,
  };
}

/**
 * The input bound of the images anywhere in a Responses input (message content, tool outputs),
 * or why the input has none. Only inline images whose header gives their size are taken: a URL
 * or a file reference is content the body does not show.
 */
function openAIImages(input: unknown, limits: BoundLimits): number | string {
  let tokens = 0;
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
        return 'input files are not allowed';
      case 'input_image':
      case 'computer_screenshot': {
        if (node.file_id !== undefined && node.file_id !== null) {
          return 'images must be sent inline, not as a file reference';
        }
        const url = typeof node.image_url === 'string' ? node.image_url : '';
        const bound = imageFileTokens(dataUrlBytes(url), limits);
        if (bound === undefined) {
          return url.startsWith('data:')
            ? 'an image is not a PNG, JPEG, GIF or WebP file whose size can be read'
            : 'images must be sent inline, not as a URL';
        }
        tokens += bound;
        continue;
      }
      default:
        break;
    }
    for (const value of Object.values(node)) {
      if (typeof value === 'object' && value !== null) stack.push(value);
    }
  }
  return tokens;
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
