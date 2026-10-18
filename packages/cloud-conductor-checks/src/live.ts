import { createServer, type IncomingMessage, type Server } from 'node:http';
import { checkHistory, type HistoryCheckReport } from './checks.js';
import {
  isSummaryRequest,
  type EmittedThinking,
  type RecordedRequest,
  type WireBlock,
  type WireRequestBody,
} from './fake-anthropic.js';
import { conversationTools, DEFAULT_TURNS } from './conversation.js';
import { startHarness, type HarnessSettings } from './harness.js';
import { isRuntimeEnvironmentBlock } from './runs.js';

/**
 * Live mode: the same conversation against the real Anthropic API, through a
 * local recording proxy so the same checks run on real traffic. It spends
 * money, so it runs only when both ANTHROPIC_API_KEY and MAKA_CLOUD_LIVE=1
 * are set.
 */

export const LIVE_UPSTREAM = 'https://api.anthropic.com';

export function liveModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY) && env.MAKA_CLOUD_LIVE === '1';
}

export interface LiveRequestUsage {
  readonly request: number;
  readonly turn?: number;
  readonly status: number;
  readonly inputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly outputTokens?: number;
  /** The error body of a non-2xx response, e.g. a 400 about thinking blocks. */
  readonly error?: string;
}

export interface LiveResult {
  readonly usage: LiveRequestUsage[];
  readonly report: HistoryCheckReport;
}

interface RecordingProxy {
  readonly url: string;
  readonly requests: RecordedRequest[];
  readonly emittedThinking: EmittedThinking[];
  readonly usage: LiveRequestUsage[];
  close(): Promise<void>;
}

const FORWARDED_HEADERS = [
  'x-api-key',
  'authorization',
  'anthropic-version',
  'anthropic-beta',
  'content-type',
];

async function startRecordingProxy(upstream: string): Promise<RecordingProxy> {
  const requests: RecordedRequest[] = [];
  const emittedThinking: EmittedThinking[] = [];
  const usage: LiveRequestUsage[] = [];
  const server: Server = createServer((incoming, outgoing) => {
    void (async () => {
      const raw = await readBody(incoming);
      const body = JSON.parse(raw) as WireRequestBody;
      const index = requests.length;
      requests.push({ index, kind: isSummaryRequest(body) ? 'summary' : 'main', raw, body });
      const headers: Record<string, string> = {};
      for (const name of FORWARDED_HEADERS) {
        const value = incoming.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      const response = await fetch(`${upstream}${incoming.url ?? ''}`, {
        method: incoming.method ?? 'POST',
        headers,
        body: raw,
      });
      const text = await response.text();
      const contentType = response.headers.get('content-type') ?? 'application/json';
      outgoing.writeHead(response.status, { 'content-type': contentType });
      outgoing.end(text);
      if (!response.ok) {
        usage.push({ request: index, status: response.status, error: text.slice(0, 2_000) });
        return;
      }
      const parsed = contentType.includes('text/event-stream') ? parseSse(text) : parseJson(text);
      usage.push({ request: index, status: response.status, ...parsed.usage });
      for (const block of parsed.thinking) emittedThinking.push({ requestIndex: index, block });
    })().catch((error: unknown) => {
      outgoing.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('recording proxy has no address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    emittedThinking,
    usage,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

interface ParsedResponse {
  usage: Omit<LiveRequestUsage, 'request' | 'status' | 'turn' | 'error'>;
  thinking: EmittedThinking['block'][];
}

type MutableUsage = {
  -readonly [K in keyof ParsedResponse['usage']]: ParsedResponse['usage'][K];
};

function usageFields(source: Record<string, unknown> | undefined, into: MutableUsage): void {
  if (!source) return;
  const number = (key: string) =>
    typeof source[key] === 'number' ? (source[key] as number) : undefined;
  into.inputTokens = number('input_tokens') ?? into.inputTokens;
  into.cacheReadInputTokens = number('cache_read_input_tokens') ?? into.cacheReadInputTokens;
  into.cacheCreationInputTokens =
    number('cache_creation_input_tokens') ?? into.cacheCreationInputTokens;
  into.outputTokens = number('output_tokens') ?? into.outputTokens;
}

function thinkingBlocks(blocks: readonly WireBlock[]): EmittedThinking['block'][] {
  const out: EmittedThinking['block'][] = [];
  for (const block of blocks) {
    if (block.type === 'thinking') {
      out.push({
        type: 'thinking',
        thinking: String(block.thinking ?? ''),
        signature: String(block.signature ?? ''),
      });
    } else if (block.type === 'redacted_thinking') {
      out.push({ type: 'redacted_thinking', data: String(block.data ?? '') });
    }
  }
  return out;
}

function parseJson(text: string): ParsedResponse {
  const message = JSON.parse(text) as { usage?: Record<string, unknown>; content?: WireBlock[] };
  const usage: MutableUsage = {};
  usageFields(message.usage, usage);
  return { usage, thinking: thinkingBlocks(message.content ?? []) };
}

function parseSse(text: string): ParsedResponse {
  const usage: MutableUsage = {};
  const blocks: WireBlock[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const event = JSON.parse(line.slice(6)) as Record<string, unknown> & {
      type: string;
      index?: number;
      delta?: Record<string, unknown>;
    };
    switch (event.type) {
      case 'message_start':
        usageFields(
          (event.message as { usage?: Record<string, unknown> } | undefined)?.usage,
          usage,
        );
        break;
      case 'message_delta':
        usageFields(event.usage as Record<string, unknown> | undefined, usage);
        break;
      case 'content_block_start':
        blocks[event.index ?? blocks.length] = { ...(event.content_block as WireBlock) };
        break;
      case 'content_block_delta': {
        const block = blocks[event.index ?? -1];
        const delta = event.delta ?? {};
        if (!block) break;
        if (delta.type === 'thinking_delta')
          block.thinking = `${block.thinking ?? ''}${delta.thinking}`;
        if (delta.type === 'signature_delta')
          block.signature = `${block.signature ?? ''}${delta.signature}`;
        break;
      }
      default:
        break;
    }
  }
  return { usage, thinking: thinkingBlocks(blocks.filter(Boolean)) };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

/** Run the conversation live. Callers must check `liveModeEnabled()` first. */
export async function runLive(
  options: { turns?: number; settings?: HarnessSettings; env?: NodeJS.ProcessEnv } = {},
): Promise<LiveResult> {
  const env = options.env ?? process.env;
  if (!liveModeEnabled(env)) {
    throw new Error('live mode needs ANTHROPIC_API_KEY and MAKA_CLOUD_LIVE=1');
  }
  const proxy = await startRecordingProxy(LIVE_UPSTREAM);
  const harness = await startHarness({
    baseUrl: proxy.url,
    apiKey: env.ANTHROPIC_API_KEY!,
    tools: conversationTools(1_200),
    settings: options.settings ?? { contextBudget: 'default' },
  });
  try {
    const turns = options.turns ?? DEFAULT_TURNS;
    for (let turn = 1; turn <= turns; turn += 1) {
      const first = proxy.requests.length;
      const tool = turn % 2 === 0 ? 'fetch_doc with id doc-' : 'lookup with topic topic-';
      await harness.send(
        `turn-${turn}`,
        `Turn ${turn}: call ${tool}${turn}, then answer in one sentence.`,
      );
      for (const request of proxy.requests.slice(first)) request.turn = turn;
    }
    const turnOf = new Map(proxy.requests.map((request) => [request.index, request.turn]));
    return {
      usage: proxy.usage.map((entry) => {
        const turn = turnOf.get(entry.request);
        return turn === undefined ? entry : { ...entry, turn };
      }),
      report: checkHistory(proxy.requests, proxy.emittedThinking, {
        isRequestOnlyBlock: isRuntimeEnvironmentBlock,
      }),
    };
  } finally {
    await harness.close();
    await proxy.close();
  }
}
