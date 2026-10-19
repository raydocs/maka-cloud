import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { HttpError, parseCount, readJson, respond } from './http.js';
import type { InviteInfo } from './invites.js';
import type { RateLimiter } from './rate-limit.js';

/**
 * What the inbox routes need from the supervisor. Declared here, so the server
 * imports nothing from the supervisor package; the composition code adapts the
 * supervisor to this shape. Items and settings are the supervisor's own JSON.
 */
export interface InboxService {
  list(query: { state: 'open' | 'closed' | 'all'; after: number; limit: number }): Promise<{
    items: unknown[];
    next: number | null;
  }>;
  answer(request: {
    itemId: string;
    answerId: string;
    optionId: string;
    text?: string;
    preconditionHash: string;
  }): Promise<InboxAnswerResult>;
  /** `ok: false` for a kind the inbox does not have. */
  setMute(kind: string, muted: boolean): { ok: true; settings: unknown } | { ok: false };
  settings(): unknown;
  /** `ok: false` for a patch the settings reject. */
  updateSettings(patch: unknown): { ok: true; settings: unknown } | { ok: false };
  digest(): Promise<unknown>;
  stop(): Promise<void>;
}

export type InboxAnswerResult =
  | { ok: true; duplicate: boolean; item: { state: string } }
  | { ok: false; reason: string; item?: unknown };

/** Same answer, a different status: what the human can do about each refusal. */
const ANSWER_FAILURE: Record<string, number> = {
  not_found: 404,
  invalid_request: 400,
  invalid_option: 400,
  text_not_allowed: 400,
  text_too_long: 400,
  stale: 409,
  closed: 409,
  already_answered: 409,
  question_open: 409,
  stopped: 503,
};

const STATES = ['open', 'closed', 'all'] as const;
const KIND = /^[a-z][a-z_]{0,31}$/u;
const answerBody = z
  .object({
    answerId: z.string().min(1).max(64),
    optionId: z.string().min(1).max(128),
    text: z.string().max(4000).optional(),
    preconditionHash: z.string().min(1).max(128),
  })
  .strict();

/** The `/v1/inbox/…` routes. They sit behind the same invite as every other route. */
export class InboxRoutes {
  constructor(
    private readonly service: InboxService,
    private readonly limiter: RateLimiter,
  ) {}

  /** Answers a request under `/v1/inbox`, or returns false for a path that is not one of its routes. */
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    invite: InviteInfo,
  ): Promise<boolean> {
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (path === '/v1/inbox/items') {
      allow(method, 'GET');
      await this.list(res, url);
      return true;
    }
    const answer = /^\/v1\/inbox\/items\/([^/]+)\/answer$/u.exec(path);
    if (answer) {
      allow(method, 'POST');
      await this.answer(req, res, invite, decodeURIComponent(answer[1] ?? ''));
      return true;
    }
    const mute = /^\/v1\/inbox\/mutes\/([^/]+)$/u.exec(path);
    if (mute) {
      if (method !== 'PUT' && method !== 'DELETE') {
        throw new HttpError(405, 'method_not_allowed', { allow: 'PUT, DELETE' });
      }
      const kind = decodeURIComponent(mute[1] ?? '');
      if (!KIND.test(kind)) throw new HttpError(404, 'not_found');
      this.limit(invite);
      await discard(req);
      const result = this.service.setMute(kind, method === 'PUT');
      if (!result.ok) throw new HttpError(404, 'not_found');
      respond(res, 200, { settings: result.settings });
      return true;
    }
    if (path === '/v1/inbox/settings') {
      if (method === 'GET') {
        respond(res, 200, { settings: this.service.settings() });
        return true;
      }
      if (method !== 'PUT') throw new HttpError(405, 'method_not_allowed', { allow: 'GET, PUT' });
      const body = await readJson(req, false);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new HttpError(400, 'invalid_request');
      }
      this.limit(invite);
      const result = this.service.updateSettings(body);
      if (!result.ok) throw new HttpError(400, 'invalid_request');
      respond(res, 200, { settings: result.settings });
      return true;
    }
    if (path === '/v1/inbox/digest') {
      allow(method, 'POST');
      this.limit(invite);
      await discard(req);
      respond(res, 200, { digest: await this.service.digest() });
      return true;
    }
    return false;
  }

  private async list(res: ServerResponse, url: URL): Promise<void> {
    const state = url.searchParams.get('state') ?? 'open';
    if (!(STATES as readonly string[]).includes(state)) throw new HttpError(400, 'invalid_request');
    const after = parseCount(url.searchParams.get('after'), 0);
    const limit = Math.min(Math.max(parseCount(url.searchParams.get('limit'), 50), 1), 200);
    const page = await this.service.list({
      state: state as (typeof STATES)[number],
      after,
      limit,
    });
    respond(res, 200, { items: page.items, ...(page.next === null ? {} : { next: page.next }) });
  }

  private async answer(
    req: IncomingMessage,
    res: ServerResponse,
    invite: InviteInfo,
    itemId: string,
  ): Promise<void> {
    const body = answerBody.safeParse(await readJson(req, false));
    if (!body.success) throw new HttpError(400, 'invalid_request');
    this.limit(invite);
    const result = await this.service.answer({
      itemId,
      answerId: body.data.answerId,
      optionId: body.data.optionId,
      ...(body.data.text === undefined ? {} : { text: body.data.text }),
      preconditionHash: body.data.preconditionHash,
    });
    if (!result.ok) {
      const status = ANSWER_FAILURE[result.reason];
      if (status === undefined) throw new Error(`Unknown answer failure ${result.reason}`);
      respond(res, status, {
        error: result.reason,
        ...(result.item === undefined ? {} : { item: result.item }),
      });
      return;
    }
    // 202 while the delivery to the conversation is still being retried.
    respond(res, result.item.state === 'answering' ? 202 : 200, {
      duplicate: result.duplicate,
      item: result.item,
    });
  }

  private limit(invite: InviteInfo): void {
    const allowed = this.limiter.take(invite.inviteId);
    if (!allowed.ok) {
      throw new HttpError(429, 'quota_exceeded', {
        'retry-after': String(Math.max(1, Math.ceil(allowed.retryAfterMs / 1000))),
      });
    }
  }
}

function allow(method: string, expected: string): void {
  if (method !== expected) throw new HttpError(405, 'method_not_allowed', { allow: expected });
}

/** Reads a body nobody uses, so a client that sends one is not left hanging. */
async function discard(req: IncomingMessage): Promise<void> {
  await readJson(req, true);
}
