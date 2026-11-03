import {
  buildRequest,
  diffPrefix,
  loadTool,
  type RequestMessage,
  type ToolDef,
  type WorkerRequest,
} from './prompt-cache.js';

/**
 * On-demand tool loading for workers.
 *
 * Wire model (Anthropic Messages API): EVERY tool is declared in `tools[]`
 * from the first request, so the `tools` bytes never change and the prompt
 * cache prefix holds. Deferred tools carry `defer_loading: true` and stay out
 * of the model's context until it calls `load_tools`; we answer with a
 * `tool_result` of `tool_reference` blocks and the API expands them inline.
 *
 * `WorkerRequest.tools` holds only the tools the model sees on turn one (core +
 * `load_tools`). Loaded tools go to `appendedTools` through `loadTool`, which
 * is append-only. Use `toAnthropicTools(catalog)` (not `request.tools`) as the
 * wire `tools` param.
 */

export const LOAD_TOOLS_NAME = 'load_tools';
export const MAX_QUERY_MATCHES = 5;

export const LOAD_TOOLS_TOOL: ToolDef = Object.freeze({
  name: LOAD_TOOLS_NAME,
  description:
    'Load tools that are listed in the tool index but not yet available. Pass names to load tools by exact name from the index, or query to find tools by keyword. Loaded tools can be called on your next step.',
  inputSchema: {
    type: 'object',
    properties: {
      names: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exact tool names from the index.',
      },
      query: {
        type: 'string',
        description: 'Keywords to search tool names and descriptions.',
      },
    },
    additionalProperties: false,
  },
}) as ToolDef;

export interface ToolCatalog {
  /** Tools the model sees on turn one. The load tool is last. */
  core: ToolDef[];
  /** Tools declared with `defer_loading: true`, loaded on request. */
  deferred: ToolDef[];
}

export interface LoadToolsInput {
  names?: string[];
  query?: string;
}

export type LoadToolsContentBlock =
  | { type: 'tool_reference'; tool_name: string }
  | { type: 'text'; text: string };

export interface LoadToolsResult {
  request: WorkerRequest;
  /** Deferred tools newly appended by this call. */
  loaded: string[];
  /** Requested tools that were already callable (appended earlier, or core). */
  already: string[];
  /** Requested names that match nothing in the catalog. */
  unknown: string[];
  /** Body for the `tool_result`; never empty. */
  content: LoadToolsContentBlock[];
}

export interface LoadStats {
  core: number;
  loaded: number;
  stillDeferred: number;
}

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function createToolCatalog(input: { core: ToolDef[]; deferred?: ToolDef[] }): ToolCatalog {
  const core = input.core.map(copyTool);
  const deferred = (input.deferred ?? []).map(copyTool);
  if (core.length === 0) throw new Error('tool catalog needs at least one core tool');
  const seen = new Set<string>();
  for (const tool of [...core, ...deferred]) {
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw new Error(`invalid tool name: ${JSON.stringify(tool.name)}`);
    }
    if (tool.name === LOAD_TOOLS_NAME) {
      throw new Error(`tool name is reserved for the load tool: ${LOAD_TOOLS_NAME}`);
    }
    if (seen.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
    seen.add(tool.name);
  }
  return { core: [...core, copyTool(LOAD_TOOLS_TOOL)], deferred };
}

/** Stable index of deferred tools for the system prompt. Empty when none. */
export function catalogIndex(catalog: ToolCatalog): string {
  if (catalog.deferred.length === 0) return '';
  const lines = catalog.deferred.map((tool) => {
    const summary = firstSentence(tool.description);
    return summary ? `- ${tool.name}: ${summary}` : `- ${tool.name}`;
  });
  return [
    `Tools you can load with ${LOAD_TOOLS_NAME} (by exact name, or search by keyword):`,
    ...lines,
  ].join('\n');
}

/** First request: only core tools (incl. `load_tools`); system ends with the index. */
export function firstTurnRequest(
  catalog: ToolCatalog,
  base: {
    system: string;
    endpoint?: string;
    messages?: RequestMessage[];
    tail?: Record<string, string>;
  },
): WorkerRequest {
  const index = catalogIndex(catalog);
  return buildRequest({
    system: index ? `${base.system}\n\n${index}` : base.system,
    tools: catalog.core,
    ...(base.messages === undefined ? {} : { messages: base.messages }),
    ...(base.tail === undefined ? {} : { tail: base.tail }),
    ...(base.endpoint === undefined ? {} : { endpoint: base.endpoint }),
  });
}

/**
 * Wire `tools` param for the Messages API: core first, then deferred with
 * `defer_loading: true`. Never carries `cache_control` (a deferred tool with it
 * is a 400). Same catalog gives byte-identical JSON for the whole session.
 */
export function toAnthropicTools(catalog: ToolCatalog): Array<Record<string, unknown>> {
  return [
    ...catalog.core.map((tool) => wireTool(tool, false)),
    ...catalog.deferred.map((tool) => wireTool(tool, true)),
  ];
}

export function handleLoadTools(
  request: WorkerRequest,
  catalog: ToolCatalog,
  input: LoadToolsInput,
): LoadToolsResult {
  const deferredByName = new Map(catalog.deferred.map((tool) => [tool.name, tool]));
  const coreNames = new Set(catalog.core.map((tool) => tool.name));
  const appendedNames = new Set(request.appendedTools.map((tool) => tool.name));

  const wanted: string[] = [];
  const unknown: string[] = [];
  const alreadyCore: string[] = [];
  for (const raw of input.names ?? []) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (!name) continue;
    if (coreNames.has(name)) {
      if (!alreadyCore.includes(name)) alreadyCore.push(name);
    } else if (deferredByName.has(name)) {
      if (!wanted.includes(name)) wanted.push(name);
    } else if (!unknown.includes(name)) {
      unknown.push(name);
    }
  }
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  let queryMisses = false;
  if (query) {
    const hits = searchDeferred(catalog, query);
    if (hits.length === 0) queryMisses = true;
    for (const name of hits) if (!wanted.includes(name)) wanted.push(name);
  }

  let next = request;
  const loaded: string[] = [];
  const already: string[] = [...alreadyCore];
  for (const name of wanted) {
    const tool = deferredByName.get(name) as ToolDef;
    if (appendedNames.has(name)) {
      already.push(name);
      continue;
    }
    next = loadTool(next, tool);
    appendedNames.add(name);
    loaded.push(name);
  }

  const change = diffPrefix(request, next);
  if (!change.appendOnly || (change.broke !== null && change.broke !== 'appendedTools')) {
    throw new Error(
      `load_tools broke the cache prefix (segment ${change.broke ?? 'none'}); this is a bug`,
    );
  }

  const content: LoadToolsContentBlock[] = wanted.map((name) => ({
    type: 'tool_reference',
    tool_name: name,
  }));
  const notes: string[] = [];
  if (unknown.length > 0) notes.push(`Unknown tools: ${unknown.join(', ')}.`);
  if (queryMisses) notes.push(`No tools match "${query}".`);
  if (alreadyCore.length > 0) notes.push(`Already available: ${alreadyCore.join(', ')}.`);
  if (content.length === 0 && notes.length === 0) notes.push('No matching tools found.');
  if (notes.length > 0) content.push({ type: 'text', text: notes.join(' ') });

  return { request: next, loaded, already, unknown, content };
}

/** True for core tools and tools already appended; false for deferred-not-loaded or unknown. */
export function isCallable(request: WorkerRequest, name: string): boolean {
  return (
    request.tools.some((tool) => tool.name === name) ||
    request.appendedTools.some((tool) => tool.name === name)
  );
}

export function loadStats(request: WorkerRequest, catalog: ToolCatalog): LoadStats {
  const deferredNames = new Set(catalog.deferred.map((tool) => tool.name));
  const loaded = new Set(
    request.appendedTools.filter((tool) => deferredNames.has(tool.name)).map((tool) => tool.name),
  ).size;
  return {
    core: catalog.core.length,
    loaded,
    stillDeferred: catalog.deferred.length - loaded,
  };
}

function searchDeferred(catalog: ToolCatalog, query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return [];
  const scored: Array<{ name: string; score: number; order: number }> = [];
  catalog.deferred.forEach((tool, order) => {
    const name = tool.name.toLowerCase();
    const haystack = `${name} ${(tool.description ?? '').toLowerCase()}`;
    let score = 0;
    for (const word of words) {
      if (name.includes(word)) score += 2;
      else if (haystack.includes(word)) score += 1;
    }
    if (score > 0) scored.push({ name: tool.name, score, order });
  });
  scored.sort((left, right) => right.score - left.score || left.order - right.order);
  return scored.slice(0, MAX_QUERY_MATCHES).map((row) => row.name);
}

function wireTool(tool: ToolDef, deferred: boolean): Record<string, unknown> {
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
    ...(deferred ? { defer_loading: true } : {}),
  };
}

function firstSentence(description: string | undefined): string {
  const text = (description ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const match = /^.*?[.!?](?=\s|$)/.exec(text);
  return match ? match[0] : text;
}

function copyTool(tool: ToolDef): ToolDef {
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
  };
}
