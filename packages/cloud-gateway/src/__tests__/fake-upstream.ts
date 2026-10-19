/** A scripted vendor API for the gateway's tests: no network, explicit handshakes. */

export interface SeenRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
  signal: AbortSignal;
}

type Handler = (request: SeenRequest) => Response | Promise<Response>;

/** A response body the test writes to, chunk by chunk. It fails when the request is aborted. */
export class ControlledBody {
  readonly stream: ReadableStream<Uint8Array>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private closed = false;
  /** Resolves once the gateway aborted the request. */
  readonly aborted: Promise<void>;

  constructor(signal: AbortSignal) {
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.aborted = new Promise((resolve) => {
      const onAbort = (): void => {
        if (!this.closed) {
          this.closed = true;
          this.controller.error(new DOMException('aborted', 'AbortError'));
        }
        resolve();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  push(text: string): void {
    if (!this.closed) this.controller.enqueue(new TextEncoder().encode(text));
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.close();
  }
}

export class FakeUpstream {
  readonly requests: SeenRequest[] = [];
  private readonly handlers: Handler[] = [];
  private waiters: Array<() => void> = [];

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const signal = init?.signal ?? new AbortController().signal;
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const raw = init?.body;
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
    const request: SeenRequest = {
      url,
      headers: new Headers(init?.headers),
      body: JSON.parse(text) as Record<string, unknown>,
      signal,
    };
    this.requests.push(request);
    for (const wake of this.waiters.splice(0)) wake();
    const handler = this.handlers.shift();
    if (!handler) throw new Error(`no scripted response for ${url}`);
    return handler(request);
  }) as typeof fetch;

  /** The next request gets this answer. */
  next(handler: Handler): this {
    this.handlers.push(handler);
    return this;
  }

  /** Resolves once `count` requests have arrived. */
  async received(count: number): Promise<void> {
    while (this.requests.length < count) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

export function sse(events: ReadonlyArray<Record<string, unknown>>): string {
  return events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function anthropicStart(usage: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'message_start',
    message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], usage },
  };
}

export function anthropicEnd(usage: Record<string, unknown>): Array<Record<string, unknown>> {
  return [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage },
    { type: 'message_stop' },
  ];
}

/** A whole Anthropic stream with the given usage. */
export function anthropicStream(input: number, output: number): Response {
  return new Response(
    sse([
      anthropicStart({ input_tokens: input, output_tokens: 1 }),
      ...anthropicEnd({ output_tokens: output }),
    ]),
    {
      headers: { 'content-type': 'text/event-stream', 'request-id': 'req_1', 'set-cookie': 'a=b' },
    },
  );
}

/** A whole Responses API stream with the given usage. */
export function openAiStream(input: number, cached: number, output: number): Response {
  return new Response(
    sse([
      { type: 'response.created', response: { id: 'resp_1' } },
      { type: 'response.output_text.delta', delta: 'done' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          usage: {
            input_tokens: input,
            input_tokens_details: { cached_tokens: cached },
            output_tokens: output,
          },
        },
      },
    ]),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

/** Reads a response body to the end as text. */
export async function text(response: Response): Promise<string> {
  return new TextDecoder().decode(await response.arrayBuffer());
}
