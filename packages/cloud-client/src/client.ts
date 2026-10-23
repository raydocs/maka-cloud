import {
  routes,
  type AnswerRequest,
  type AnswerResult,
  type ArtifactContent,
  type ArtifactListing,
  type Conversation,
  type ComputerFrame,
  type ComputerInput,
  type ComputerState,
  type FeedEvent,
  type Grant,
  type HomeCard,
  type InboxAnswerRequest,
  type InboxAnswerResult,
  type InboxItem,
  type Language,
  type MemoryProfile,
  type PersonSettings,
  type Mode,
  type ProjectView,
  type SuggestionsView,
  type RunTimeline,
  type SourceListing,
  type SignedInDevices,
  type SourcePreview,
  type TaskControl,
  type TaskMessageState,
  type TaskView,
} from './contract';
import { randomId } from './ids';

const PICTURE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

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

/** Nothing, not even a heartbeat, arrived for longer than the stream may be silent. */
export class StreamStalled extends Error {
  constructor() {
    super('The event stream went silent.');
    this.name = 'StreamStalled';
  }
}

/** The server writes a heartbeat every 15 s, so twice that and a margin of silence is a dead link. */
export const STREAM_IDLE_MS = 35_000;

/**
 * Authenticated fetch SSE: native EventSource cannot carry the invite header.
 *
 * With `idleMs`, a read that brings nothing for that long throws `StreamStalled`: a connection that
 * hangs without closing (a sleeping laptop, a proxy holding the socket, a phone changing networks)
 * is given up instead of looking live. `onBytes` is called for every chunk, heartbeats included.
 */
export async function readEvents<T = FeedEvent>(
  response: Response,
  receive: (event: T) => void,
  options: { idleMs?: number; onBytes?: () => void } = {},
): Promise<void> {
  if (!response.body) throw new Error('Missing event stream');
  const reader = response.body.getReader();
  const { idleMs, onBytes } = options;
  const read = () =>
    idleMs === undefined
      ? reader.read()
      : new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
          const timer = setTimeout(() => reject(new StreamStalled()), idleMs);
          reader.read().then(
            (result) => {
              clearTimeout(timer);
              resolve(result);
            },
            (error: unknown) => {
              clearTimeout(timer);
              reject(error);
            },
          );
        });
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
          receive({ id: Number(id), kind, data: parsed } as T);
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
      const { done, value } = await read();
      if (done) break;
      onBytes?.();
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
  /** How long the event stream may bring nothing before it is reconnected. Default `STREAM_IDLE_MS`. */
  streamIdleMs?: number;
}

export class CloudClient {
  /** Features whose routes answered 404/405 on this connection; their controls stay hidden. */
  readonly unsupported = new Set<string>();
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly onRevoked: (() => void) | undefined;
  private readonly streamIdleMs: number;
  constructor(
    private readonly token: string,
    options: ClientOptions | typeof fetch = {},
  ) {
    const resolved = typeof options === 'function' ? { fetcher: options } : options;
    // Called bare, never as a method of the client: a platform `fetch` refuses a foreign `this`.
    const given = resolved.fetcher;
    this.fetcher = given ? (input, init) => given(input, init) : globalThis.fetch.bind(globalThis);
    this.baseUrl = resolved.baseUrl ?? '';
    this.onRevoked = resolved.onRevoked;
    this.streamIdleMs = resolved.streamIdleMs ?? STREAM_IDLE_MS;
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
  memory() {
    return this.request<MemoryProfile>('/v1/memory');
  }
  addFact(text: string) {
    return this.request('/v1/memory/facts', { method: 'POST', body: JSON.stringify({ text }) });
  }
  editFact(id: string, text: string) {
    return this.request(`/v1/memory/facts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ text }),
    });
  }
  deleteFact(id: string) {
    return this.request(`/v1/memory/facts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  createConversation(title?: string) {
    return this.request<{ conversationId: string }>(routes.conversations, {
      method: 'POST',
      body: JSON.stringify(title ? { title } : {}),
    });
  }
  postMessage(id: string, text: string, clientMessageId: string, mode?: Mode) {
    return this.request<{ messageId: string }>(routes.messages(id), {
      method: 'POST',
      body: JSON.stringify({ text, clientMessageId, ...(mode === undefined ? {} : { mode }) }),
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
  computerControl(task: string, action: 'takeover' | 'handback') {
    return this.request<ComputerState>(`${routes.computer(task)}/${action}`, {
      method: 'POST',
      body: '{}',
    });
  }
  computerInput(task: string, input: ComputerInput) {
    return this.request(`${routes.computer(task)}/input`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
  async watchComputer(task: string, receive: (frame: ComputerFrame) => void, signal: AbortSignal) {
    const response = await this.send(`${routes.computer(task)}/stream`, { signal });
    await readEvents<{ kind: string; data: ComputerFrame }>(
      response,
      (event) => {
        if (!signal.aborted && event.kind === 'computer') receive(event.data);
      },
      { idleMs: this.streamIdleMs },
    );
    if (!signal.aborted) {
      // EOF can mean a revoked invite, not merely a broken connection.
      await this.send(routes.computer(task), { signal });
      throw new Error('Computer stream ended');
    }
  }
  /** A 404 is a question that is gone or not yours: the route is absent only where no conductor runs, and then there is no question. */
  answer(id: string, answer: AnswerRequest) {
    return this.request<AnswerResult>(routes.answers(id), {
      method: 'POST',
      body: JSON.stringify(answer),
    });
  }
  /** The decisions waiting on this invite, across its conversations. */
  async listInbox(state: 'open' | 'closed' | 'all' = 'open'): Promise<InboxItem[]> {
    const result = await this.request<{ items: InboxItem[] }>(
      `${routes.inboxItems}?state=${state}&limit=200`,
      {},
      'inbox',
    );
    return Array.isArray(result.items) ? result.items : [];
  }
  /** The approvals this invite kept, newest first; `Unsupported` where nothing keeps them. */
  async listGrants(): Promise<Grant[]> {
    const result = await this.request<{ grants: Grant[] }>(routes.grants, {}, 'grants');
    return Array.isArray(result.grants) ? result.grants : [];
  }
  /** Revokes one kept approval; the next such call asks again. */
  revokeGrant(id: string) {
    return this.request(routes.grant(id), { method: 'DELETE' }, 'grants');
  }
  /** Revokes every kept approval for a repository (or all of them); returns how many. */
  async revokeGrants(filter: { repository?: string } = {}): Promise<number> {
    const result = await this.request<{ revoked: number }>(
      routes.grantsRevoke,
      { method: 'POST', body: JSON.stringify(filter) },
      'grants',
    );
    return typeof result.revoked === 'number' ? result.revoked : 0;
  }
  /** Home's cards in the server's order; `Unsupported` on a server without `/v1/home`. */
  async home(): Promise<HomeCard[]> {
    const result = await this.request<{ cards: HomeCard[] }>(routes.home, {}, 'home');
    return Array.isArray(result.cards) ? result.cards : [];
  }
  /** Tells the server the person saw these cards and left Home. */
  homeSeen(cardIds: readonly string[]) {
    return this.request<{ seen: string[]; visitedAt: number }>(routes.homeSeen, {
      method: 'POST',
      body: JSON.stringify({ cardIds }),
    });
  }
  /** Moves a card to just after `after` (first when null) inside its kind; answers the new list. */
  async moveHomeCard(cardId: string, after: string | null): Promise<HomeCard[]> {
    const result = await this.request<{ cards: HomeCard[] }>(routes.homeOrder, {
      method: 'POST',
      body: JSON.stringify({ cardId, after }),
    });
    return Array.isArray(result.cards) ? result.cards : [];
  }
  /** The invite's projects and their duties; `Unsupported` where no duties engine runs. */
  async listProjects(): Promise<ProjectView[]> {
    const result = await this.request<{ projects: ProjectView[] }>(routes.projects, {}, 'projects');
    return Array.isArray(result.projects) ? result.projects : [];
  }
  /** Turns a duty on or off. 409 `not_approved` (the owner has not approved it) and `duty_limit` are refusals. */
  setDutyState(projectId: string, dutyId: string, state: 'active' | 'off') {
    return this.request<{ state: string }>(
      `${routes.projects}/${encodeURIComponent(projectId)}/duties/${encodeURIComponent(dutyId)}`,
      { method: 'PATCH', body: JSON.stringify({ state }) },
      'projects',
    );
  }
  /** The project's suggestion switches; `Unsupported` where cards are off or the project is not the invite's. */
  async listSuggestions(projectId: string): Promise<SuggestionsView> {
    const result = await this.request<{ suggestions: SuggestionsView }>(
      `${routes.projects}/${encodeURIComponent(projectId)}/suggestions`,
      {},
      'suggestions',
    );
    return { kinds: Array.isArray(result.suggestions?.kinds) ? result.suggestions.kinds : [] };
  }
  /** Turns one kind of suggestion on or off for a project. */
  setSuggestionKind(projectId: string, kind: string, enabled: boolean) {
    return this.request<{ kind: string; enabled: boolean }>(
      `${routes.projects}/${encodeURIComponent(projectId)}/suggestions`,
      { method: 'PATCH', body: JSON.stringify({ kind, enabled }) },
      'suggestions',
    );
  }
  /** The person's settings: the language the server speaks to them in. Unsupported on a server without them. */
  settings() {
    return this.request<PersonSettings>(routes.settings, {}, 'settings');
  }
  /** Sets the language the server speaks to the person in; new conversations take it up. */
  setLanguage(language: Language) {
    return this.request<PersonSettings>(
      routes.settings,
      { method: 'PATCH', body: JSON.stringify({ language }) },
      'settings',
    );
  }
  /** The devices signed in to this account, and the ways it signs in. Hidden where the server has no sign-in. */
  devices() {
    return this.request<SignedInDevices>('/v1/auth/sessions', {}, 'devices');
  }
  /** Signs another device out. */
  signOutDevice(sessionId: string) {
    return this.request<void>(
      `/v1/auth/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
      'devices',
    );
  }
  /** Ends this device's own session on the server. Refused (400) for an invite token, which is not a device. */
  endSession() {
    return this.request<void>('/v1/auth/sign-out', { method: 'POST' });
  }
  /** A short non-reversible name for this invite, to key what the browser remembers (never the token). */
  async fingerprint(): Promise<string> {
    const bytes = new TextEncoder().encode(this.token);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest).slice(0, 8)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
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
    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    // Only these four are ever shown as pictures, and never SVG: anything else is inert text.
    if (type !== undefined && PICTURE_TYPES.has(type)) {
      return { kind: 'image', name, blob: await response.blob() };
    }
    return { kind: 'text', name, text: await response.text() };
  }
  /** The run of a task from its log: turns, steps, cost over time. */
  timeline(task: string, page: { after?: number; limit?: number } = {}) {
    const query = new URLSearchParams();
    if (page.after !== undefined) query.set('after', String(page.after));
    if (page.limit !== undefined) query.set('limit', String(page.limit));
    const suffix = query.size > 0 ? `?${query}` : '';
    return this.request<{ timeline: RunTimeline }>(`${routes.timeline(task)}${suffix}`);
  }
  /**
   * Tells the agent working on a task something. It reads it after the step it is in. The same
   * `messageId` sent again applies once, so a retry is safe.
   */
  sendTaskMessage(task: string, text: string, messageId: string = randomId()) {
    return this.request<{ message: { messageId: string; state: TaskMessageState } }>(
      routes.taskMessages(task),
      { method: 'POST', body: JSON.stringify({ text, messageId }) },
    );
  }
  /** Takes a message back before the agent reads it; refused (409) once it has. */
  withdrawTaskMessage(task: string, messageId: string) {
    return this.request<{ message: { messageId: string; state: TaskMessageState } }>(
      routes.taskMessage(task, messageId),
      { method: 'DELETE' },
    );
  }
  /** The pages the task opened; nothing is fetched from them to answer. */
  listSources(task: string) {
    return this.request<{ sources: SourceListing[]; total: number }>(routes.sources(task));
  }
  sourcePreview(task: string, index: number) {
    return this.request<SourcePreview>(routes.sourcePreview(task, index));
  }
  /** The page's own preview image, fetched by the server; the browser never asks the site. */
  async sourceImage(task: string, index: number): Promise<Blob> {
    const response = await this.send(routes.sourceImage(task, index));
    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (type === undefined || !PICTURE_TYPES.has(type))
      throw new Error('Unexpected image response');
    return response.blob();
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
        // Live once bytes arrive (the server opens with a comment), not when the request starts.
        let live = false;
        await readEvents(
          response,
          (event) => {
            if (event.id <= lastId) return;
            receive(event);
            lastId = event.id;
            delay = 500;
          },
          {
            idleMs: this.streamIdleMs,
            onBytes: () => {
              if (live) return;
              live = true;
              status('Live');
            },
          },
        );
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
