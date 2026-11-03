import type { AutonomyState } from './types.js';

export const REQUEST_SEGMENTS = ['system', 'tools', 'messages', 'appendedTools', 'tail'] as const;
export type RequestSegment = (typeof REQUEST_SEGMENTS)[number];

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface RequestMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Append-only worker request. Tools loaded mid-session go on `appendedTools`
 * (serialized after messages). Volatile facts (git status, clocks) live in
 * `tail`. Nothing near the top is rewritten.
 */
export interface WorkerRequest {
  system: string;
  tools: ToolDef[];
  messages: RequestMessage[];
  appendedTools: ToolDef[];
  tail: Record<string, string>;
  endpoint: string;
}

export interface CacheBreak {
  broke: RequestSegment | null;
  appendOnly: boolean;
}

export interface CacheUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function buildRequest(input: {
  system?: string;
  tools?: ToolDef[];
  messages?: RequestMessage[];
  appendedTools?: ToolDef[];
  tail?: Record<string, string>;
  endpoint?: string;
}): WorkerRequest {
  return {
    system: input.system ?? '',
    tools: (input.tools ?? []).map(cloneTool),
    messages: (input.messages ?? []).map((row) => ({ ...row })),
    appendedTools: (input.appendedTools ?? []).map(cloneTool),
    tail: { ...(input.tail ?? {}) },
    endpoint: input.endpoint ?? 'https://api.anthropic.com/v1/messages',
  };
}

export function loadTool(prev: WorkerRequest, tool: ToolDef): WorkerRequest {
  if (prev.tools.some((row) => row.name === tool.name)) return cloneRequest(prev);
  if (prev.appendedTools.some((row) => row.name === tool.name)) return cloneRequest(prev);
  const next = cloneRequest(prev);
  next.appendedTools.push(cloneTool(tool));
  return next;
}

export function appendMessage(prev: WorkerRequest, message: RequestMessage): WorkerRequest {
  const next = cloneRequest(prev);
  next.messages.push({ ...message });
  return next;
}

export function setTail(prev: WorkerRequest, tail: Record<string, string>): WorkerRequest {
  const next = cloneRequest(prev);
  next.tail = { ...tail };
  return next;
}

export function serializeSegments(request: WorkerRequest): Record<RequestSegment, string> {
  return {
    system: request.system,
    tools: JSON.stringify(request.tools),
    messages: JSON.stringify(request.messages),
    appendedTools: JSON.stringify(request.appendedTools),
    tail: JSON.stringify(request.tail),
  };
}

export function diffPrefix(prev: WorkerRequest, next: WorkerRequest): CacheBreak {
  if (prev.system !== next.system) return { broke: 'system', appendOnly: false };
  if (JSON.stringify(prev.tools) !== JSON.stringify(next.tools)) {
    return { broke: 'tools', appendOnly: false };
  }
  if (!isPrefix(prev.messages, next.messages)) return { broke: 'messages', appendOnly: false };
  if (JSON.stringify(prev.messages) !== JSON.stringify(next.messages)) {
    return { broke: 'messages', appendOnly: true };
  }
  if (!isPrefix(prev.appendedTools, next.appendedTools)) {
    return { broke: 'appendedTools', appendOnly: false };
  }
  if (JSON.stringify(prev.appendedTools) !== JSON.stringify(next.appendedTools)) {
    return { broke: 'appendedTools', appendOnly: true };
  }
  if (JSON.stringify(prev.tail) !== JSON.stringify(next.tail)) {
    return { broke: 'tail', appendOnly: true };
  }
  return { broke: null, appendOnly: true };
}

function isPrefix<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left.length > right.length) return false;
  return JSON.stringify(right.slice(0, left.length)) === JSON.stringify(left);
}

export function recordCacheBreak(
  state: AutonomyState,
  prev: WorkerRequest | undefined,
  next: WorkerRequest,
): { state: AutonomyState; break: CacheBreak } {
  if (!prev) return { state, break: { broke: null, appendOnly: true } };
  const found = diffPrefix(prev, next);
  if (found.broke && !found.appendOnly) {
    return { state: { ...state, cacheBreaks: state.cacheBreaks + 1 }, break: found };
  }
  return { state, break: found };
}

export function cacheHitShare(usage: Partial<CacheUsage> & { inputTokens: number }): number {
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const denom = read + write + usage.inputTokens;
  if (denom <= 0) return 0;
  return read / denom;
}

export function recordCacheUsage(state: AutonomyState, usage: CacheUsage): AutonomyState {
  return {
    ...state,
    cacheReadTokens: state.cacheReadTokens + usage.cacheReadTokens,
    cacheWriteTokens: state.cacheWriteTokens + usage.cacheWriteTokens,
    inputTokens: state.inputTokens + usage.inputTokens,
  };
}

export function workerCacheHitShare(state: Pick<AutonomyState, keyof CacheUsage>): number {
  return cacheHitShare({
    inputTokens: state.inputTokens,
    cacheReadTokens: state.cacheReadTokens,
    cacheWriteTokens: state.cacheWriteTokens,
  });
}

/**
 * Anthropic Messages body. Frozen `tools` stay at the top (cache prefix).
 * Newly loaded tools and volatile tail are extra messages at the end.
 */
export function toAnthropicBody(
  request: WorkerRequest,
  extras: { model: string; maxTokens: number } = { model: 'claude-haiku-5-5', maxTokens: 4096 },
): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = request.messages.map((row) => ({
    ...row,
  }));
  if (request.appendedTools.length > 0) {
    messages.push({
      role: 'user',
      content: `Additional tools:\n${request.appendedTools.map((tool) => `- ${tool.name}: ${tool.description ?? ''}`).join('\n')}`,
    });
  }
  if (Object.keys(request.tail).length > 0) {
    messages.push({
      role: 'user',
      content: Object.entries(request.tail)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    });
  }
  return {
    model: extras.model,
    max_tokens: extras.maxTokens,
    system: [
      {
        type: 'text',
        text: request.system,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: request.tools,
    messages,
  };
}

export function cloneRequest(request: WorkerRequest): WorkerRequest {
  return {
    system: request.system,
    tools: request.tools.map(cloneTool),
    messages: request.messages.map((row) => ({ ...row })),
    appendedTools: request.appendedTools.map(cloneTool),
    tail: { ...request.tail },
    endpoint: request.endpoint,
  };
}

function cloneTool(tool: ToolDef): ToolDef {
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
  };
}
