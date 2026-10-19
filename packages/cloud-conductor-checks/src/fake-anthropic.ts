import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/** A content block as it appears on the Anthropic Messages wire. */
export type WireBlock = Record<string, unknown> & { type: string; cache_control?: unknown };

export interface WireMessage {
  role: 'user' | 'assistant';
  content: string | WireBlock[];
}

export interface WireRequestBody {
  model?: string;
  system?: string | WireBlock[];
  messages: WireMessage[];
  tools?: Array<Record<string, unknown>>;
  cache_control?: unknown;
  thinking?: unknown;
  stream?: boolean;
  [key: string]: unknown;
}

export type RequestKind = 'main' | 'summary';

/** One request exactly as it reached the fake endpoint. */
export interface RecordedRequest {
  /** Zero-based arrival order across all requests. */
  readonly index: number;
  readonly kind: RequestKind;
  /** The request body bytes, as sent. */
  readonly raw: string;
  readonly body: WireRequestBody;
  /** Set by the conversation driver: the user turn this request belongs to. */
  turn?: number;
}

/** A thinking block the fake returned, to be found again in later requests. */
export interface EmittedThinking {
  readonly requestIndex: number;
  readonly block:
    | { type: 'thinking'; thinking: string; signature: string }
    | { type: 'redacted_thinking'; data: string };
}

export type ThinkingMode = 'signed' | 'redacted' | 'none';

export type ScriptedReply =
  | {
      readonly kind: 'tool';
      readonly thinking: ThinkingMode;
      readonly name: string;
      readonly input: Record<string, unknown>;
    }
  | { readonly kind: 'text'; readonly thinking: ThinkingMode; readonly text: string }
  | { readonly kind: 'error'; readonly status: number; readonly body: unknown };

export interface FakeAnthropicServer {
  /** Base URL to put on the connection (`/v1/messages` is appended by the SDK). */
  readonly url: string;
  readonly requests: RecordedRequest[];
  readonly emittedThinking: EmittedThinking[];
  /** Queue replies for the next main-loop requests, in order. */
  enqueue(...replies: ScriptedReply[]): void;
  /** Replies still queued; a finished script leaves none. */
  pending(): number;
  /** Drop queued replies and return how many were dropped. */
  clear(): number;
  close(): Promise<void>;
}

const SUMMARY_OUTPUT_TOKENS = 600;

/** The summarizer's trailing instruction (`history-compact-summarizer.ts`). */
const SUMMARY_REQUEST_MARKER = 'Now write the structured summary of the conversation above.';

/** A summary that passes Maka's checkpoint validation (`history-compact-summary-validation.ts`). */
function summaryText(requestIndex: number): string {
  return [
    '## Goal',
    `Continue the scripted research conversation (summary ${requestIndex}).`,
    '',
    '## Progress',
    '- Earlier turns looked up topics and fetched documents.',
    '',
    '## Next Steps',
    '1. Continue with the next user request.',
    '',
    '## Critical Context',
    '- (none)',
  ].join('\n');
}

export function isSummaryRequest(body: WireRequestBody): boolean {
  const last = body.messages.at(-1);
  if (!last || last.role !== 'user') return false;
  const blocks =
    typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
  return blocks.some(
    (block) => typeof block.text === 'string' && block.text.includes(SUMMARY_REQUEST_MARKER),
  );
}

/**
 * A local Anthropic Messages endpoint that records every request body and
 * answers from a script, streaming the same SSE events the real API sends.
 */
export async function startFakeAnthropic(): Promise<FakeAnthropicServer> {
  const requests: RecordedRequest[] = [];
  const emittedThinking: EmittedThinking[] = [];
  const queue: ScriptedReply[] = [];

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'POST' || !request.url?.endsWith('/v1/messages')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error' } }));
      return;
    }
    const raw = await readBody(request);
    const body = JSON.parse(raw) as WireRequestBody;
    const index = requests.length;
    const kind: RequestKind = isSummaryRequest(body) ? 'summary' : 'main';
    requests.push({ index, kind, raw, body });
    const inputTokens = Math.ceil(raw.length / 4);
    if (kind === 'summary') {
      // A real checkpoint summary runs to hundreds of tokens; Maka rejects a
      // fold whose summary is under 200 output tokens for a large span.
      writeReply(
        response,
        index,
        inputTokens,
        { kind: 'text', thinking: 'none', text: summaryText(index) },
        emittedThinking,
        body.stream === true,
        SUMMARY_OUTPUT_TOKENS,
      );
      return;
    }
    const reply = queue.shift();
    if (!reply) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: `fake script exhausted at request ${index}` },
        }),
      );
      return;
    }
    if (reply.kind === 'error') {
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply.body));
      return;
    }
    writeReply(response, index, inputTokens, reply, emittedThinking, body.stream === true);
  };

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object')
    throw new Error('fake Anthropic server has no address');

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    emittedThinking,
    enqueue: (...replies) => {
      queue.push(...replies);
    },
    pending: () => queue.length,
    clear: () => queue.splice(0).length,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function writeReply(
  response: ServerResponse,
  requestIndex: number,
  inputTokens: number,
  reply: Exclude<ScriptedReply, { kind: 'error' }>,
  emittedThinking: EmittedThinking[],
  stream: boolean,
  outputTokens = 32,
): void {
  const blocks: WireBlock[] = [];
  if (reply.thinking === 'signed') {
    const thinking = `Reasoning for request ${requestIndex}: decide the next step.`;
    const signature = fakeSignature(requestIndex, thinking);
    blocks.push({ type: 'thinking', thinking, signature });
    emittedThinking.push({ requestIndex, block: { type: 'thinking', thinking, signature } });
  } else if (reply.thinking === 'redacted') {
    const data = fakeSignature(requestIndex, 'redacted');
    blocks.push({ type: 'redacted_thinking', data });
    emittedThinking.push({ requestIndex, block: { type: 'redacted_thinking', data } });
  }
  if (reply.kind === 'tool') {
    blocks.push({
      type: 'tool_use',
      id: `toolu_fake_${requestIndex}`,
      name: reply.name,
      input: reply.input,
    });
  } else {
    blocks.push({ type: 'text', text: reply.text });
  }
  const stopReason = reply.kind === 'tool' ? 'tool_use' : 'end_turn';
  const message = {
    id: `msg_fake_${requestIndex}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    stop_sequence: null,
  };
  const usage = {
    input_tokens: inputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  if (!stream) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        ...message,
        content: blocks,
        stop_reason: stopReason,
        usage: { ...usage, output_tokens: outputTokens },
      }),
    );
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (type: string, data: Record<string, unknown>) => {
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  };
  send('message_start', {
    message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } },
  });
  blocks.forEach((block, index) => {
    switch (block.type) {
      case 'thinking':
        send('content_block_start', {
          index,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        });
        send('content_block_delta', {
          index,
          delta: { type: 'thinking_delta', thinking: block.thinking },
        });
        send('content_block_delta', {
          index,
          delta: { type: 'signature_delta', signature: block.signature },
        });
        break;
      case 'redacted_thinking':
        send('content_block_start', { index, content_block: block });
        break;
      case 'tool_use':
        send('content_block_start', { index, content_block: { ...block, input: {} } });
        send('content_block_delta', {
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        });
        break;
      default:
        send('content_block_start', { index, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    }
    send('content_block_stop', { index });
  });
  send('message_delta', {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  send('message_stop', {});
  response.end();
}

/** Deterministic stand-in for an opaque Anthropic signature. */
function fakeSignature(requestIndex: number, text: string): string {
  return createHash('sha256').update(`${requestIndex}\0${text}`).digest('base64');
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
