import {
  routes,
  type AnswerRequest,
  type AnswerResult,
  type Artifact,
  type Capabilities,
  type Capability,
  type Conversation,
  type FeedEvent,
  type TaskView,
} from './contract';

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`Request failed (${status}).`);
  }
}
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
        receive({ id: Number(id), kind, data: JSON.parse(data.join('\n')) } as FeedEvent);
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

export class CloudClient {
  capabilities: Capabilities = {};
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  async request<T>(path: string, init: RequestInit = {}, feature?: Capability): Promise<T> {
    const response = await this.fetcher(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init.headers,
        Authorization: `Bearer ${this.token}`,
      },
    });
    if (feature && (response.status === 404 || response.status === 405)) {
      this.capabilities[feature] = false;
      throw new Unsupported('This action is not available on this server.');
    }
    if (!response.ok) throw new ApiError(response.status);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  async discover(): Promise<void> {
    try {
      this.capabilities = await this.request<Capabilities>(routes.capabilities);
    } catch (error) {
      // Old T4 servers have no discovery route. Unknown is not supported or absent:
      // try an action once; a 404/405 hides only that feature for this connection.
      if (!(error instanceof ApiError) || ![404, 405].includes(error.status)) throw error;
    }
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
  cancel(conversation: string, task: string) {
    return this.request<void>(
      routes.cancel(conversation, task),
      { method: 'POST', body: '{}' },
      'taskCancel',
    );
  }
  pause(conversation: string, task: string, paused: boolean) {
    return this.request<void>(
      routes.pause(conversation, task),
      { method: 'POST', body: JSON.stringify({ paused }) },
      'taskPause',
    );
  }
  answer(id: string, answer: AnswerRequest) {
    return this.request<AnswerResult>(
      routes.answers(id),
      { method: 'POST', body: JSON.stringify(answer) },
      'answers',
    );
  }
  artifact(id: string, ref: string) {
    return this.request<Artifact>(routes.artifact(id, ref), {}, 'artifacts');
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
        const response = await this.fetcher(routes.events(id), {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'text/event-stream',
            ...(lastId ? { 'Last-Event-ID': String(lastId) } : {}),
          },
          signal,
        });
        if (response.status === 401) {
          status('Invite expired. Reconnect with a valid invite.');
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
