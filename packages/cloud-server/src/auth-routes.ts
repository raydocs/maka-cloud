import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { AccountStore, Identity } from './accounts.js';
import type { EmailCodes, NonceStore } from './challenges.js';
import { HttpError, readJson, respond } from './http.js';
import type { IdentityVerifier } from './identity.js';
import type { InviteInfo, InviteStore } from './invites.js';
import { RateLimiter } from './rate-limit.js';

/** How often sign-in routes may be called, per minute. Tests lower or raise them. */
export interface AuthLimits {
  /** Any sign-in route, per caller address. */
  perAddress: number;
  /** Routes that try a secret (a code, an invite token, a provider token), per caller address. */
  guessesPerAddress: number;
  /** Every sign-in route together: the ceiling when many addresses (or one proxy) share the load. */
  total: number;
}

export const DEFAULT_AUTH_LIMITS: AuthLimits = {
  perAddress: 30,
  guessesPerAddress: 10,
  total: 600,
};

const PENDING_TTL_MS = 10 * 60 * 1000;
const PENDING_MAX_TRIES = 5;
const MAX_PENDING = 5_000;

const device = z.string().max(200).optional();
const providerBody = z
  .object({
    provider: z.enum(['apple', 'google']),
    idToken: z.string().min(1).max(8192),
    nonce: z.string().min(1).max(128),
    device,
  })
  .strict();
const emailRequest = z.object({ address: z.string().min(1).max(320) }).strict();
const emailVerify = z
  .object({
    challengeId: z.string().min(1).max(64),
    deviceSecret: z.string().min(1).max(64),
    code: z.string().min(1).max(16),
    device,
  })
  .strict();
const claimBody = z
  .object({
    pendingToken: z.string().min(1).max(128),
    inviteToken: z.string().min(1).max(256),
    device,
  })
  .strict();
const linkBody = z.union([providerBody.omit({ device: true }), emailVerify.omit({ device: true })]);
const signOutBody = z.object({ pushEndpoint: z.string().min(1).max(2048).optional() }).strict();

export interface AuthOptions {
  verifiers: Partial<Record<'apple' | 'google', IdentityVerifier>>;
  /** Absent: there is no email sign-in. */
  emailCodes?: EmailCodes;
  limits?: Partial<AuthLimits>;
}

export interface AuthDeps extends AuthOptions {
  accounts: AccountStore;
  invites: InviteStore;
  nonces: NonceStore;
  /** Throws 401 when the caller's invite or session has gone since the request began. */
  reauthenticate: (invite: InviteInfo) => void;
  /** Removes a Web Push subscription of the invite; false when it has none like it. */
  removePush?: (inviteId: string, endpoint: string) => boolean;
  now?: () => number;
}

interface Pending {
  identity: Identity;
  expiresAt: number;
  tries: number;
}

/**
 * Signing in with Apple, Google or an emailed code, and the account's own devices.
 *
 * A person who proves an identity that has an account gets a session for one device. One that has
 * none gets a short-lived pending token and nothing else: it reads nothing, and it becomes an
 * account only when the person also gives an active invite that has no account yet, so an invite
 * still decides who is in. Every refusal that follows a guess is the same answer whatever the
 * reason, and nothing says whether an address or identity has an account.
 */
export class AuthRoutes {
  private readonly pending = new Map<string, Pending>();
  private readonly perAddress: RateLimiter;
  private readonly guesses: RateLimiter;
  private readonly total: RateLimiter;
  private readonly now: () => number;

  constructor(private readonly deps: AuthDeps) {
    const limits = { ...DEFAULT_AUTH_LIMITS, ...deps.limits };
    this.now = deps.now ?? Date.now;
    this.perAddress = new RateLimiter(limits.perAddress, this.now);
    this.guesses = new RateLimiter(limits.guessesPerAddress, this.now);
    this.total = new RateLimiter(limits.total, this.now, 4);
  }

  /** Paths answered without a bearer token. */
  isPublic(path: string): boolean {
    return /^\/v1\/auth\/(?:options|nonce|session|email|email\/verify|claim)$/u.test(path);
  }

  async handlePublic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const secure = { 'cache-control': 'no-store' };
    const answer = (status: number, body: unknown) => respond(res, status, body, secure);
    const address = req.socket.remoteAddress ?? 'unknown';
    // The mail route is held to the tight bucket too: every call can send mail through the owner's key.
    const guess = path !== '/v1/auth/options' && path !== '/v1/auth/nonce';
    this.limit(address, guess);

    if (path === '/v1/auth/options') {
      allow(method, 'GET');
      return answer(200, {
        apple: this.deps.verifiers.apple !== undefined,
        google: this.deps.verifiers.google !== undefined,
        email: this.deps.emailCodes !== undefined,
      });
    }
    if (path === '/v1/auth/nonce') {
      allow(method, 'POST');
      await drain(req);
      return answer(200, { nonce: this.deps.nonces.issue() });
    }
    if (path === '/v1/auth/session') {
      allow(method, 'POST');
      const body = providerBody.safeParse(await readJson(req, false));
      if (!body.success) throw new HttpError(400, 'invalid_request');
      const identity = await this.verifyProvider(body.data);
      return answer(200, this.signIn(identity, body.data.device));
    }
    if (path === '/v1/auth/email') {
      allow(method, 'POST');
      const { emailCodes } = this.deps;
      if (!emailCodes) throw new HttpError(404, 'not_found');
      const body = emailRequest.safeParse(await readJson(req, false));
      if (!body.success) throw new HttpError(400, 'invalid_request');
      const result = await emailCodes.request(body.data.address);
      if (!result.ok) {
        if (result.reason === 'invalid') throw new HttpError(400, 'invalid_request');
        if (result.reason === 'slow_down')
          throw new HttpError(429, 'quota_exceeded', { 'retry-after': '30' });
        throw new HttpError(503, 'mail_unavailable');
      }
      return answer(200, result.challenge);
    }
    if (path === '/v1/auth/email/verify') {
      allow(method, 'POST');
      const { emailCodes } = this.deps;
      if (!emailCodes) throw new HttpError(404, 'not_found');
      const body = emailVerify.safeParse(await readJson(req, false));
      if (!body.success) throw new HttpError(400, 'invalid_request');
      const identity = this.verifyEmail(emailCodes, body.data);
      return answer(200, this.signIn(identity, body.data.device));
    }
    if (path === '/v1/auth/claim') {
      allow(method, 'POST');
      const body = claimBody.safeParse(await readJson(req, false));
      if (!body.success) throw new HttpError(400, 'invalid_request');
      return answer(200, this.claim(body.data));
    }
    throw new HttpError(404, 'not_found');
  }

  /** The signed-in routes under `/v1/auth`: the account's devices and ways to sign in. */
  async handleSigned(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    invite: InviteInfo,
  ): Promise<boolean> {
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (!path.startsWith('/v1/auth/')) return false;
    const secure = { 'cache-control': 'no-store' };
    const { accounts } = this.deps;
    this.limit(`invite:${invite.inviteId}`, path === '/v1/auth/link');

    if (path === '/v1/auth/sessions') {
      allow(method, 'GET');
      const accountId = accounts.accountOf(invite.inviteId);
      respond(
        res,
        200,
        {
          sessions:
            accountId === undefined
              ? []
              : accounts.sessions(accountId).map((s) => ({
                  sessionId: s.sessionId,
                  deviceLabel: s.deviceLabel,
                  createdAt: s.createdAt,
                  lastSeenAt: s.lastSeenAt,
                  current: s.sessionId === invite.sessionId,
                })),
          identities: accountId === undefined ? [] : accounts.identities(accountId),
        },
        secure,
      );
      return true;
    }
    const one = /^\/v1\/auth\/sessions\/([^/]+)$/u.exec(path);
    if (one) {
      allow(method, 'DELETE');
      await drain(req);
      this.deps.reauthenticate(invite);
      const accountId = accounts.accountOf(invite.inviteId);
      if (
        accountId === undefined ||
        !accounts.revokeSession(accountId, decodeURIComponent(one[1] ?? ''))
      ) {
        throw new HttpError(404, 'not_found');
      }
      respond(res, 204, undefined, secure);
      return true;
    }
    if (path === '/v1/auth/sign-out') {
      allow(method, 'POST');
      const body = signOutBody.safeParse(await readJson(req, true));
      if (!body.success) throw new HttpError(400, 'invalid_request');
      this.deps.reauthenticate(invite);
      const accountId = accounts.accountOf(invite.inviteId);
      // Only a device signs itself out; an invite token is not a device.
      if (invite.sessionId === undefined || accountId === undefined) {
        throw new HttpError(400, 'not_a_device_session');
      }
      if (body.data.pushEndpoint !== undefined) {
        this.deps.removePush?.(invite.inviteId, body.data.pushEndpoint);
      }
      accounts.revokeSession(accountId, invite.sessionId);
      respond(res, 204, undefined, secure);
      return true;
    }
    if (path === '/v1/auth/link') {
      allow(method, 'POST');
      const body = linkBody.safeParse(await readJson(req, false));
      if (!body.success) throw new HttpError(400, 'invalid_request');
      const identity =
        'provider' in body.data
          ? await this.verifyProvider(body.data)
          : this.verifyEmail(this.requireEmailCodes(), body.data);
      this.deps.reauthenticate(invite);
      const accountId = accounts.accountOf(invite.inviteId);
      let outcome: 'linked' | 'already_here' | 'taken';
      if (accountId === undefined) {
        // The first identity of an account that so far signs in only with its invite token.
        const created = accounts.createAccountWithIdentity(invite.inviteId, identity);
        outcome = created === undefined ? 'taken' : 'linked';
      } else {
        outcome = accounts.linkIdentity(accountId, identity);
      }
      if (outcome === 'taken') throw new HttpError(409, 'identity_taken');
      respond(
        res,
        200,
        { status: outcome, identities: this.identitiesOf(invite.inviteId) },
        secure,
      );
      return true;
    }
    throw new HttpError(404, 'not_found');
  }

  private requireEmailCodes(): EmailCodes {
    if (!this.deps.emailCodes) throw new HttpError(404, 'not_found');
    return this.deps.emailCodes;
  }

  private identitiesOf(inviteId: string) {
    const accountId = this.deps.accounts.accountOf(inviteId);
    return accountId === undefined ? [] : this.deps.accounts.identities(accountId);
  }

  private limit(address: string, guess: boolean): void {
    const checks: Array<[RateLimiter, string]> = [
      [this.total, 'all'],
      [this.perAddress, address],
      ...(guess ? ([[this.guesses, address]] as Array<[RateLimiter, string]>) : []),
    ];
    for (const [limiter, key] of checks) {
      const taken = limiter.take(key);
      if (!taken.ok) {
        throw new HttpError(429, 'quota_exceeded', {
          'retry-after': String(Math.max(1, Math.ceil(taken.retryAfterMs / 1000))),
        });
      }
    }
  }

  /** The identity in a provider's ID token, or the one answer for every kind of bad token. */
  private async verifyProvider(body: {
    provider: 'apple' | 'google';
    idToken: string;
    nonce: string;
  }): Promise<Identity> {
    const verifier = this.deps.verifiers[body.provider];
    if (!verifier) throw new HttpError(404, 'not_found');
    // The nonce is spent first, so a token cannot be tried twice against one nonce.
    if (!this.deps.nonces.consume(body.nonce)) throw new HttpError(401, 'sign_in_failed');
    const verified = await verifier.verify(body.idToken, body.nonce);
    if (!verified) throw new HttpError(401, 'sign_in_failed');
    return {
      provider: verified.provider,
      subject: verified.subject,
      ...(verified.email === undefined ? {} : { email: verified.email }),
    };
  }

  private verifyEmail(
    codes: EmailCodes,
    body: { challengeId: string; deviceSecret: string; code: string },
  ): Identity {
    const address = codes.redeem(body.challengeId, body.deviceSecret, body.code);
    if (address === undefined) throw new HttpError(401, 'sign_in_failed');
    return { provider: 'email', subject: address, email: address };
  }

  /** A session when the identity has an account, else a pending token that asks for an invite. */
  private signIn(identity: Identity, deviceLabel: string | undefined) {
    const { accounts } = this.deps;
    const accountId = accounts.accountOfIdentity(identity);
    if (accountId !== undefined) {
      const session = accounts.issueSession(accountId, deviceLabel ?? '');
      // An account whose invite was revoked is refused like a wrong identity: it gets in nowhere.
      if (!session) throw new HttpError(401, 'sign_in_failed');
      return { status: 'signed_in', token: session.token, sessionId: session.sessionId };
    }
    if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) this.pending.delete(oldest.value);
    }
    const pendingToken = `pnd_${randomBytes(24).toString('base64url')}`;
    const expiresAt = this.now() + PENDING_TTL_MS;
    this.pending.set(pendingToken, { identity, expiresAt, tries: 0 });
    return { status: 'needs_invite', pendingToken, expiresAt };
  }

  /** Turns a pending identity into an account on an invite that is active and has no account yet. */
  private claim(body: { pendingToken: string; inviteToken: string; device?: string | undefined }) {
    const entry = this.pending.get(body.pendingToken);
    if (!entry || entry.expiresAt <= this.now()) {
      this.pending.delete(body.pendingToken);
      throw new HttpError(401, 'sign_in_failed');
    }
    entry.tries += 1;
    if (entry.tries >= PENDING_MAX_TRIES) this.pending.delete(body.pendingToken);
    const invite = this.deps.invites.resolve(body.inviteToken);
    // A bad token, a revoked invite and an invite that already has an account all look the same.
    const accountId = invite
      ? this.deps.accounts.createAccountWithIdentity(invite.inviteId, entry.identity)
      : undefined;
    if (accountId === undefined) throw new HttpError(403, 'invite_unavailable');
    this.pending.delete(body.pendingToken);
    const session = this.deps.accounts.issueSession(accountId, body.device ?? '');
    if (!session) throw new HttpError(403, 'invite_unavailable');
    return { status: 'signed_in', token: session.token, sessionId: session.sessionId };
  }
}

function allow(method: string, expected: string): void {
  if (method !== expected) throw new HttpError(405, 'method_not_allowed', { allow: expected });
}

async function drain(req: IncomingMessage): Promise<void> {
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.from(chunk).length;
    if (size > 1024) throw new HttpError(413, 'request_too_large');
  }
}
