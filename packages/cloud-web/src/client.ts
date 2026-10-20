import {
  routes,
  type AnswerRequest,
  type AnswerResult,
  type ArtifactContent,
  type ArtifactListing,
  type Conversation,
  type FeedEvent,
  type InboxAnswerRequest,
  type InboxAnswerResult,
  type TaskControl,
  type TaskView,
} from './contract';

/** A refused request. `code` is the server's error code, when it sent one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    /** The error body, as the server sent it (a refused inbox answer carries the refreshed item). */
    readonly body?: unknown,
  ) {
    super(`Request failed (${status}).`);
  }
}
/** The server has no such feature: its route answered 404 or 405. */
export class Unsupported extends Error {}

/** Authenticated fetch SSE: native EventSource cannot carry the invite header. */
export async function readEvents(
  response: Response,
  receive: (event: FeedEvent) => void,
): Promise<void> {
  if (!response.body) throw new Error('Missing event stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let kind = '';
  let id = '';
  let data: string[] = [];
  const line = (text: string) => {
    if (text === '') {
      if (data.length && /^\d{1,15}$/.test(id)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.join('\n'));
        } catch {
          // A frame that is not JSON is skipped; the ones after it still count.
        }
        if (typeof parsed === 'object' && parsed !== null) {
          receive({ id: Number(id), kind, data: parsed } as FeedEvent);
        }
      }
      kind = '';
      id = '';
      data = [];
      return;
    }
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    const value = colon < 0 ? '' : text.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') id = value;
    if (field === 'event') kind = value;
    if (field === 'data') data.push(value);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Keep a trailing CR until the next chunk (CRLF may split across chunks).
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\n|\r(?!$)/.exec(buffer))) {
        line(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
      if (buffer.length > 1_048_576) throw new Error('Event is too large');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export interface ClientOptions {
  fetcher?: typeof fetch;
  /** Prefix for every path. Empty: same origin, as the built app is served. */
  baseUrl?: string;
  /** Called when the server says the invite is no longer valid (401). */
  onRevoked?: () => void;
}

export class CloudClient {
  /** Features whose routes answered 404/405 on this connection; their controls stay hidden. */
  readonly unsupported = new Set<string>();
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly onRevoked: (() => void) | undefined;
  constructor(
    private readonly token: string,
    options: ClientOptions | typeof fetch = {},
  ) {
    const resolved = typeof options === 'function' ? { fetcher: options } : options;
    this.fetcher = resolved.fetcher ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = resolved.baseUrl ?? '';
    this.onRevoked = resolved.onRevoked;
  }

  private async send(path: string, init: RequestInit = {}, feature?: string): Promise<Response> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...init.headers,
        Authorization: `Bearer ${this.token}`,
      },
    });
    if (response.ok) return response;
    if (response.status === 401) this.onRevoked?.();
    if (feature && (response.status === 404 || response.status === 405)) {
      this.unsupported.add(feature);
      throw new Unsupported('This action is not available on this server.');
    }
    const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
    throw new ApiError(
      response.status,
      typeof body?.error === 'string' ? body.error : undefined,
      body,
    );
  }

  async request<T>(path: string, init: RequestInit = {}, feature?: string): Promise<T> {
    const response = await this.send(path, init, feature);
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }

  listConversations() {
    return this.request<{ conversations: Conversation[] }>(routes.conversations);
  }
  createConversation() {
    return this.request<{ conversationId: string }>(routes.conversations, {
      method: 'POST',
      body: '{}',
    });
  }
  postMessage(id: string, text: string, clientMessageId: string) {
    return this.request<{ messageId: string }>(routes.messages(id), {
      method: 'POST',
      body: JSON.stringify({ text, clientMessageId }),
    });
  }
  async listTasks(id: string): Promise<TaskView[]> {
    const result: TaskView[] = [];
    let after = 0;
    for (;;) {
      const page = await this.request<{ tasks: TaskView[]; next?: number }>(
        `${routes.tasks(id)}?after=${after}&limit=200`,
      );
      result.push(...page.tasks);
      if (page.next === undefined) return result;
      if (page.next <= after) throw new Error('Invalid task cursor');
      after = page.next;
    }
  }
  /** The server answers with the task's view; the event stream carries the same change. */
  async control(task: string, action: TaskControl): Promise<void> {
    await this.request<unknown>(routes.control(task, action), { method: 'POST', body: '{}' });
  }
  /** A 404 is a question that is gone or not yours: the route is absent only where no conductor runs, and then there is no question. */
  answer(id: string, answer: AnswerRequest) {
    return this.request<AnswerResult>(routes.answers(id), {
      method: 'POST',
      body: JSON.stringify(answer),
    });
  }
  /** 200 closed or recorded, 202 still being delivered; a refusal is an ApiError whose body may carry the refreshed item. */
  answerInbox(item: string, answer: InboxAnswerRequest) {
    return this.request<InboxAnswerResult>(routes.inboxAnswer(item), {
      method: 'POST',
      body: JSON.stringify(answer),
    });
  }
  listArtifacts(task: string) {
    return this.request<{ artifacts: ArtifactListing[]; total: number }>(routes.artifacts(task));
  }
  /** A link is handed back as is; a file arrives as an attachment and is read as inert text. */
  async readArtifact(task: string, index: number): Promise<ArtifactContent> {
    const response = await this.send(routes.artifact(task, index));
    const disposition = response.headers.get('content-disposition');
    if (disposition === null) {
      const link = (await response.json()) as { url?: unknown };
      if (typeof link.url !== 'string') throw new Error('Unexpected artifact response');
      return { kind: 'link', url: link.url };
    }
    const name = /filename="([^"]*)"/u.exec(disposition)?.[1] ?? 'result';
    return { kind: 'text', name, text: await response.text() };
  }

  async subscribe(
    id: string,
    receive: (event: FeedEvent) => void,
    status: (value: string) => void,
    signal: AbortSignal,
  ) {
    let lastId = 0;
    let delay = 500;
    while (!signal.aborted) {
      try {
        const response = await this.fetcher(`${this.baseUrl}${routes.events(id)}`, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'text/event-stream',
            ...(lastId ? { 'Last-Event-ID': String(lastId) } : {}),
          },
          signal,
        });
        if (response.status === 401) {
          this.onRevoked?.();
          status('Invite expired. Reconnect with a valid invite.');
          return;
        }
        if (response.status === 404) {
          status('This conversation is not available.');
          return;
        }
        if (!response.ok) {
          const retry = Number(response.headers.get('Retry-After'));
          if (Number.isFinite(retry) && retry > 0) delay = Math.min(retry * 1000, 60_000);
          throw new ApiError(response.status);
        }
        if (!response.headers.get('content-type')?.includes('text/event-stream'))
          throw new Error('Not an event stream');
        status('Live');
        await readEvents(response, (event) => {
          if (event.id <= lastId) return;
          receive(event);
          lastId = event.id;
          delay = 500;
        });
      } catch {
        if (signal.aborted) return;
      }
      if (signal.aborted) return;
      status('Reconnecting…');
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, delay);
        signal.addEventListener('abort', finish, { once: true });
      });
      delay = Math.min(delay * 2, 10_000);
    }
  }
}
