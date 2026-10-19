import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import {
  KeyedCounter,
  type Orchestrator,
  OrchestratorError,
  type OperatorAccess,
  reduce,
  toView,
} from '@maka-cloud/orchestrator';
import { z } from 'zod';
import { type ConversationStore, MAX_MESSAGE_BYTES, MAX_TITLE_LENGTH } from './conversations.js';
import { type ArtifactSource, displayName, linkOf, listArtifact } from './artifacts.js';
import type { CostSource } from './cost.js';
import { type FeedEntry, type FeedHub, readFeed } from './feed.js';
import type { InviteInfo, InviteStore } from './invites.js';
import type { PushApi } from './push.js';
import { toPublicView } from './public-view.js';
import type { RateLimiter } from './rate-limit.js';
import type { SqliteTaskStore } from './sqlite-task-store.js';

const MAX_BODY_BYTES = 64 * 1024;
const FEED_PAGE = 100;
const TASK_PAGE_DEFAULT = 50;
const TASK_PAGE_MAX = 200;
const HEARTBEAT_MS = 15_000;
const MAX_LISTED_ARTIFACTS = 500;

export interface HttpLimits {
  /** Open event streams per invite. */
  streamsPerInvite: number;
  /** Open event streams in total. */
  streamsTotal: number;
  /** Message posts per minute per invite. */
  messagesPerMinute: number;
  /** Cancel, pause and resume requests per minute per invite. */
  controlPerMinute: number;
  /** Artifact downloads per minute per invite. */
  artifactsPerMinute: number;
  /** Artifact reads running at once, over all invites. */
  artifactReadsInFlight: number;
  /** How long a stream may leave a write undrained before it is closed. */
  drainTimeoutMs: number;
  heartbeatMs: number;
}

export const DEFAULT_HTTP_LIMITS: HttpLimits = {
  streamsPerInvite: 4,
  streamsTotal: 256,
  messagesPerMinute: 30,
  controlPerMinute: 30,
  artifactsPerMinute: 60,
  artifactReadsInFlight: 8,
  drainTimeoutMs: 30_000,
  heartbeatMs: HEARTBEAT_MS,
};

export interface PostedMessage {
  conversationId: string;
  messageId: string;
  text: string;
  sessionId: string;
}

export interface PublicApiDeps {
  db: DatabaseSync;
  invites: InviteStore;
  conversations: ConversationStore;
  tasks: SqliteTaskStore;
  hub: FeedHub;
  messageLimiter: RateLimiter;
  controlLimiter: RateLimiter;
  orchestrator: Pick<Orchestrator, 'cancelAs' | 'pauseAs' | 'resumeAs' | 'rootSessionOfTask'>;
  costs: CostSource;
  /** Absent when Web Push is not configured; its routes are then 404. */
  push?: PushApi;
  artifacts: ArtifactSource;
  artifactLimiter: RateLimiter;
  limits: HttpLimits;
  onMessage: (message: PostedMessage) => void;
}

const createConversation = z
  .object({ title: z.string().max(MAX_TITLE_LENGTH).optional() })
  .strict();
const pushSubscription = z
  .object({
    endpoint: z.string().min(1).max(2048),
    keys: z
      .object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(64) })
      .strict(),
    expirationTime: z.number().nullable().optional(),
  })
  .strict();
const pushRemoval = z.object({ endpoint: z.string().min(1).max(2048) }).strict();
const postMessage = z
  .object({
    text: z.string().min(1),
    clientMessageId: z.string().min(1).max(128).optional(),
  })
  .strict();

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(code);
  }
}

/** The public routes. Every one of them, the event stream included, needs a valid invite. */
export class PublicApi {
  private readonly streamsByInvite = new KeyedCounter<string>();
  private streams = 0;
  private readonly open = new Set<ServerResponse>();
  private artifactReads = 0;

  constructor(private readonly deps: PublicApiDeps) {}

  get openStreams(): number {
    return this.streams;
  }

  /** Ends every open event stream; clients reconnect with their last id. */
  closeStreams(): void {
    for (const res of [...this.open]) res.end();
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const invite = this.authenticate(req);
      await this.route(req, res, url, invite);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpError) {
        respond(res, error.status, { error: error.code }, error.headers);
        return;
      }
      respond(res, 500, { error: 'internal_error' });
    }
  }

  private authenticate(req: IncomingMessage): InviteInfo {
    const token = bearerToken(req);
    const invite = token === undefined ? undefined : this.deps.invites.resolve(token);
    if (!invite) throw new HttpError(401, 'unauthorized', { 'www-authenticate': 'Bearer' });
    return invite;
  }

  private async route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    invite: InviteInfo,
  ): Promise<void> {
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (path === '/v1/conversations') {
      if (method === 'POST') return this.createConversation(req, res);
      if (method === 'GET') {
        return respond(res, 200, { conversations: this.deps.conversations.list() });
      }
      throw new HttpError(405, 'method_not_allowed', { allow: 'GET, POST' });
    }
    const messages = /^\/v1\/conversations\/([^/]+)\/messages$/u.exec(path);
    if (messages) {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', { allow: 'POST' });
      return this.postMessage(req, res, invite, decodeURIComponent(messages[1] ?? ''));
    }
    const tasks = /^\/v1\/conversations\/([^/]+)\/tasks$/u.exec(path);
    if (tasks) {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', { allow: 'GET' });
      return this.listTasks(res, url, decodeURIComponent(tasks[1] ?? ''));
    }
    const control = /^\/v1\/tasks\/([^/]+)\/(cancel|pause|resume)$/u.exec(path);
    if (control) {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', { allow: 'POST' });
      const action = control[2] as ControlAction;
      return this.control(req, res, invite, decodeURIComponent(control[1] ?? ''), action);
    }
    const artifacts = /^\/v1\/tasks\/([^/]+)\/artifacts(?:\/([^/]+))?$/u.exec(path);
    if (artifacts) {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', { allow: 'GET' });
      const taskId = decodeURIComponent(artifacts[1] ?? '');
      if (artifacts[2] === undefined) return this.listArtifacts(res, taskId);
      return this.readArtifact(res, invite, taskId, decodeURIComponent(artifacts[2]));
    }
    if (path === '/v1/push/key' || path === '/v1/push/subscriptions') {
      const { push } = this.deps;
      if (!push) throw new HttpError(404, 'not_found');
      if (path === '/v1/push/key') {
        if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', { allow: 'GET' });
        return respond(res, 200, { publicKey: push.publicKey });
      }
      if (method === 'POST') return this.subscribePush(req, res, invite, push);
      if (method === 'DELETE') return this.unsubscribePush(req, res, invite, push);
      throw new HttpError(405, 'method_not_allowed', { allow: 'POST, DELETE' });
    }
    if (path === '/v1/events') {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', { allow: 'GET' });
      return this.stream(req, res, url, invite);
    }
    throw new HttpError(404, 'not_found');
  }

  private async createConversation(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = createConversation.safeParse(await readJson(req, true));
    if (!body.success) throw new HttpError(400, 'invalid_request');
    const conversation = this.deps.conversations.create(body.data.title);
    respond(res, 201, { conversationId: conversation.conversationId });
  }

  private async postMessage(
    req: IncomingMessage,
    res: ServerResponse,
    invite: InviteInfo,
    conversationId: string,
  ): Promise<void> {
    const body = postMessage.safeParse(await readJson(req, false));
    if (!body.success || Buffer.byteLength(body.data.text) > MAX_MESSAGE_BYTES) {
      throw new HttpError(400, 'invalid_request');
    }
    if (!this.deps.conversations.exists(conversationId)) throw new HttpError(404, 'not_found');
    const allowed = this.deps.messageLimiter.take(invite.inviteId);
    if (!allowed.ok) {
      throw new HttpError(429, 'quota_exceeded', {
        'retry-after': String(Math.max(1, Math.ceil(allowed.retryAfterMs / 1000))),
      });
    }
    const result = this.deps.conversations.post(
      conversationId,
      body.data.text,
      body.data.clientMessageId,
    );
    if (!result.found) throw new HttpError(404, 'not_found');
    respond(res, 202, { messageId: result.messageId });
    if (!result.duplicate) {
      this.deps.onMessage({
        conversationId,
        messageId: result.messageId,
        text: result.text,
        sessionId: result.sessionId,
      });
    }
  }

  private listTasks(res: ServerResponse, url: URL, conversationId: string): void {
    const sessionId = this.deps.conversations.sessionOf(conversationId);
    if (sessionId === undefined) throw new HttpError(404, 'not_found');
    const after = parseCount(url.searchParams.get('after'), 0);
    const limit = Math.min(
      parseCount(url.searchParams.get('limit'), TASK_PAGE_DEFAULT),
      TASK_PAGE_MAX,
    );
    const page = this.deps.tasks.tasksOfRoot(sessionId, after, limit);
    const tasks = page.flatMap(({ taskId }) => {
      const record = reduce(this.deps.tasks.readTask(taskId)).get(taskId);
      return record ? [toPublicView(toView(record), this.deps.costs.taskCostUsd(taskId))] : [];
    });
    const last = page.at(-1);
    respond(res, 200, {
      tasks,
      ...(last !== undefined && page.length === limit ? { next: last.position } : {}),
    });
  }

  private takeControlToken(invite: InviteInfo): void {
    const allowed = this.deps.controlLimiter.take(invite.inviteId);
    if (allowed.ok) return;
    throw new HttpError(429, 'quota_exceeded', {
      'retry-after': String(Math.max(1, Math.ceil(allowed.retryAfterMs / 1000))),
    });
  }

  private async subscribePush(
    req: IncomingMessage,
    res: ServerResponse,
    invite: InviteInfo,
    push: PushApi,
  ): Promise<void> {
    const body = pushSubscription.safeParse(await readJson(req, false));
    if (!body.success) throw new HttpError(400, 'invalid_request');
    this.takeControlToken(invite);
    const result = push.register(invite.inviteId, {
      endpoint: body.data.endpoint,
      p256dh: body.data.keys.p256dh,
      auth: body.data.keys.auth,
    });
    if (result === 'limit') throw new HttpError(429, 'too_many_subscriptions');
    if (result === 'invalid_endpoint' || result === 'invalid_keys') {
      throw new HttpError(400, result);
    }
    respond(res, result === 'created' ? 201 : 200, {});
  }

  private async unsubscribePush(
    req: IncomingMessage,
    res: ServerResponse,
    invite: InviteInfo,
    push: PushApi,
  ): Promise<void> {
    const body = pushRemoval.safeParse(await readJson(req, false));
    if (!body.success) throw new HttpError(400, 'invalid_request');
    this.takeControlToken(invite);
    if (!push.remove(invite.inviteId, body.data.endpoint)) throw new HttpError(404, 'not_found');
    res.writeHead(204).end();
  }

  /** The artifact references of a task's manifest; 404 for a task that belongs to no conversation. */
  private artifactRefs(taskId: string): string[] {
    const sessionId = this.deps.orchestrator.rootSessionOfTask(taskId);
    if (
      sessionId === undefined ||
      this.deps.conversations.conversationOf(sessionId) === undefined
    ) {
      throw new HttpError(404, 'not_found');
    }
    const record = reduce(this.deps.tasks.readTask(taskId)).get(taskId);
    return record?.manifest?.artifacts ?? [];
  }

  private listArtifacts(res: ServerResponse, taskId: string): void {
    const refs = this.artifactRefs(taskId);
    respond(res, 200, {
      artifacts: refs.slice(0, MAX_LISTED_ARTIFACTS).map((ref, index) => listArtifact(ref, index)),
      total: refs.length,
    });
  }

  /**
   * The references are strings a task wrote. A link is handed back and never
   * fetched; anything else goes to the source, which reads inside the task's own
   * directory only. The bytes are sent as an attachment, never as something a
   * browser renders.
   */
  private async readArtifact(
    res: ServerResponse,
    invite: InviteInfo,
    taskId: string,
    rawIndex: string,
  ): Promise<void> {
    const refs = this.artifactRefs(taskId);
    const ref = /^\d{1,6}$/u.test(rawIndex) ? refs[Number(rawIndex)] : undefined;
    if (ref === undefined) throw new HttpError(404, 'not_found');
    const link = linkOf(ref);
    if (link !== undefined) return respond(res, 200, { url: link });
    const allowed = this.deps.artifactLimiter.take(invite.inviteId);
    if (!allowed.ok) {
      throw new HttpError(429, 'quota_exceeded', {
        'retry-after': String(Math.max(1, Math.ceil(allowed.retryAfterMs / 1000))),
      });
    }
    if (this.artifactReads >= this.deps.limits.artifactReadsInFlight) {
      throw new HttpError(429, 'quota_exceeded', { 'retry-after': '1' });
    }
    this.artifactReads += 1;
    let result: Awaited<ReturnType<ArtifactSource['read']>>;
    try {
      result = await this.deps.artifacts.read(taskId, ref);
    } finally {
      this.artifactReads -= 1;
    }
    if (!result.ok) {
      throw result.reason === 'too_large'
        ? new HttpError(413, 'artifact_too_large')
        : new HttpError(404, 'not_found');
    }
    const name = displayName(ref.split('/').at(-1) ?? '');
    res.writeHead(200, {
      'content-type': name.endsWith('.json')
        ? 'application/json; charset=utf-8'
        : 'text/plain; charset=utf-8',
      'content-length': String(result.bytes.length),
      'content-disposition': `attachment; filename="${name}"`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
    });
    res.end(result.bytes);
  }

  /**
   * Acts on a task for the conversation it belongs to. The invite is checked here
   * and again inside the orchestrator's write chain, so a revoke that lands while
   * the request waits stops it; the credentials the conductor holds are not involved.
   */
  private async control(
    req: IncomingMessage,
    res: ServerResponse,
    invite: InviteInfo,
    taskId: string,
    action: ControlAction,
  ): Promise<void> {
    const { orchestrator, conversations } = this.deps;
    await discard(req);
    const sessionId = orchestrator.rootSessionOfTask(taskId);
    if (sessionId === undefined || conversations.conversationOf(sessionId) === undefined) {
      throw new HttpError(404, 'not_found');
    }
    const allowed = this.deps.controlLimiter.take(invite.inviteId);
    if (!allowed.ok) {
      throw new HttpError(429, 'quota_exceeded', {
        'retry-after': String(Math.max(1, Math.ceil(allowed.retryAfterMs / 1000))),
      });
    }
    const token = bearerToken(req);
    const access: OperatorAccess = {
      sessionId,
      authorize: () => {
        const current = token === undefined ? undefined : this.deps.invites.resolve(token);
        if (!current || current.inviteId !== invite.inviteId) {
          throw new OrchestratorError('unauthorized', 'The invite is no longer valid');
        }
        if (conversations.conversationOf(sessionId) === undefined) {
          throw new OrchestratorError('not_found', 'The conversation no longer exists');
        }
      },
    };
    try {
      const view =
        action === 'cancel'
          ? await orchestrator.cancelAs(access, taskId)
          : action === 'pause'
            ? await orchestrator.pauseAs(access, taskId)
            : await orchestrator.resumeAs(access, taskId);
      respond(res, 200, { task: toPublicView(view, this.deps.costs.taskCostUsd(taskId)) });
    } catch (error) {
      throw error instanceof OrchestratorError ? controlError(error) : error;
    }
  }

  private async stream(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    invite: InviteInfo,
  ): Promise<void> {
    const { db, hub, limits } = this.deps;
    const conversationId = url.searchParams.get('conversation') ?? undefined;
    if (conversationId !== undefined && !this.deps.conversations.exists(conversationId)) {
      throw new HttpError(404, 'not_found');
    }
    const header = req.headers['last-event-id'];
    const raw = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get('after');
    let position = parseCount(raw, 0);

    if (
      this.streams >= limits.streamsTotal ||
      !this.streamsByInvite.tryAcquire(invite.inviteId, limits.streamsPerInvite)
    ) {
      throw new HttpError(429, 'quota_exceeded', { 'retry-after': '1' });
    }
    this.streams += 1;
    this.open.add(res);

    let closed = false;
    let dirty = true;
    let running = false;
    let unsubscribe = () => {};
    let heartbeat: NodeJS.Timeout | undefined;
    // `abandon` drops the socket instead of ending politely: a client that stopped
    // reading would otherwise keep its connection and buffered data after its slot is gone.
    const release = () => {
      if (closed) return false;
      closed = true;
      unsubscribe();
      clearInterval(heartbeat);
      this.streams -= 1;
      this.streamsByInvite.release(invite.inviteId);
      this.open.delete(res);
      return true;
    };
    const finish = (abandon = false) => {
      if (!release()) return;
      if (abandon) res.destroy();
      else if (!res.writableEnded) res.end();
    };
    const drained = async (): Promise<boolean> => {
      const timeout = AbortSignal.timeout(limits.drainTimeoutMs);
      try {
        await once(res, 'drain', { signal: timeout });
        return true;
      } catch {
        return false;
      }
    };
    const write = async (chunk: string): Promise<boolean> =>
      res.write(chunk) || (!closed && (await drained()));
    // Reads the feed after `position` until it is empty. A commit that lands
    // while a pass runs sets `dirty`, so the loop goes around again; nothing
    // is buffered per connection beyond the page being written.
    const pump = async (): Promise<void> => {
      if (running || closed) return;
      running = true;
      try {
        while (dirty && !closed) {
          dirty = false;
          for (;;) {
            const entries = readFeed(db, position, FEED_PAGE, conversationId);
            if (entries.length === 0) break;
            for (const entry of entries) {
              if (closed) return;
              if (!(await write(frame(entry)))) return finish(true);
              position = entry.id;
            }
          }
        }
      } catch {
        finish(true);
      } finally {
        running = false;
      }
    };
    try {
      unsubscribe = hub.subscribe(() => {
        dirty = true;
        void pump();
      });
      heartbeat = setInterval(() => {
        if (!closed) res.write(': keep-alive\n\n');
      }, limits.heartbeatMs);
      heartbeat.unref();
      res.once('close', () => finish());
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': stream open\n\n');
    } catch (error) {
      // Nothing was sent yet, so `handle` can still answer 500 on this response.
      release();
      throw error;
    }
    await pump();
  }
}

type ControlAction = 'cancel' | 'pause' | 'resume';

function bearerToken(req: IncomingMessage): string | undefined {
  return /^Bearer\s+(\S+)$/iu.exec(req.headers.authorization ?? '')?.[1];
}

function controlError(error: OrchestratorError): HttpError {
  switch (error.code) {
    case 'not_found':
      return new HttpError(404, 'not_found');
    case 'unauthorized':
      return new HttpError(401, 'unauthorized', { 'www-authenticate': 'Bearer' });
    case 'quota_exceeded':
      return new HttpError(429, 'quota_exceeded', { 'retry-after': '1' });
    case 'unsupported':
      return new HttpError(409, 'pause_unsupported');
    case 'invalid_state':
      return new HttpError(409, 'invalid_state');
    default:
      return new HttpError(400, 'invalid_request');
  }
}

/** Reads and drops a request body, so a client that sends one is not left hanging. */
async function discard(req: IncomingMessage): Promise<void> {
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.from(chunk).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request_too_large');
  }
}

function frame(entry: FeedEntry): string {
  const data = JSON.stringify({ conversationId: entry.conversationId, ...(entry.data as object) });
  return `id: ${entry.id}\nevent: ${entry.kind}\ndata: ${data}\n\n`;
}

function parseCount(value: string | null | undefined, fallback: number): number {
  if (value === null || value === undefined || value === '') return fallback;
  if (!/^\d{1,15}$/u.test(value)) throw new HttpError(400, 'invalid_request');
  return Number(value);
}

function respond(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res
    .writeHead(status, { 'content-type': 'application/json', ...headers })
    .end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, allowEmpty: boolean): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request_too_large');
    chunks.push(buffer);
  }
  if (size === 0) {
    if (allowEmpty) return {};
    throw new HttpError(400, 'invalid_request');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}
