import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { HttpError, readJson, respond, take } from './http.js';
import type { InviteInfo } from './invites.js';
import type { RateLimiter } from './rate-limit.js';

/**
 * What the duty routes need from the duties engine. Declared here, so the server imports nothing
 * from the duties package; the composition code adapts the engine to this shape. Projects, duties
 * and proposals are the engine's own JSON.
 */
export interface DutyService {
  /**
   * Handles one GitHub webhook request. It verifies the signature itself and says what to
   * answer; a request it does not accept is rejected, never partly handled.
   */
  webhook(
    headers: Readonly<Record<string, string | string[] | undefined>>,
    body: Uint8Array,
  ): { status: number; body: Record<string, unknown> };
  /** The owner's projects only. */
  listProjects(owner: string): unknown[];
  project(owner: string, projectId: string): unknown | undefined;
  addProject(
    owner: string,
    input: unknown,
  ): { ok: true; project: unknown } | { ok: false; reason: 'invalid' | 'not_allowed' | 'exists' };
  removeProject(owner: string, projectId: string): boolean;
  setDutyState(
    owner: string,
    dutyId: string,
    state: 'active' | 'off',
  ): 'ok' | 'not_found' | 'not_approved' | 'duty_limit';
  /** Inspects the project's repository and opens a proposal for the owner to decide (a T20 item). */
  propose(
    owner: string,
    projectId: string,
  ): Promise<
    | { ok: true; proposal: unknown }
    | { ok: false; reason: 'not_found' | 'already_set_up' | 'inspect_failed' | 'unavailable' }
  >;
}

/** Who is still allowed to act: checked again once a body has been read. */
export interface DutyOwners {
  active(inviteId: string): boolean;
}

/** The webhook body cap: GitHub's own limit is larger, but nothing we handle comes near this. */
export const WEBHOOK_MAX_BYTES = 1_048_576;

const dutyPatch = z.object({ state: z.enum(['active', 'off']) }).strict();

const PROPOSE_FAILURE: Record<string, number> = {
  not_found: 404,
  already_set_up: 409,
  inspect_failed: 502,
  unavailable: 503,
};

const ADD_FAILURE: Record<string, number> = { invalid: 400, not_allowed: 403, exists: 409 };

/** A project as clients see it: no owner, no installation, no internals. */
function publicProject(project: unknown): unknown {
  const {
    owner: _owner,
    installationId: _installation,
    ...rest
  } = project as Record<string, unknown>;
  return rest;
}

/**
 * The `/github/webhook` route (signed by GitHub, no invite) and the `/v1/projects` routes
 * (behind an invite, which sees and changes its own projects only; anything else answers 404).
 */
export class DutyRoutes {
  constructor(
    private readonly service: DutyService,
    private readonly limiter: RateLimiter,
    private readonly webhookLimiter: RateLimiter,
    private readonly owners: DutyOwners,
  ) {}

  /** Answers a webhook request. Never throws for a bad request: it answers with the rejection. */
  async webhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      respond(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
      return;
    }
    // One bucket for every sender: the signature is checked after the body is read, so a flood
    // of unsigned requests must not be able to starve the real ones for long, and cannot grow memory.
    const allowed = this.webhookLimiter.take('webhook');
    if (!allowed.ok) {
      respond(
        res,
        429,
        { error: 'quota_exceeded' },
        {
          'retry-after': String(Math.max(1, Math.ceil(allowed.retryAfterMs / 1000))),
        },
      );
      return;
    }
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BYTES) {
      respond(res, 413, { error: 'too_large' });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > WEBHOOK_MAX_BYTES) {
        respond(res, 413, { error: 'too_large' });
        return;
      }
      chunks.push(buffer);
    }
    const result = this.service.webhook(req.headers, Buffer.concat(chunks));
    respond(res, result.status, result.body);
  }

  /** Answers a request under `/v1/projects`, or returns false for a path that is not one of its routes. */
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    invite: InviteInfo,
  ): Promise<boolean> {
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (path === '/v1/projects') {
      if (method === 'GET') {
        respond(res, 200, {
          projects: this.service.listProjects(invite.inviteId).map(publicProject),
        });
        return true;
      }
      allow(method, 'POST');
      take(this.limiter, invite);
      const body = await readJson(req, false);
      this.reauthenticate(invite);
      const result = this.service.addProject(invite.inviteId, body);
      if (!result.ok) {
        respond(res, ADD_FAILURE[result.reason] ?? 400, { error: result.reason });
        return true;
      }
      respond(res, 201, { project: publicProject(result.project) });
      return true;
    }
    const one = /^\/v1\/projects\/([^/]+)$/u.exec(path);
    if (one) {
      const projectId = decodeURIComponent(one[1] ?? '');
      if (method === 'GET') {
        const project = this.service.project(invite.inviteId, projectId);
        if (project === undefined) throw new HttpError(404, 'not_found');
        respond(res, 200, { project: publicProject(project) });
        return true;
      }
      allow(method, 'DELETE');
      take(this.limiter, invite);
      this.reauthenticate(invite);
      if (!this.service.removeProject(invite.inviteId, projectId)) {
        throw new HttpError(404, 'not_found');
      }
      respond(res, 200, { removed: true });
      return true;
    }
    const proposal = /^\/v1\/projects\/([^/]+)\/proposal$/u.exec(path);
    if (proposal) {
      allow(method, 'POST');
      take(this.limiter, invite);
      this.reauthenticate(invite);
      const result = await this.service.propose(
        invite.inviteId,
        decodeURIComponent(proposal[1] ?? ''),
      );
      if (!result.ok) {
        respond(res, PROPOSE_FAILURE[result.reason] ?? 400, { error: result.reason });
        return true;
      }
      respond(res, 200, { proposal: result.proposal });
      return true;
    }
    const duty = /^\/v1\/projects\/([^/]+)\/duties\/([^/]+)$/u.exec(path);
    if (duty) {
      allow(method, 'PATCH');
      take(this.limiter, invite);
      const body = dutyPatch.safeParse(await readJson(req, false));
      if (!body.success) throw new HttpError(400, 'invalid_request');
      this.reauthenticate(invite);
      const dutyId = decodeURIComponent(duty[2] ?? '');
      // The duty must belong to the project in the path, and the project to the caller.
      const project = this.service.project(invite.inviteId, decodeURIComponent(duty[1] ?? '')) as
        | { duties?: Array<{ dutyId?: string }> }
        | undefined;
      if (!project?.duties?.some((candidate) => candidate.dutyId === dutyId)) {
        throw new HttpError(404, 'not_found');
      }
      const result = this.service.setDutyState(invite.inviteId, dutyId, body.data.state);
      if (result === 'not_found') throw new HttpError(404, 'not_found');
      if (result === 'not_approved' || result === 'duty_limit') throw new HttpError(409, result);
      respond(res, 200, { state: body.data.state });
      return true;
    }
    return false;
  }

  private reauthenticate(invite: InviteInfo): void {
    if (!this.owners.active(invite.inviteId)) {
      throw new HttpError(401, 'unauthorized', { 'www-authenticate': 'Bearer' });
    }
  }
}

function allow(method: string, expected: string): void {
  if (method !== expected) throw new HttpError(405, 'method_not_allowed', { allow: expected });
}
