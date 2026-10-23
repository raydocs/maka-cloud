import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import type { AccountStore, Identity } from './accounts.js';
import type { EmailCodes, NonceStore } from './challenges.js';
import { HttpError, readJson, respond } from './http.js';
import { type Language, languageFromAcceptLanguage } from './i18n.js';
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
  /**
   * The addresses (IPs or CIDR ranges) of the reverse proxy in front of the server (the
   * deployment's Caddy or nginx). A request whose socket address is one of them is counted against
   * the client address the proxy put last in `X-Forwarded-For`; a request from any other address is
   * counted against its own address and its header is ignored, so a caller that reaches the server
   * directly cannot choose its bucket. Without any, every person would share the proxy's address
   * and its limits.
   */
  trustedProxies?: readonly string[];
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
  private readonly proxies: ProxyList | undefined;

  constructor(private readonly deps: AuthDeps) {
    this.proxies = deps.trustedProxies?.length ? proxyList(deps.trustedProxies) : undefined;
    const limits = { ...DEFAULT_AUTH_LIMITS, ...deps.limits };
    this.now = deps.now ?? Date.now;
    this.perAddress = new RateLimiter(limits.perAddress, this.now);
    this.guesses = new RateLimiter(limits.guessesPerAddress, this.now);
    this.total = new RateLimiter(limits.total, this.now, 4);
  }

  /** Who a request is counted as, for the per-address limits. */
  private clientOf(req: IncomingMessage): string {
    const header = req.headers['x-forwarded-for'];
    return clientAddress(
      req.socket.remoteAddress ?? 'unknown',
      Array.isArray(header) ? header.join(',') : header,
      this.proxies,
    );
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
    const address = this.clientOf(req);
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
      // The account's language when the address has one, else what this request asks for.
      const result = await emailCodes.request(
        body.data.address,
        languageFromAcceptLanguage(req.headers['accept-language']),
        (address) => this.deps.accounts.languageOf({ provider: 'email', subject: address }),
      );
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
      return answer(
        200,
        this.claim(body.data, languageFromAcceptLanguage(req.headers['accept-language'])),
      );
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
      if (accountId === undefined || !accounts.revokeSession(accountId, idOf(one[1]))) {
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
        if (created !== undefined) {
          const language = languageFromAcceptLanguage(req.headers['accept-language']);
          this.deps.invites.setLanguage(invite.inviteId, language, true);
        }
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
      if (session) {
        return { status: 'signed_in', token: session.token, sessionId: session.sessionId };
      }
      // The account's invite was revoked: the identity gets in nowhere, and is asked for an invite
      // like a new one. A claim with a new invite frees it from the dead account.
    }
    if (this.pending.size >= MAX_PENDING) {
      // Spent sign-ins first: a burst must not push out one that is still live.
      const at = this.now();
      for (const [token, entry] of this.pending)
        if (entry.expiresAt <= at) this.pending.delete(token);
      const oldest = this.pending.keys().next();
      if (this.pending.size >= MAX_PENDING && !oldest.done) this.pending.delete(oldest.value);
    }
    const pendingToken = `pnd_${randomBytes(24).toString('base64url')}`;
    const expiresAt = this.now() + PENDING_TTL_MS;
    this.pending.set(pendingToken, { identity, expiresAt, tries: 0 });
    return { status: 'needs_invite', pendingToken, expiresAt };
  }

  /** Turns a pending identity into an account on an invite that is active and has no account yet. */
  private claim(
    body: { pendingToken: string; inviteToken: string; device?: string | undefined },
    language: Language,
  ) {
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
    if (accountId === undefined || !invite) throw new HttpError(403, 'invite_unavailable');
    this.pending.delete(body.pendingToken);
    // A new account speaks the language its sign-up asked for, unless its person already chose one.
    this.deps.invites.setLanguage(invite.inviteId, language, true);
    const session = this.deps.accounts.issueSession(accountId, body.device ?? '');
    if (!session) throw new HttpError(403, 'invite_unavailable');
    return { status: 'signed_in', token: session.token, sessionId: session.sessionId };
  }
}

/** Whether a socket address is one of the configured proxies. */
export type ProxyList = (address: string) => boolean;

/** An address as `net` compares it: an IPv4 address inside an IPv6 one (`::ffff:a.b.c.d`) is the IPv4 address. */
function plainAddress(address: string): string {
  return address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/iu, '');
}

/** Reads IPs and CIDR ranges (`10.0.0.2`, `172.29.80.0/24`, `::1`). Throws on an entry it cannot read. */
export function proxyList(entries: readonly string[]): ProxyList {
  const list = new BlockList();
  for (const raw of entries) {
    const [address = '', prefix, ...extra] = plainAddress(raw.trim()).split('/');
    const family = isIP(address);
    if (family === 0 || extra.length > 0) throw new Error(`"${raw}" is not an IP address or range`);
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) list.addAddress(address, type);
    else {
      const bits = Number(prefix);
      if (!/^\d{1,3}$/u.test(prefix) || bits > (family === 4 ? 32 : 128))
        throw new Error(`"${raw}" is not an IP address or range`);
      list.addSubnet(address, bits, type);
    }
  }
  return (address) => {
    const plain = plainAddress(address);
    const family = isIP(plain);
    return family !== 0 && list.check(plain, family === 4 ? 'ipv4' : 'ipv6');
  };
}

/**
 * The address a request is counted against. When the socket address is a configured proxy the
 * client is the last `X-Forwarded-For` entry (the one the proxy itself added; earlier entries are
 * the client's to forge). From any other peer the header means nothing.
 */
export function clientAddress(
  socket: string,
  forwardedFor: string | undefined,
  proxies: ProxyList | undefined,
): string {
  if (!proxies?.(socket)) return socket;
  const last = forwardedFor?.split(',').pop()?.trim();
  return last !== undefined && isIP(last) !== 0 ? last : socket;
}

/** A path segment as an id; one that is not valid percent-encoding is an id nobody has. */
function idOf(segment: string | undefined): string {
  try {
    return decodeURIComponent(segment ?? '');
  } catch {
    return '';
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
