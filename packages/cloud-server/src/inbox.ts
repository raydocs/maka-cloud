import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { HttpError, parseCount, readJson, respond, take } from './http.js';
import type { InviteInfo } from './invites.js';
import { toPublicDigest, toPublicItem } from './public-view.js';
import type { RateLimiter } from './rate-limit.js';

/**
 * What the inbox routes need from the supervisor. Declared here, so the server
 * imports nothing from the supervisor package; the composition code adapts the
 * supervisor to this shape. Items and settings are the supervisor's own JSON.
 */
export interface InboxService {
  /** Items of the conversations in `conversations` only: the caller's own. */
  list(query: {
    state: 'open' | 'closed' | 'all';
    after: number;
    limit: number;
    conversations: readonly string[];
  }): Promise<{
    items: unknown[];
    next: number | null;
  }>;
  /**
   * An item outside `conversations` is `not_found`. `caller` is the invite that
   * answers; it is stored with the answer and handed back when the answer is
   * delivered, so it can be checked again where the answer takes effect.
   */
  answer(request: {
    itemId: string;
    answerId: string;
    optionId: string;
    text?: string;
    preconditionHash: string;
    caller: string;
    conversations: readonly string[];
  }): Promise<InboxAnswerResult>;
  /**
   * The mutes, the settings and the digest are each owner's own: `owner` is the invite, and one
   * owner's call never changes or shows another's. `ok: false` for a kind the inbox does not have.
   */
  setMute(
    owner: string,
    kind: string,
    muted: boolean,
  ): { ok: true; settings: unknown } | { ok: false };
  settings(owner: string): unknown;
  /** `ok: false` for a patch the settings reject, which includes everything that is the operator's to set. */
  updateSettings(owner: string, patch: unknown): { ok: true; settings: unknown } | { ok: false };
  digest(owner: string): Promise<unknown>;
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
  unavailable: 503,
  stopped: 503,
};

const STATES = ['open', 'closed', 'all'] as const;
const answerBody = z
  .object({
    answerId: z.string().min(1).max(64),
    optionId: z.string().min(1).max(128),
    text: z.string().max(4000).optional(),
    preconditionHash: z.string().min(1).max(128),
  })
  .strict();

/** Who owns what, for the inbox routes. */
export interface InboxOwners {
  /** Whether the invite is still active: checked again after the body is read. */
  active(inviteId: string): boolean;
  /** The ids of the conversations the invite owns. */
  conversationsOf(inviteId: string): string[];
}

/**
 * The `/v1/inbox/…` routes. They sit behind the same invite as every other
 * route, and an invite sees and answers the items of its own conversations
 * only. The mutes, the settings and the digest are kept per owner (the
 * invite): an invite reaches its own and nobody else's, and what the operator
 * owns (stall times, the hourly cap, the digest schedule) it can read and not set.
 */
export class InboxRoutes {
  constructor(
    private readonly service: InboxService,
    private readonly limiter: RateLimiter,
    private readonly owners: InboxOwners,
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
      await this.list(res, url, invite);
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
      take(this.limiter, invite);
      this.checkActive(invite);
      const result = this.service.setMute(
        invite.inviteId,
        decodeURIComponent(mute[1] ?? ''),
        method === 'PUT',
      );
      if (!result.ok) throw new HttpError(404, 'not_found');
      respond(res, 200, { settings: result.settings });
      return true;
    }
    if (path === '/v1/inbox/settings') {
      if (method === 'GET') {
        respond(res, 200, { settings: this.service.settings(invite.inviteId) });
        return true;
      }
      if (method !== 'PUT') throw new HttpError(405, 'method_not_allowed', { allow: 'GET, PUT' });
      take(this.limiter, invite);
      const patch = await readJson(req, false);
      this.checkActive(invite);
      const result = this.service.updateSettings(invite.inviteId, patch);
      if (!result.ok) throw new HttpError(400, 'invalid_request');
      respond(res, 200, { settings: result.settings });
      return true;
    }
    if (path === '/v1/inbox/digest') {
      allow(method, 'POST');
      take(this.limiter, invite);
      this.checkActive(invite);
      respond(res, 200, { digest: toPublicDigest(await this.service.digest(invite.inviteId)) });
      return true;
    }
    return false;
  }

  /** A revoke that landed while the request was read wins. */
  private checkActive(invite: InviteInfo): void {
    if (!this.owners.active(invite.inviteId)) {
      throw new HttpError(401, 'unauthorized', { 'www-authenticate': 'Bearer' });
    }
  }

  private async list(res: ServerResponse, url: URL, invite: InviteInfo): Promise<void> {
    const state = url.searchParams.get('state') ?? 'open';
    if (!(STATES as readonly string[]).includes(state)) throw new HttpError(400, 'invalid_request');
    const after = parseCount(url.searchParams.get('after'), 0);
    const limit = Math.min(Math.max(parseCount(url.searchParams.get('limit'), 50), 1), 200);
    const page = await this.service.list({
      state: state as (typeof STATES)[number],
      after,
      limit,
      conversations: this.owners.conversationsOf(invite.inviteId),
    });
    respond(res, 200, {
      items: page.items.map(toPublicItem),
      ...(page.next === null ? {} : { next: page.next }),
    });
  }

  private async answer(
    req: IncomingMessage,
    res: ServerResponse,
    invite: InviteInfo,
    itemId: string,
  ): Promise<void> {
    // Before the body: a client over its rate does not get to send one.
    take(this.limiter, invite);
    const body = answerBody.safeParse(await readJson(req, false));
    if (!body.success) throw new HttpError(400, 'invalid_request');
    // Checked again now the body is in: a revoke that landed while it arrived wins.
    if (!this.owners.active(invite.inviteId)) {
      throw new HttpError(401, 'unauthorized', { 'www-authenticate': 'Bearer' });
    }
    const result = await this.service.answer({
      itemId,
      answerId: body.data.answerId,
      optionId: body.data.optionId,
      ...(body.data.text === undefined ? {} : { text: body.data.text }),
      preconditionHash: body.data.preconditionHash,
      caller: invite.inviteId,
      conversations: this.owners.conversationsOf(invite.inviteId),
    });
    if (!result.ok) {
      const status = ANSWER_FAILURE[result.reason];
      if (status === undefined) throw new Error(`Unknown answer failure ${result.reason}`);
      respond(res, status, {
        error: result.reason,
        ...(result.item === undefined ? {} : { item: toPublicItem(result.item) }),
      });
      return;
    }
    // 202 while the delivery to the conversation is still being retried.
    respond(res, result.item.state === 'answering' ? 202 : 200, {
      duplicate: result.duplicate,
      item: toPublicItem(result.item),
    });
  }
}

function allow(method: string, expected: string): void {
  if (method !== expected) throw new HttpError(405, 'method_not_allowed', { allow: expected });
}
