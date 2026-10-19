import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type {
  EmittedThinking,
  RecordedRequest,
  WireBlock,
  WireRequestBody,
} from '@maka-cloud/conductor-checks';

/**
 * A scripted Anthropic Messages endpoint. Requests from the conductor's
 * session and from planner sessions are told apart by their system prompt and
 * answered from separate scripts. A script step is a reply or a function of
 * the request, which can read earlier tool results and can hold its answer
 * until a test releases it.
 */

export type Lane = 'conductor' | 'planner';

export interface ModelRequest extends RecordedRequest {
  readonly lane: Lane;
}

export type ReplyBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> };

export interface Reply {
  thinking?: 'signed' | 'redacted' | 'none';
  blocks: ReplyBlock[];
  /** Overrides the token counts the fake reports. */
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

export interface ErrorReply {
  error: { status: number; body: unknown };
}

export type Step =
  | Reply
  | ErrorReply
  | ((request: ModelRequest) => Reply | ErrorReply | Promise<Reply | ErrorReply>);

export interface FakeModel {
  readonly url: string;
  readonly requests: ModelRequest[];
  readonly emittedThinking: EmittedThinking[];
  /** Errors thrown by script functions (failed assertions), in order. */
  readonly failures: unknown[];
  script(lane: Lane, ...steps: Step[]): void;
  pending(lane: Lane): number;
  close(): Promise<void>;
}

export const PLANNER_MARKER = 'You are the planner';

export function tool(name: string, input: Record<string, unknown>): ReplyBlock {
  return { type: 'tool_use', name, input };
}

export function text(value: string): Reply {
  return { thinking: 'signed', blocks: [{ type: 'text', text: value }] };
}

export function calls(...blocks: ReplyBlock[]): Reply {
  return { thinking: 'signed', blocks };
}

export interface SeenToolResult {
  toolUseId: string;
  isError: boolean;
  text: string;
  json?: Record<string, unknown>;
}

/** The tool results the request carries in its last user message. */
export function toolResults(request: ModelRequest): SeenToolResult[] {
  const last = request.body.messages.at(-1);
  if (!last || typeof last.content === 'string') return [];
  return last.content
    .filter((block) => block.type === 'tool_result')
    .map((block) => {
      const content = block.content as string | WireBlock[] | undefined;
      const value =
        typeof content === 'string'
          ? content
          : (content ?? [])
              .map((part) => (typeof part.text === 'string' ? part.text : ''))
              .join('');
      let json: Record<string, unknown> | undefined;
      try {
        const parsed = JSON.parse(value) as unknown;
        if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>;
      } catch {
        json = undefined;
      }
      return {
        toolUseId: String(block.tool_use_id),
        isError: block.is_error === true,
        text: value,
        ...(json ? { json } : {}),
      };
    });
}

/** The text of the request's last user message. */
export function lastUserText(request: ModelRequest): string {
  const last = request.body.messages.at(-1);
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  return last.content.map((block) => (typeof block.text === 'string' ? block.text : '')).join('\n');
}

export async function startFakeModel(): Promise<FakeModel> {
  const requests: ModelRequest[] = [];
  const emittedThinking: EmittedThinking[] = [];
  const failures: unknown[] = [];
  const scripts: Record<Lane, Step[]> = { conductor: [], planner: [] };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'POST' || !request.url?.endsWith('/v1/messages')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error' } }));
      return;
    }
    const raw = await readBody(request);
    const body = JSON.parse(raw) as WireRequestBody;
    const index = requests.length;
    const lane: Lane = JSON.stringify(body.system ?? '').includes(PLANNER_MARKER)
      ? 'planner'
      : 'conductor';
    const recorded: ModelRequest = { index, kind: 'main', raw, body, lane };
    requests.push(recorded);
    const step = scripts[lane].shift();
    if (!step) {
      writeError(response, 500, {
        type: 'error',
        error: { type: 'api_error', message: `fake ${lane} script exhausted at request ${index}` },
      });
      return;
    }
    let reply: Reply | ErrorReply;
    try {
      reply = typeof step === 'function' ? await step(recorded) : step;
    } catch (error) {
      failures.push(error);
      writeError(response, 400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: `script failure: ${String(error)}` },
      });
      return;
    }
    if ('error' in reply) {
      writeError(response, reply.error.status, reply.error.body);
      return;
    }
    writeReply(
      response,
      index,
      Math.ceil(raw.length / 4),
      reply,
      emittedThinking,
      body.stream === true,
    );
  };

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('fake model has no address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    emittedThinking,
    failures,
    script: (lane, ...steps) => {
      scripts[lane].push(...steps);
    },
    pending: (lane) => scripts[lane].length,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function writeError(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function writeReply(
  response: ServerResponse,
  requestIndex: number,
  inputTokens: number,
  reply: Reply,
  emittedThinking: EmittedThinking[],
  stream: boolean,
): void {
  const blocks: WireBlock[] = [];
  if (reply.thinking === 'signed' || reply.thinking === undefined) {
    const thinking = `Reasoning for request ${requestIndex}.`;
    const signature = fakeSignature(requestIndex, thinking);
    blocks.push({ type: 'thinking', thinking, signature });
    emittedThinking.push({ requestIndex, block: { type: 'thinking', thinking, signature } });
  } else if (reply.thinking === 'redacted') {
    const data = fakeSignature(requestIndex, 'redacted');
    blocks.push({ type: 'redacted_thinking', data });
    emittedThinking.push({ requestIndex, block: { type: 'redacted_thinking', data } });
  }
  reply.blocks.forEach((block, position) => {
    if (block.type === 'tool_use') {
      blocks.push({
        type: 'tool_use',
        id: `toolu_fake_${requestIndex}_${position}`,
        name: block.name,
        input: block.input,
      });
    } else {
      blocks.push({ type: 'text', text: block.text });
    }
  });
  const stopReason = reply.blocks.some((block) => block.type === 'tool_use')
    ? 'tool_use'
    : 'end_turn';
  const message = {
    id: `msg_fake_${requestIndex}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    stop_sequence: null,
  };
  const usage = {
    input_tokens: reply.usage?.input ?? inputTokens,
    cache_creation_input_tokens: reply.usage?.cacheWrite ?? 0,
    cache_read_input_tokens: reply.usage?.cacheRead ?? 0,
  };
  const outputTokens = reply.usage?.output ?? 32;
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

function fakeSignature(requestIndex: number, value: string): string {
  return createHash('sha256').update(`${requestIndex}\0${value}`).digest('base64');
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

/** A refused tool call's text without the runtime's "Error: " prefix. */
export function refusal(result: SeenToolResult | undefined): string {
  return (result?.text ?? '').replace(/^Error: /, '');
}
