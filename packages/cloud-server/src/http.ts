import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { MemoryError, type MemoryStore } from '@maka-cloud/memory';
import {
  KeyedCounter,
  MAX_STEER_CHARS,
  type Orchestrator,
  OrchestratorError,
  type OperatorAccess,
  reduce,
  toView,
} from '@maka-cloud/orchestrator';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { ConversationPublisher } from './conductor-feed.js';
import type { ComputerSource } from './computer.js';
import { type ConversationStore, MAX_MESSAGE_BYTES, MAX_TITLE_LENGTH } from './conversations.js';
import {
  type ArtifactSource,
  displayName,
  imageTypeOf,
  linkOf,
  listArtifact,
} from './artifacts.js';
import { type OpenedPages, type PreviewService, PreviewBusy, siteOf } from './previews.js';
import { type FeedEntry, type FeedHub, readOwnFeed } from './feed.js';
import type { DutyRoutes } from './duties.js';
import type { InboxRoutes } from './inbox.js';
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
const MAX_LISTED_SOURCES = 20;

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
  /** Source previews (a title or an image of a page the task opened) asked per minute per invite. */
  previewsPerMinute: number;
  /** How long a stream may leave a write undrained before it is closed. */
  drainTimeoutMs: number;
  heartbeatMs: number;
  /**
   * How often open streams look for revokes made by another process (the
   * command line). A revoke made through this server's own store closes its
   * streams at once, and every frame is preceded by a check either way.
   */
  revokeCheckMs: number;
}

export const DEFAULT_HTTP_LIMITS: HttpLimits = {
  streamsPerInvite: 4,
  streamsTotal: 256,
  messagesPerMinute: 30,
  controlPerMinute: 30,
  artifactsPerMinute: 60,
  artifactReadsInFlight: 8,
  previewsPerMinute: 60,
  drainTimeoutMs: 30_000,
  heartbeatMs: HEARTBEAT_MS,
  revokeCheckMs: 1000,
};

export interface PostedMessage {
  conversationId: string;
  messageId: string;
  text: string;
  sessionId: string;
}

export interface PostedAnswer {
  conversationId: string;
  questionId: string;
  optionId: string;
  text?: string;
  sessionId: string;
  /** The invite that answered. It owns the conversation; it is checked again where the answer takes effect. */
  caller: string;
}

/**
 * The handler's verdict on an answer. Answers are idempotent per question: the
 * same option again is a duplicate, a different one a conflict.
 */
export type AnswerOutcome =
  | { accepted: true; duplicate: boolean }
  | {
      accepted: false;
      reason: 'not_found' | 'not_open' | 'unknown_option' | 'conflict' | 'closed' | 'text_too_long';
    };

export const MAX_ANSWER_TEXT_LENGTH = 4000;

const ANSWER_STATUS: Record<Extract<AnswerOutcome, { accepted: false }>['reason'], number> = {
  not_found: 404,
  not_open: 409,
  conflict: 409,
  closed: 409,
  unknown_option: 400,
  text_too_long: 400,
};

export interface PublicApiDeps {
  db: DatabaseSync;
  memory: MemoryStore;
  invites: InviteStore;
  conversations: ConversationStore;
  tasks: SqliteTaskStore;
  hub: FeedHub;
  messageLimiter: RateLimiter;
  controlLimiter: RateLimiter;
  orchestrator: Pick<
    Orchestrator,
    'cancelAs' | 'pauseAs' | 'resumeAs' | 'rootSessionOfTask' | 'steerAs' | 'withdrawSteerAs'
  >;
  /** Absent when Web Push is not configured; its routes are then 404. */
  push?: PushApi;
  artifacts: ArtifactSource;
  computer?: ComputerSource;
  publisher?: ConversationPublisher;
  artifactLimiter: RateLimiter;
  /** The pages tasks opened, and the proxy that fetches their previews. */
  opened: OpenedPages;
  previews: PreviewService;
  previewLimiter: RateLimiter;
  limits: HttpLimits;
  /**
   * Called after a post, a retried one included: the message is stored with a
   * pending delivery, and this asks for an attempt now.
   */
  onMessage: (message: PostedMessage) => void;
  /** Absent when no handler takes answers; the route then answers 404. */
  onAnswer?: (answer: PostedAnswer) => Promise<AnswerOutcome>;
  /** Absent when no supervisor runs; the `/v1/inbox` routes then answer 404. */
  inbox?: InboxRoutes;
  /** Absent when no duties engine runs; `/github/webhook` and `/v1/projects` then answer like any unknown path. */
  duties?: DutyRoutes;
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
const taskMessage = z
  .object({
    text: z.string().min(1).max(MAX_STEER_CHARS),
    messageId: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{1,64}$/u)
      .optional(),
  })
  .strict();
const postAnswer = z
  .object({
    questionId: z.string().min(1).max(128),
    optionId: z.string().min(1).max(128),
    text: z.string().max(MAX_ANSWER_TEXT_LENGTH).optional(),
  })
  .strict();

const computerInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('terminal'), text: z.string().min(1).max(4000) }).strict(),
  z.object({ type: z.literal('key'), key: z.string().min(1).max(64) }).strict(),
  z
    .object({
      type: z.literal('pointer'),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      button: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    })
    .strict(),
]);

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(code);
  }
}

/**
 * The public routes. Every one of them, the event stream included, needs a
 * valid invite, and each invite sees only what it owns: the conversations it
 * created and the tasks, artifacts, inbox items and feed rows that belong to
 * them. Anything else answers 404, never 403, so a client cannot tell another
 * owner's object from one that does not exist. Writes check the invite again
 * once the body is read, right before their effect.
 */
export class PublicApi {
  private readonly streamsByInvite = new KeyedCounter<string>();
  private streams = 0;
  private closing = false;
  private readonly open = new Set<ServerResponse>();
  /** How to end each open stream, by the invite it was opened with. */
  private readonly streamEnds = new Map<string, Set<() => void>>();
  private stopWatching: (() => void) | undefined;
  private artifactReads = 0;
  private readonly humanComputers = new Map<string, { inviteId: string; abort: AbortController }>();
  private readonly busyComputers = new Set<string>();

  constructor(private readonly deps: PublicApiDeps) {}

  get openStreams(): number {
    return this.streams;
  }

  /** Whether streams are watching for revokes (a listener and a timer); only while a stream is open. */
  get watchingRevokes(): boolean {
    return this.stopWatching !== undefined;
  }

  /** Ends every open event stream; clients reconnect with their last id. */
  closeStreams(): void {
    this.closing = true;
    for (const res of [...this.open]) res.end();
    for (const taskId of [...this.humanComputers.keys()]) this.releaseComputer(taskId);
  }

  /** Ends the streams of invites that are no longer active. */
  private endRevokedStreams(only?: string): void {
    for (const [inviteId, ends] of [...this.streamEnds]) {
      if (only !== undefined && inviteId !== only) continue;
      if (this.deps.invites.active(inviteId)) continue;
      for (const end of [...ends]) end();
    }
    for (const [taskId, lease] of this.humanComputers) {
      if (only !== undefined && lease.inviteId !== only) continue;
      if (!this.deps.invites.active(lease.inviteId)) this.releaseComputer(taskId);
    }
  }

  /** Starts watching for revokes with the first open stream; `unwatch` stops with the last. */
  private watch(): void {
    if (this.stopWatching) return;
    const { invites, limits } = this.deps;
    const unsubscribe = invites.onRevoke((inviteId) => this.endRevokedStreams(inviteId));
    invites.changedElsewhere();
    const timer = setInterval(() => {
      try {
        invites.changedElsewhere();
        this.endRevokedStreams();
        for (const taskId of this.humanComputers.keys()) {
          if (!this.busyComputers.has(taskId) && this.computerTask(taskId)?.state !== 'paused') {
            this.releaseComputer(taskId);
          }
        }
      } catch {
        // The invites file is closing with the server; the streams end with it.
      }
    }, limits.revokeCheckMs);
    timer.unref();
    this.stopWatching = () => {
      unsubscribe();
      clearInterval(timer);
    };
  }

  private unwatch(): void {
    if (this.streams > 0 || this.humanComputers.size > 0) return;
    this.stopWatching?.();
    this.stopWatching = undefined;
  }

  /**
   * The one route without an invite, for a proxy or a supervisor to ask whether to send
   * traffic here. The body never says more than ok or unavailable: no counts, no names.
   */
  private health(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      respond(res, 405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD' });
      return;
    }
    let ok = !this.closing;
    if (ok) {
      try {
        this.deps.db.prepare('SELECT 1').get();
        this.deps.invites.active('health');
      } catch {
        ok = false;
      }
    }
    respond(
      res,
      ok ? 200 : 503,
      { status: ok ? 'ok' : 'unavailable' },
      { 'cache-control': 'no-store' },
    );
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/healthz') {
        this.health(req, res);
        return;
      }
      // GitHub signs its webhooks instead of presenting an invite; the engine verifies the signature.
      if (url.pathname === '/github/webhook' && this.deps.duties) {
        await this.deps.duties.webhook(req, res);
        return;
      }
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
      if (error instanceof MemoryError) {
        respond(res, error.code === 'invalid_fact' ? 400 : 409, { error: error.code });
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

  /**
   * The invite again, after the body was read and right before a side effect:
   * one revoked while its request was still arriving does nothing.
   */
  reauthenticate(invite: InviteInfo): void {
    if (!this.deps.invites.active(invite.inviteId)) {
      throw new HttpError(401, 'unauthorized', { 'www-authenticate': 'Bearer' });
    }
  }

  /** The conversation's orchestrator session, or 404 when the invite does not own it. */
  private ownSession(invite: InviteInfo, conversationId: string): string {
    const { conversations } = this.deps;
    const sessionId = conversations.sessionOf(conversationId);
    if (sessionId === undefined || !conversations.owns(invite.inviteId, conversationId)) {
      throw new HttpError(404, 'not_found');
    }
    return sessionId;
  }

  /** The root session of a task in a conversation the invite owns, or 404. */
  private ownTaskSession(invite: InviteInfo, taskId: string): string {
    const sessionId = this.deps.orchestrator.rootSessionOfTask(taskId);
    const conversationId =
      sessionId === undefined ? undefined : this.deps.conversations.conversationOf(sessionId);
    if (
      sessionId === undefined ||
      conversationId === undefined ||
      !this.deps.conversations.owns(invite.inviteId, conversationId)
    ) {
      throw new HttpError(404, 'not_found');
    }
    return sessionId;
  }

  private async route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    invite: InviteInfo,
  ): Promise<void> {
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (path === '/v1/memory' && method === 'GET') {
      return respond(res, 200, this.deps.memory.profile(invite.inviteId));
    }
    const fact = /^\/v1\/memory\/facts(?:\/([^/]+))?$/u.exec(path);
    if (fact) {
      const id = fact[1];
      if (id !== undefined && !this.deps.memory.fact(invite.inviteId, id)) {
        throw new HttpError(404, 'not_found');
      }
      if (id !== undefined && method === 'GET') {
        return respond(res, 200, this.deps.memory.fact(invite.inviteId, id));
      }
      if (id !== undefined && method === 'DELETE') {
        await discard(req);
        this.reauthenticate(invite);
        this.deps.memory.delete(invite.inviteId, id);
        return respond(res, 204, undefined);
      }
      if ((id === undefined && method === 'POST') || (id !== undefined && method === 'PATCH')) {
        const body = z
          .object({ text: z.string() })
          .strict()
          .safeParse(await readJson(req, false));
        if (!body.success) throw new HttpError(400, 'invalid_request');
        this.reauthenticate(invite);
        const saved =
          id === undefined
            ? this.deps.memory.add(invite.inviteId, body.data.text)
            : this.deps.memory.edit(invite.inviteId, id, body.data.text);
        if (!saved) throw new HttpError(404, 'not_found');
        return respond(res, id === undefined ? 201 : 200, saved);
      }
      throw new HttpError(405, 'method_not_allowed');
    }
    if (path === '/v1/conversations') {
      if (method === 'POST') return this.createConversation(req, res, invite);
      if (method === 'GET') {
        return respond(res, 200, { conversations: this.deps.conversations.list(invite.inviteId) });
      }
      throw new HttpError(405, 'method_not_allowed', { allow: 'GET, POST' });
    }
    const messages = /^\/v1\/conversations\/([^/]+)\/messages$/u.exec(path);
    if (messages) {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', { allow: 'POST' });
      return this.postMessage(req, res, invite, decodeURIComponent(messages[1] ?? ''));
    }
    const answers = /^\/v1\/conversations\/([^/]+)\/answers$/u.exec(path);
    if (answers && this.deps.onAnswer) {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', { allow: 'POST' });
      return this.postAnswer(req, res, invite, decodeURIComponent(answers[1] ?? ''));
    }
    const tasks = /^\/v1\/conversations\/([^/]+)\/tasks$/u.exec(path);
    if (tasks) {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', { allow: 'GET' });
      return this.listTasks(res, url, invite, decodeURIComponent(tasks[1] ?? ''));
    }
    const control = /^\/v1\/tasks\/([^/]+)\/(cancel|pause|resume)$/u.exec(path);
    if (control) {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', { allow: 'POST' });
      const action = control[2] as ControlAction;
      return this.control(req, res, invite, decodeURIComponent(control[1] ?? ''), action);
    }
    const taskMessages = /^\/v1\/tasks\/([^/]+)\/messages(?:\/([^/]+))?$/u.exec(path);
    if (taskMessages) {
      const taskId = decodeURIComponent(taskMessages[1] ?? '');
      if (taskMessages[2] === undefined) {
        if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', { allow: 'POST' });
        return this.sendTaskMessage(req, res, invite, taskId);
      }
      if (method !== 'DELETE') throw new HttpError(405, 'method_not_allowed', { allow: 'DELETE' });
      return this.withdrawTaskMessage(
        req,
        res,
        invite,
        taskId,
        decodeURIComponent(taskMessages[2]),
      );
    }
    const computer =
      /^\/v1\/tasks\/([^/]+)\/computer(?:\/(stream|takeover|handback|input))?$/u.exec(path);
    if (computer && this.deps.computer) {
      return this.computerRoute(
        req,
        res,
        invite,
        decodeURIComponent(computer[1] ?? ''),
        computer[2],
      );
    }
    const artifacts = /^\/v1\/tasks\/([^/]+)\/artifacts(?:\/([^/]+))?$/u.exec(path);
    if (artifacts) {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', { allow: 'GET' });
      const taskId = decodeURIComponent(artifacts[1] ?? '');
      if (artifacts[2] === undefined) return this.listArtifacts(res, invite, taskId);
      return this.readArtifact(res, invite, taskId, decodeURIComponent(artifacts[2]));
    }
    const sources = /^\/v1\/tasks\/([^/]+)\/sources(?:\/(\d{1,3})\/(preview|image))?$/u.exec(path);
    if (sources) {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', { allow: 'GET' });
      const taskId = decodeURIComponent(sources[1] ?? '');
      if (sources[2] === undefined) return this.listSources(res, invite, taskId);
      return this.sourcePreview(res, invite, taskId, Number(sources[2]), sources[3] === 'image');
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
    if (this.deps.duties && path.startsWith('/v1/projects')) {
      if (await this.deps.duties.handle(req, res, url, invite)) return;
    }
    if (this.deps.inbox && path.startsWith('/v1/inbox/')) {
      if (await this.deps.inbox.handle(req, res, url, invite)) return;
    }
    if (path === '/v1/events') {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', { allow: 'GET' });
      return this.stream(req, res, url, invite);
    }
    throw new HttpError(404, 'not_found');
  }

  private async createConversation(
    req: IncomingMessage,
    res: ServerResponse,
    invite: InviteInfo,
  ): Promise<void> {
    const body = createConversation.safeParse(await readJson(req, true));
    if (!body.success) throw new HttpError(400, 'invalid_request');
    this.reauthenticate(invite);
    const conversation = this.deps.conversations.create(invite.inviteId, body.data.title);
    respond(res, 201, { conversationId: conversation.conversationId });
  }

  private async postMessage(
    req: IncomingMessage,
    res: ServerResponse,
    invite: InviteInfo,
    conversationId: string,
  ): Promise<void> {
    // Before the body: a client over its rate does not get to send one.
    take(this.deps.messageLimiter, invite);
    const body = postMessage.safeParse(await readJson(req, false));
    if (!body.success || Buffer.byteLength(body.data.text) > MAX_MESSAGE_BYTES) {
      throw new HttpError(400, 'invalid_request');
    }
    this.reauthenticate(invite);
    this.ownSession(invite, conversationId);
    const result = this.deps.conversations.post(
      conversationId,
      body.data.text,
      body.data.clientMessageId,
    );
    if (!result.found) throw new HttpError(404, 'not_found');
    respond(res, 202, { messageId: result.messageId });
    // A retry with the same client id asks again: the first delivery may have failed.
    this.deps.onMessage({
      conversationId,
      messageId: result.messageId,
      text: result.text,
      sessionId: result.sessionId,
    });
  }

  private async postAnswer(
    req: IncomingMessage,
    res: ServerResponse,
    invite: InviteInfo,
    conversationId: string,
  ): Promise<void> {
    take(this.deps.messageLimiter, invite);
    const body = postAnswer.safeParse(await readJson(req, false));
    if (!body.success) throw new HttpError(400, 'invalid_request');
    // Nothing is awaited between this check and the hand-over, so a revoke cannot land in between.
    this.reauthenticate(invite);
    const sessionId = this.ownSession(invite, conversationId);
    const outcome = await (this.deps.onAnswer as NonNullable<PublicApiDeps['onAnswer']>)({
      conversationId,
      questionId: body.data.questionId,
      optionId: body.data.optionId,
      ...(body.data.text === undefined ? {} : { text: body.data.text }),
      sessionId,
      caller: invite.inviteId,
    });
    if (!outcome.accepted) throw new HttpError(ANSWER_STATUS[outcome.reason], outcome.reason);
    respond(res, 200, { accepted: true, duplicate: outcome.duplicate });
  }

  private listTasks(
    res: ServerResponse,
    url: URL,
    invite: InviteInfo,
    conversationId: string,
  ): void {
    const sessionId = this.ownSession(invite, conversationId);
    const after = parseCount(url.searchParams.get('after'), 0);
    const limit = Math.min(
      parseCount(url.searchParams.get('limit'), TASK_PAGE_DEFAULT),
      TASK_PAGE_MAX,
    );
    const page = this.deps.tasks.tasksOfRoot(sessionId, after, limit);
    const tasks = page.flatMap(({ taskId }) => {
      const record = reduce(this.deps.tasks.readTask(taskId)).get(taskId);
      return record ? [toPublicView(toView(record))] : [];
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

  /** The artifact references of a task's manifest; 404 for a task of a conversation the invite does not own. */
  private artifactRefs(invite: InviteInfo, taskId: string): string[] {
    this.ownTaskSession(invite, taskId);
    const record = reduce(this.deps.tasks.readTask(taskId)).get(taskId);
    return record?.manifest?.artifacts ?? [];
  }

  private listArtifacts(res: ServerResponse, invite: InviteInfo, taskId: string): void {
    const refs = this.artifactRefs(invite, taskId);
    respond(res, 200, {
      artifacts: refs.slice(0, MAX_LISTED_ARTIFACTS).map((ref, index) => listArtifact(ref, index)),
      total: refs.length,
    });
  }

  /** The pages the task opened, as the log has them; nothing is fetched to answer. */
  private listSources(res: ServerResponse, invite: InviteInfo, taskId: string): void {
    this.ownTaskSession(invite, taskId);
    const pages = this.deps.opened.list(taskId);
    respond(res, 200, {
      sources: pages.slice(0, MAX_LISTED_SOURCES).map((page) => ({
        index: page.index,
        url: page.url,
        site: siteOf(page.url),
        label: page.label,
      })),
      total: pages.length,
    });
  }

  /**
   * The title, or the image, of one page the task opened. The server fetches it (the browser never
   * contacts the site) through the checked fetcher, and only a page in the task's log is asked for:
   * the path holds an index into that log, never a URL. Ownership is checked again after the fetch.
   */
  private async sourcePreview(
    res: ServerResponse,
    invite: InviteInfo,
    taskId: string,
    index: number,
    wantImage: boolean,
  ): Promise<void> {
    this.ownTaskSession(invite, taskId);
    const page = this.deps.opened.list(taskId)[index];
    if (page === undefined) throw new HttpError(404, 'not_found');
    take(this.deps.previewLimiter, invite);
    let preview: Awaited<ReturnType<PreviewService['get']>>;
    try {
      preview = await this.deps.previews.get(page.url);
    } catch (error) {
      if (error instanceof PreviewBusy) {
        throw new HttpError(429, 'quota_exceeded', { 'retry-after': '2' });
      }
      throw error;
    }
    this.reauthenticate(invite);
    this.ownTaskSession(invite, taskId);
    if (!wantImage) {
      return respond(
        res,
        200,
        {
          site: preview.site,
          ...(preview.title === undefined ? {} : { title: preview.title }),
          image: preview.image !== undefined,
        },
        { 'cache-control': 'private, no-store' },
      );
    }
    if (preview.image === undefined) throw new HttpError(404, 'not_found');
    res.writeHead(200, {
      'content-type': preview.image.type,
      'content-length': String(preview.image.bytes.length),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': 'private, no-store',
    });
    res.end(preview.image.bytes);
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
    const refs = this.artifactRefs(invite, taskId);
    const ref = /^\d{1,6}$/u.test(rawIndex) ? refs[Number(rawIndex)] : undefined;
    if (ref === undefined) throw new HttpError(404, 'not_found');
    const link = linkOf(ref);
    if (link !== undefined) return respond(res, 200, { url: link });
    take(this.deps.artifactLimiter, invite);
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
    // A picture is sent as one only when its name and its own bytes agree; the rest stay text.
    const picture = imageTypeOf(name, result.bytes);
    res.writeHead(200, {
      'content-type':
        picture ??
        (name.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8'),
      'content-length': String(result.bytes.length),
      'content-disposition': `attachment; filename="${name}"`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': 'private, no-store',
    });
    res.end(result.bytes);
  }

  /**
   * Acts on a task of a conversation the invite owns. The invite and the
   * ownership are checked here and again inside the orchestrator's write chain,
   * so a revoke that lands while the request waits stops it; the credentials the
   * conductor holds are not involved.
   */
  private async control(
    req: IncomingMessage,
    res: ServerResponse,
    invite: InviteInfo,
    taskId: string,
    action: ControlAction,
  ): Promise<void> {
    const { orchestrator, conversations } = this.deps;
    take(this.deps.controlLimiter, invite);
    await discard(req);
    this.reauthenticate(invite);
    const sessionId = this.ownTaskSession(invite, taskId);
    if (
      action === 'resume' &&
      (this.humanComputers.has(taskId) || this.busyComputers.has(taskId))
    ) {
      throw new HttpError(409, 'computer_in_control');
    }
    const token = bearerToken(req);
    const access: OperatorAccess = {
      sessionId,
      authorize: () => {
        const current = token === undefined ? undefined : this.deps.invites.resolve(token);
        if (!current || current.inviteId !== invite.inviteId) {
          throw new OrchestratorError('unauthorized', 'The invite is no longer valid');
        }
        if (
          action === 'resume' &&
          (this.humanComputers.has(taskId) || this.busyComputers.has(taskId))
        ) {
          throw new OrchestratorError('invalid_state', 'Return computer control first');
        }
        const conversationId = conversations.conversationOf(sessionId);
        if (conversationId === undefined || !conversations.owns(invite.inviteId, conversationId)) {
          throw new OrchestratorError('not_found', 'The conversation no longer exists');
        }
      },
    };
    try {
      if (action === 'cancel') this.releaseComputer(taskId);
      const view =
        action === 'cancel'
          ? await orchestrator.cancelAs(access, taskId)
          : action === 'pause'
            ? await orchestrator.pauseAs(access, taskId)
            : await orchestrator.resumeAs(access, taskId);
      respond(res, 200, { task: toPublicView(view) });
    } catch (error) {
      throw error instanceof OrchestratorError ? controlError(error) : error;
    }
  }

  /** The owner as the orchestrator checks them, in its write chain, so a revoke in between stops it. */
  private operatorOf(req: IncomingMessage, invite: InviteInfo, taskId: string): OperatorAccess {
    const { conversations } = this.deps;
    const sessionId = this.ownTaskSession(invite, taskId);
    const token = bearerToken(req);
    return {
      sessionId,
      authorize: () => {
        const current = token === undefined ? undefined : this.deps.invites.resolve(token);
        if (!current || current.inviteId !== invite.inviteId) {
          throw new OrchestratorError('unauthorized', 'The invite is no longer valid');
        }
        const conversationId = conversations.conversationOf(sessionId);
        if (conversationId === undefined || !conversations.owns(invite.inviteId, conversationId)) {
          throw new OrchestratorError('not_found', 'The conversation no longer exists');
        }
      },
    };
  }

  /**
   * The owner's own words to the agent working on a task. The text is theirs, not model output,
   * so it goes in as it is. `messageId` makes a resend safe; without one the request is its own.
   */
  private async sendTaskMessage(
    req: IncomingMessage,
    res: ServerResponse,
    invite: InviteInfo,
    taskId: string,
  ): Promise<void> {
    take(this.deps.controlLimiter, invite);
    const body = taskMessage.safeParse(await readJson(req, false));
    if (!body.success) throw new HttpError(400, 'invalid_request');
    this.reauthenticate(invite);
    const access = this.operatorOf(req, invite, taskId);
    try {
      const sent = await this.deps.orchestrator.steerAs(access, taskId, {
        steerId: body.data.messageId ?? randomUUID(),
        text: body.data.text,
      });
      respond(res, 200, { message: { messageId: sent.steerId, state: sent.state } });
    } catch (error) {
      throw error instanceof OrchestratorError ? controlError(error, 'steer_unsupported') : error;
    }
  }

  private async withdrawTaskMessage(
    req: IncomingMessage,
    res: ServerResponse,
    invite: InviteInfo,
    taskId: string,
    messageId: string,
  ): Promise<void> {
    take(this.deps.controlLimiter, invite);
    await discard(req);
    this.reauthenticate(invite);
    const access = this.operatorOf(req, invite, taskId);
    try {
      const result = await this.deps.orchestrator.withdrawSteerAs(access, taskId, messageId);
      respond(res, 200, { message: { messageId: result.steerId, state: result.state } });
    } catch (error) {
      throw error instanceof OrchestratorError ? controlError(error, 'steer_unsupported') : error;
    }
  }

  private computerTask(taskId: string) {
    const record = reduce(this.deps.tasks.readTask(taskId)).get(taskId);
    return record ? toView(record) : undefined;
  }

  private logComputer(taskId: string, text: string): void {
    const session = this.deps.orchestrator.rootSessionOfTask(taskId);
    const conversationId =
      session === undefined ? undefined : this.deps.conversations.conversationOf(session);
    if (conversationId)
      this.deps.publisher?.publish({
        kind: 'notice',
        eventId: `computer_${randomUUID()}`,
        conversationId,
        text: `${text} (${taskId}).`,
      });
  }

  private releaseComputer(taskId: string): void {
    const lease = this.humanComputers.get(taskId);
    if (!lease) return;
    lease.abort.abort();
    this.humanComputers.delete(taskId);
    this.logComputer(taskId, 'Computer control ended; no automatic resume');
    this.unwatch();
  }

  private async computerRoute(
    req: IncomingMessage,
    res: ServerResponse,
    invite: InviteInfo,
    taskId: string,
    action?: string,
  ): Promise<void> {
    const sessionId = this.ownTaskSession(invite, taskId);
    const source = this.deps.computer!;
    const expected = action === undefined || action === 'stream' ? 'GET' : 'POST';
    if (req.method !== expected)
      throw new HttpError(405, 'method_not_allowed', { allow: expected });
    if (action === 'stream') {
      if (!(await source.available(taskId))) throw new HttpError(404, 'not_found');
      this.reauthenticate(invite);
      this.ownTaskSession(invite, taskId);
      return this.computerStream(res, invite, taskId);
    }
    if (!action) {
      if (!(await source.available(taskId))) throw new HttpError(404, 'not_found');
      this.reauthenticate(invite);
      this.ownTaskSession(invite, taskId);
      return respond(res, 200, { controller: this.humanComputers.has(taskId) ? 'human' : 'agent' });
    }
    take(this.deps.controlLimiter, invite);
    const body = await readJson(req, true);
    const authorize = () => {
      this.reauthenticate(invite);
      this.ownTaskSession(invite, taskId);
    };
    authorize();
    if (this.busyComputers.has(taskId)) throw new HttpError(409, 'computer_busy');
    this.busyComputers.add(taskId);
    try {
      const lease = this.humanComputers.get(taskId);
      if (action === 'input') {
        const input = computerInput.safeParse(body);
        if (!input.success) throw new HttpError(400, 'invalid_request');
        if (
          !lease ||
          lease.inviteId !== invite.inviteId ||
          lease.abort.signal.aborted ||
          this.computerTask(taskId)?.state !== 'paused'
        )
          throw new HttpError(409, 'computer_not_in_control');
        await source.input(taskId, input.data, lease.abort.signal);
        authorize();
        return respond(res, 200, { accepted: true });
      }
      if (!(await source.available(taskId))) throw new HttpError(404, 'not_found');
      authorize();
      const access: OperatorAccess = { sessionId, authorize };
      if (action === 'takeover') {
        if (lease) return respond(res, 200, { controller: 'human' });
        const task = this.computerTask(taskId);
        if (task?.state !== 'running') throw new HttpError(409, 'invalid_state');
        const paused = await this.deps.orchestrator.pauseAs(access, taskId);
        authorize();
        if (paused.state !== 'paused' || paused.cancelRequested || paused.stopPending)
          throw new HttpError(409, 'invalid_state');
        this.humanComputers.set(taskId, {
          inviteId: invite.inviteId,
          abort: new AbortController(),
        });
        this.watch();
        this.logComputer(taskId, 'Computer control taken; task paused');
      } else {
        if (!lease) throw new HttpError(409, 'computer_not_in_control');
        // Disable all input before resuming. On failure the task stays paused and
        // the lease remains, so the owner can retry Hand back rather than lose it.
        await this.deps.orchestrator.resumeAs(access, taskId);
        lease.abort.abort();
        this.humanComputers.delete(taskId);
        this.unwatch();
        this.logComputer(taskId, 'Computer control returned; task resumed');
        authorize();
      }
      respond(res, 200, { controller: action === 'takeover' ? 'human' : 'agent' });
    } catch (error) {
      authorize();
      throw error instanceof OrchestratorError ? controlError(error) : error;
    } finally {
      this.busyComputers.delete(taskId);
    }
  }

  private async computerStream(
    res: ServerResponse,
    invite: InviteInfo,
    taskId: string,
  ): Promise<void> {
    const { limits, computer } = this.deps;
    if (
      this.streams >= limits.streamsTotal ||
      !this.streamsByInvite.tryAcquire(invite.inviteId, limits.streamsPerInvite)
    )
      throw new HttpError(429, 'quota_exceeded', { 'retry-after': '1' });
    this.streams++;
    this.open.add(res);
    const abort = new AbortController();
    let ends = this.streamEnds.get(invite.inviteId);
    if (!ends) {
      ends = new Set();
      this.streamEnds.set(invite.inviteId, ends);
    }
    const ownEnds = ends;
    let heartbeat: NodeJS.Timeout | undefined;
    let unsubscribe = () => {};
    const end = () => {
      if (abort.signal.aborted) return;
      abort.abort();
      clearInterval(heartbeat);
      unsubscribe();
      ownEnds.delete(end);
      if (!ownEnds.size) this.streamEnds.delete(invite.inviteId);
      this.open.delete(res);
      this.streams--;
      this.streamsByInvite.release(invite.inviteId);
      this.unwatch();
      // A stalled reader must lose its socket, not retain queued desktop data
      // after its stream slot or invite has been released.
      if (res.writableNeedDrain) res.destroy();
      else res.end();
    };
    const valid = () => {
      try {
        this.reauthenticate(invite);
        this.ownTaskSession(invite, taskId);
        const task = this.computerTask(taskId);
        if (!task || !['running', 'paused'].includes(task.state) || task.cancelRequested) {
          end();
          return false;
        }
        return !abort.signal.aborted;
      } catch {
        end();
        return false;
      }
    };
    ownEnds.add(end);
    res.once('close', end);
    this.watch();
    unsubscribe = this.deps.hub.subscribe(() => {
      valid();
    });
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'private, no-store',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();
    heartbeat = setInterval(() => {
      if (valid() && !res.writableNeedDrain) res.write(': keep-alive\n\n');
    }, limits.heartbeatMs);
    heartbeat.unref();
    try {
      if (!valid()) return;
      for await (const frame of computer!.watch(taskId, abort.signal)) {
        if (!valid()) break;
        const data = JSON.stringify({
          ...frame,
          controller: this.humanComputers.has(taskId) ? 'human' : 'agent',
        });
        if (Buffer.byteLength(data) > 2 * 1024 * 1024) break;
        if (!res.write(`id: 1\nevent: computer\ndata: ${data}\n\n`)) {
          await once(res, 'drain', {
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(limits.drainTimeoutMs)]),
          });
        }
      }
    } finally {
      end();
    }
  }

  /**
   * The event stream of what the invite owns. It belongs to its invite: a
   * revoke ends it (at once through this server's store, within
   * `revokeCheckMs` from another process), and every frame and heartbeat is
   * preceded by a check, so nothing is sent after the revoke is seen.
   */
  private async stream(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    invite: InviteInfo,
  ): Promise<void> {
    const { db, hub, limits, invites } = this.deps;
    const conversationId = url.searchParams.get('conversation') ?? undefined;
    if (conversationId !== undefined) this.ownSession(invite, conversationId);
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
    let ends = this.streamEnds.get(invite.inviteId);
    if (!ends) {
      ends = new Set();
      this.streamEnds.set(invite.inviteId, ends);
    }
    const ownEnds = ends;

    let closed = false;
    let dirty = true;
    let running = false;
    let draining = false;
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
      ownEnds.delete(end);
      if (ownEnds.size === 0 && this.streamEnds.get(invite.inviteId) === ownEnds) {
        this.streamEnds.delete(invite.inviteId);
      }
      this.unwatch();
      return true;
    };
    const finish = (abandon = false) => {
      if (!release()) return;
      if (abandon) res.destroy();
      else if (!res.writableEnded) res.end();
    };
    function end() {
      finish();
    }
    ownEnds.add(end);
    this.watch();
    /** False once the invite is revoked; the stream is then ended. */
    const stillValid = (): boolean => {
      if (invites.active(invite.inviteId)) return true;
      finish();
      return false;
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
    // Every write, heartbeats included, waits for the client to take what is
    // buffered; one that is not taken within the drain timeout ends the stream.
    const write = async (chunk: string): Promise<boolean> => {
      if (res.write(chunk)) return true;
      if (closed) return false;
      draining = true;
      try {
        return await drained();
      } finally {
        draining = false;
      }
    };
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
            const page = readOwnFeed(db, invite.inviteId, position, FEED_PAGE, conversationId);
            if (page.scannedTo === position) break;
            for (const entry of page.entries) {
              if (closed || !stillValid()) return;
              if (!(await write(frame(entry)))) return finish(true);
              position = entry.id;
            }
            position = page.scannedTo;
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
        if (closed || draining) return;
        try {
          if (!stillValid()) return;
        } catch {
          return finish(true);
        }
        void write(': keep-alive\n\n').then((ok) => {
          if (!ok) finish(true);
        });
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

/** Takes one token from the invite's bucket or answers 429. */
export function take(limiter: RateLimiter, invite: InviteInfo): void {
  const allowed = limiter.take(invite.inviteId);
  if (!allowed.ok) {
    throw new HttpError(429, 'quota_exceeded', {
      'retry-after': String(Math.max(1, Math.ceil(allowed.retryAfterMs / 1000))),
    });
  }
}

function bearerToken(req: IncomingMessage): string | undefined {
  return /^Bearer\s+(\S+)$/iu.exec(req.headers.authorization ?? '')?.[1];
}

function controlError(error: OrchestratorError, unsupported = 'pause_unsupported'): HttpError {
  switch (error.code) {
    case 'not_found':
      return new HttpError(404, 'not_found');
    case 'unauthorized':
      return new HttpError(401, 'unauthorized', { 'www-authenticate': 'Bearer' });
    case 'quota_exceeded':
      return new HttpError(429, 'quota_exceeded', { 'retry-after': '1' });
    case 'unsupported':
      return new HttpError(409, unsupported);
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

export function parseCount(value: string | null | undefined, fallback: number): number {
  if (value === null || value === undefined || value === '') return fallback;
  if (!/^\d{1,15}$/u.test(value)) throw new HttpError(400, 'invalid_request');
  return Number(value);
}

export function respond(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res
    .writeHead(status, { 'content-type': 'application/json', ...headers })
    .end(JSON.stringify(body));
}

export async function readJson(req: IncomingMessage, allowEmpty: boolean): Promise<unknown> {
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
