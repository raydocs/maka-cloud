import { isDeepStrictEqual } from 'node:util';
import type { EmittedThinking, RecordedRequest, WireBlock, WireMessage } from './fake-anthropic.js';

/**
 * Pure checks over recorded Anthropic request bodies. Every check compares
 * each main-loop request with the one sent right before it, across tool steps
 * and across user turns alike.
 */

export type DivergenceCause =
  /** Only `cache_control` keys differ: the moving history breakpoint. */
  | 'cache_control_moved'
  /** Equal once request-only blocks are set aside: per-request context not kept in history. */
  | 'request_only_context'
  /** Both of the above in the same message. */
  | 'request_only_context_and_cache_control'
  /** The next request has fewer messages than the previous one. */
  | 'history_shrunk'
  /** Content of an earlier message changed. */
  | 'rewrite';

export interface Divergence {
  readonly from: number;
  readonly to: number;
  readonly fromTurn?: number;
  readonly toTurn?: number;
  readonly messageIndex: number;
  /** JSON path of the first differing value inside the message. */
  readonly path: string;
  readonly cause: DivergenceCause;
  readonly before?: string;
  readonly after?: string;
}

export interface ThinkingFailure {
  readonly emittedAt: number;
  readonly request: number;
  readonly turn?: number;
  readonly kind: 'missing' | 'altered' | 'moved';
  readonly detail: string;
}

export interface BreakpointObservation {
  readonly request: number;
  readonly turn?: number;
  /** All `cache_control` markers: top level, system, tools and message blocks. */
  readonly total: number;
  readonly topLevel: boolean;
  readonly system: number;
  readonly tools: number;
  /** Flattened block positions of message-level markers. */
  readonly messageBlocks: number[];
  /** Flattened position of the last block that is not request-only context. */
  readonly lastDurableBlock: number;
  /** Flattened position of the last block of the request. */
  readonly finalBlock: number;
}

export interface BreakpointFailure {
  readonly request: number;
  readonly turn?: number;
  readonly kind: 'over_limit' | 'not_on_last_durable_block' | 'moved_backwards' | 'missing';
  readonly detail: string;
}

export interface HistoryCheckReport {
  readonly requests: number;
  readonly pairs: number;
  /** Check 1: previous `messages` are a byte-identical prefix of the next request's. */
  readonly strictPrefix: { readonly breaks: Divergence[] };
  /** Check 1 with `cache_control` keys and request-only blocks set aside. */
  readonly contentPrefix: { readonly breaks: Divergence[] };
  /** Check 2: every returned thinking block comes back unchanged in every later request. */
  readonly thinking: {
    readonly emitted: number;
    readonly occurrencesChecked: number;
    readonly failures: ThinkingFailure[];
  };
  /** Check 3: cache breakpoints stay on stable positions. */
  readonly breakpoints: {
    readonly observations: BreakpointObservation[];
    readonly failures: BreakpointFailure[];
  };
  readonly systemChanges: Array<{ from: number; to: number }>;
  readonly toolsChanges: Array<{ from: number; to: number }>;
}

export interface CheckOptions {
  /** Identifies per-request context blocks the runtime sends after the history. */
  readonly isRequestOnlyBlock: (block: WireBlock) => boolean;
}

export function checkHistory(
  allRequests: readonly RecordedRequest[],
  emitted: readonly EmittedThinking[],
  options: CheckOptions,
): HistoryCheckReport {
  const requests = allRequests.filter((request) => request.kind === 'main');
  const strictBreaks: Divergence[] = [];
  const contentBreaks: Divergence[] = [];
  const systemChanges: Array<{ from: number; to: number }> = [];
  const toolsChanges: Array<{ from: number; to: number }> = [];
  for (let i = 1; i < requests.length; i += 1) {
    const previous = requests[i - 1]!;
    const next = requests[i]!;
    const strict = strictPrefixDivergence(previous, next, options);
    if (strict) strictBreaks.push(strict);
    const content = contentPrefixDivergence(previous, next, options);
    if (content) contentBreaks.push(content);
    if (!isDeepStrictEqual(previous.body.system, next.body.system)) {
      systemChanges.push({ from: previous.index, to: next.index });
    }
    if (!isDeepStrictEqual(previous.body.tools, next.body.tools)) {
      toolsChanges.push({ from: previous.index, to: next.index });
    }
  }
  return {
    requests: requests.length,
    pairs: Math.max(0, requests.length - 1),
    strictPrefix: { breaks: strictBreaks },
    contentPrefix: { breaks: contentBreaks },
    thinking: checkThinking(requests, emitted),
    breakpoints: checkBreakpoints(requests, options),
    systemChanges,
    toolsChanges,
  };
}

// ---------------------------------------------------------------------------
// Check 1: prefix
// ---------------------------------------------------------------------------

export function strictPrefixDivergence(
  previous: RecordedRequest,
  next: RecordedRequest,
  options: CheckOptions,
): Divergence | undefined {
  const before = previous.body.messages;
  const after = next.body.messages;
  for (let index = 0; index < before.length; index += 1) {
    const a = before[index]!;
    const b = after[index];
    if (b === undefined) {
      return divergence(previous, next, index, '', 'history_shrunk');
    }
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const path = firstDifferencePath(a, b);
    const durableA = durableMessage(withoutCacheControl(a), options);
    const durableB = durableMessage(withoutCacheControl(b), options);
    let cause: DivergenceCause;
    if (isDeepStrictEqual(withoutCacheControl(a), withoutCacheControl(b))) {
      cause = 'cache_control_moved';
    } else if (isDeepStrictEqual(durableA, durableB)) {
      cause = isDeepStrictEqual(durableMessage(a, options), durableMessage(b, options))
        ? 'request_only_context'
        : 'request_only_context_and_cache_control';
    } else {
      cause = 'rewrite';
    }
    return divergence(previous, next, index, path, cause, a, b);
  }
  return undefined;
}

/**
 * The prefix check with the two known by-design differences set aside:
 * `cache_control` keys are removed, and request-only blocks are dropped (with
 * any message they leave empty) before comparing block by block.
 */
export function contentPrefixDivergence(
  previous: RecordedRequest,
  next: RecordedRequest,
  options: CheckOptions,
): Divergence | undefined {
  const before = durableMessages(previous.body.messages, options);
  const after = durableMessages(next.body.messages, options);
  for (let index = 0; index < before.length; index += 1) {
    const a = before[index]!;
    const b = after[index];
    if (b === undefined) return divergence(previous, next, index, '', 'history_shrunk');
    if (a.role !== b.role) {
      return divergence(previous, next, index, '.role', 'rewrite', a, b);
    }
    // The last durable message of the previous request may legitimately gain
    // blocks (a user message merged with what follows); earlier ones may not.
    const isLast = index === before.length - 1;
    const blocksA = a.content as WireBlock[];
    const blocksB = b.content as WireBlock[];
    const comparable = isLast ? blocksB.slice(0, blocksA.length) : blocksB;
    if (!isDeepStrictEqual(blocksA, comparable)) {
      return divergence(
        previous,
        next,
        index,
        firstDifferencePath(blocksA, comparable, '.content'),
        'rewrite',
        a,
        b,
      );
    }
  }
  return undefined;
}

function divergence(
  previous: RecordedRequest,
  next: RecordedRequest,
  messageIndex: number,
  path: string,
  cause: DivergenceCause,
  before?: unknown,
  after?: unknown,
): Divergence {
  return {
    from: previous.index,
    to: next.index,
    ...(previous.turn !== undefined ? { fromTurn: previous.turn } : {}),
    ...(next.turn !== undefined ? { toTurn: next.turn } : {}),
    messageIndex,
    path,
    cause,
    ...(before !== undefined ? { before: excerpt(valueAt(before, path)) } : {}),
    ...(after !== undefined ? { after: excerpt(valueAt(after, path)) } : {}),
  };
}

function normalizedBlocks(message: WireMessage): WireBlock[] {
  return typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : message.content;
}

function durableMessage(message: WireMessage, options: CheckOptions): WireMessage {
  return {
    role: message.role,
    content: normalizedBlocks(message).filter((block) => !options.isRequestOnlyBlock(block)),
  };
}

function durableMessages(messages: readonly WireMessage[], options: CheckOptions): WireMessage[] {
  return messages
    .map((message) => durableMessage(withoutCacheControl(message), options))
    .filter((message) => (message.content as WireBlock[]).length > 0);
}

export function withoutCacheControl<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => withoutCacheControl(item)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'cache_control') continue;
      out[key] = withoutCacheControl(item);
    }
    return out as T;
  }
  return value;
}

export function firstDifferencePath(a: unknown, b: unknown, path = ''): string {
  if (isDeepStrictEqual(a, b)) return path;
  if (Array.isArray(a) && Array.isArray(b)) {
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      if (!isDeepStrictEqual(a[index], b[index])) {
        return firstDifferencePath(a[index], b[index], `${path}[${index}]`);
      }
    }
    return path;
  }
  if (
    a &&
    b &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const left = (a as Record<string, unknown>)[key];
      const right = (b as Record<string, unknown>)[key];
      if (!isDeepStrictEqual(left, right))
        return firstDifferencePath(left, right, `${path}.${key}`);
    }
    // Same keys and values in a different order: only the bytes differ.
    return `${path} (key order)`;
  }
  return path;
}

function valueAt(value: unknown, path: string): unknown {
  const tokens = path.replace(/ \(key order\)$/, '').match(/\.[^.[\]]+|\[\d+\]/g) ?? [];
  let current: unknown = value;
  for (const token of tokens) {
    if (current === undefined || current === null) return current;
    current = token.startsWith('[')
      ? (current as unknown[])[Number(token.slice(1, -1))]
      : (current as Record<string, unknown>)[token.slice(1)];
  }
  return current;
}

function excerpt(value: unknown): string {
  const text = value === undefined ? 'undefined' : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

// ---------------------------------------------------------------------------
// Check 2: thinking blocks and signatures
// ---------------------------------------------------------------------------

export function checkThinking(
  requests: readonly RecordedRequest[],
  emitted: readonly EmittedThinking[],
): HistoryCheckReport['thinking'] {
  const failures: ThinkingFailure[] = [];
  let occurrencesChecked = 0;
  for (const thinking of emitted) {
    let firstPosition: string | undefined;
    for (const request of requests) {
      if (request.index <= thinking.requestIndex) continue;
      occurrencesChecked += 1;
      const found = locateThinking(request, thinking);
      const turn = request.turn !== undefined ? { turn: request.turn } : {};
      if (found.kind === 'missing') {
        failures.push({
          emittedAt: thinking.requestIndex,
          request: request.index,
          ...turn,
          kind: 'missing',
          detail: describe(thinking),
        });
        break;
      }
      if (found.kind === 'altered') {
        failures.push({
          emittedAt: thinking.requestIndex,
          request: request.index,
          ...turn,
          kind: 'altered',
          detail: found.detail,
        });
        break;
      }
      if (firstPosition === undefined) firstPosition = found.position;
      else if (found.position !== firstPosition) {
        failures.push({
          emittedAt: thinking.requestIndex,
          request: request.index,
          ...turn,
          kind: 'moved',
          detail: `${describe(thinking)} moved from ${firstPosition} to ${found.position}`,
        });
        break;
      }
    }
  }
  return { emitted: emitted.length, occurrencesChecked, failures };
}

type ThinkingLocation =
  | { kind: 'found'; position: string }
  | { kind: 'altered'; detail: string }
  | { kind: 'missing' };

function locateThinking(request: RecordedRequest, thinking: EmittedThinking): ThinkingLocation {
  const expected = thinking.block;
  let found: string | undefined;
  let altered: string | undefined;
  request.body.messages.forEach((message, messageIndex) => {
    if (message.role !== 'assistant') return;
    normalizedBlocks(message).forEach((raw, blockIndex) => {
      const block = withoutCacheControl(raw);
      if (block.type !== expected.type) return;
      if (isDeepStrictEqual(block, expected)) {
        found ??= `messages[${messageIndex}].content[${blockIndex}]`;
        return;
      }
      if (expected.type === 'thinking') {
        const sameText = block.thinking === expected.thinking;
        const sameSignature = block.signature === expected.signature;
        if (sameText || sameSignature) {
          altered ??= `messages[${messageIndex}].content[${blockIndex}]: ${sameText ? 'signature' : 'thinking text'} changed`;
        }
      }
    });
  });
  if (found) return { kind: 'found', position: found };
  if (altered) return { kind: 'altered', detail: altered };
  return { kind: 'missing' };
}

function describe(thinking: EmittedThinking): string {
  return thinking.block.type === 'thinking'
    ? `thinking from request ${thinking.requestIndex}`
    : `redacted_thinking from request ${thinking.requestIndex}`;
}

// ---------------------------------------------------------------------------
// Check 3: cache breakpoints
// ---------------------------------------------------------------------------

/** Anthropic accepts at most four cache breakpoints per request. */
export const MAX_CACHE_BREAKPOINTS = 4;

export function observeBreakpoints(
  request: RecordedRequest,
  options: CheckOptions,
): BreakpointObservation {
  const system = Array.isArray(request.body.system)
    ? request.body.system.filter((block) => block.cache_control !== undefined).length
    : 0;
  const tools = (request.body.tools ?? []).filter(
    (tool) => tool.cache_control !== undefined,
  ).length;
  const messageBlocks: number[] = [];
  let lastDurableBlock = -1;
  let position = 0;
  for (const message of request.body.messages) {
    for (const block of normalizedBlocks(message)) {
      if (block.cache_control !== undefined) messageBlocks.push(position);
      if (!options.isRequestOnlyBlock(block)) lastDurableBlock = position;
      position += 1;
    }
  }
  const topLevel = request.body.cache_control !== undefined;
  return {
    request: request.index,
    ...(request.turn !== undefined ? { turn: request.turn } : {}),
    total: (topLevel ? 1 : 0) + system + tools + messageBlocks.length,
    topLevel,
    system,
    tools,
    messageBlocks,
    lastDurableBlock,
    finalBlock: position - 1,
  };
}

/**
 * Where the history breakpoint sits. A message-level marker is its own
 * position. A request with none but a top-level `cache_control` (Anthropic's
 * automatic caching) is cached up to its final block, so that block is the
 * marker; it is then only on the last durable block when nothing request-only
 * follows the history.
 */
function breakpointPosition(observation: BreakpointObservation): number | undefined {
  return (
    observation.messageBlocks.at(-1) ?? (observation.topLevel ? observation.finalBlock : undefined)
  );
}

export function checkBreakpoints(
  requests: readonly RecordedRequest[],
  options: CheckOptions,
): HistoryCheckReport['breakpoints'] {
  const observations = requests.map((request) => observeBreakpoints(request, options));
  const failures: BreakpointFailure[] = [];
  let previous: BreakpointObservation | undefined;
  for (const observation of observations) {
    const turn = observation.turn !== undefined ? { turn: observation.turn } : {};
    if (observation.total > MAX_CACHE_BREAKPOINTS) {
      failures.push({
        request: observation.request,
        ...turn,
        kind: 'over_limit',
        detail: `${observation.total} breakpoints`,
      });
    }
    const marker = breakpointPosition(observation);
    if (marker === undefined) {
      failures.push({
        request: observation.request,
        ...turn,
        kind: 'missing',
        detail: 'no message-level breakpoint',
      });
    } else {
      if (marker !== observation.lastDurableBlock) {
        failures.push({
          request: observation.request,
          ...turn,
          kind: 'not_on_last_durable_block',
          detail: `marker at block ${marker}, last durable block ${observation.lastDurableBlock}`,
        });
      }
      const previousMarker = previous && breakpointPosition(previous);
      if (previousMarker !== undefined && marker < previousMarker) {
        failures.push({
          request: observation.request,
          ...turn,
          kind: 'moved_backwards',
          detail: `marker moved from block ${previousMarker} to ${marker}`,
        });
      }
    }
    previous = observation;
  }
  return { observations, failures };
}
