import { createPublicKey, timingSafeEqual, verify } from 'node:crypto';

/** Who a provider says someone is. `subject` is the provider's own stable id, never the email. */
export interface VerifiedIdentity {
  provider: 'apple' | 'google';
  subject: string;
  /** What the provider reports; it is shown to the person and never used to find or link an account. */
  email?: string;
  emailVerified: boolean;
}

export interface OidcConfig {
  provider: 'apple' | 'google';
  /** The `iss` values the provider signs with. */
  issuers: readonly string[];
  /** The client ids the owner registered (an app, the web); a token must be made for one of them. */
  audiences: readonly string[];
  jwksUri: string;
}

export const APPLE: Omit<OidcConfig, 'audiences'> = {
  provider: 'apple',
  issuers: ['https://appleid.apple.com'],
  jwksUri: 'https://appleid.apple.com/auth/keys',
};

export const GOOGLE: Omit<OidcConfig, 'audiences'> = {
  provider: 'google',
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
  jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
};

/** Fetches a provider's key set. Production goes through the public-internet-only fetch; tests pass a fake. */
export type JwksSource = (uri: string) => Promise<{ keys: JsonWebKey[] } | undefined>;

const MAX_TOKEN_CHARS = 8 * 1024;
const MAX_JWKS_BYTES = 64 * 1024;
const CLOCK_SKEW_MS = 60_000;
/** A token that claims to live longer than this is refused whatever its signature says. */
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const KEYS_FRESH_MS = 60 * 60 * 1000;
/** Keys older than this are no longer trusted even when the provider cannot be reached. */
const KEYS_STALE_MS = 24 * 60 * 60 * 1000;
/** An unknown key id may trigger a refetch, but not more often than this. */
const REFETCH_EVERY_MS = 60_000;
const MIN_RSA_BITS = 2048;

/** The key set of one provider, cached. A failed fetch keeps the old keys for a day, then nothing. */
export class JwksCache {
  private keys = new Map<string, JsonWebKey>();
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private attemptedAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly uri: string,
    private readonly source: JwksSource,
    private readonly now: () => number = Date.now,
  ) {}

  async get(kid: string): Promise<JsonWebKey | undefined> {
    const now = this.now();
    const known = this.keys.get(kid);
    const fresh = now - this.fetchedAt < KEYS_FRESH_MS;
    if (known && fresh) return known;
    if (now - this.attemptedAt >= REFETCH_EVERY_MS) await this.refresh();
    const after = this.keys.get(kid);
    return after && this.now() - this.fetchedAt < KEYS_STALE_MS ? after : undefined;
  }

  private refresh(): Promise<void> {
    this.inFlight ??= (async () => {
      this.attemptedAt = this.now();
      try {
        const set = await this.source(this.uri);
        if (!set || !Array.isArray(set.keys)) return;
        const next = new Map<string, JsonWebKey & { kid?: string }>();
        for (const key of set.keys as Array<JsonWebKey & { kid?: unknown }>) {
          if (typeof key.kid === 'string' && key.kid.length > 0 && key.kid.length <= 128) {
            next.set(key.kid, key as JsonWebKey);
          }
        }
        if (next.size === 0) return;
        this.keys = next;
        this.fetchedAt = this.now();
      } catch {
        // The old keys stay, until they are too old to trust.
      } finally {
        this.inFlight = undefined;
      }
    })();
    return this.inFlight;
  }
}

/** The key set from a provider's well-known address, fetched with the safe fetch. */
export function jwksFromSafeFetch(
  safeFetch: (
    url: string,
    options: { accept: readonly string[]; maxBytes: number; timeoutMs: number },
  ) => Promise<{ ok: true; body: Buffer } | { ok: false }>,
): JwksSource {
  return async (uri) => {
    const result = await safeFetch(uri, {
      accept: ['application/json'],
      maxBytes: MAX_JWKS_BYTES,
      timeoutMs: 5_000,
    });
    if (!result.ok) return undefined;
    return JSON.parse(result.body.toString('utf8')) as { keys: JsonWebKey[] };
  };
}

function decode(part: string): Buffer | undefined {
  return /^[A-Za-z0-9_-]+$/.test(part) ? Buffer.from(part, 'base64url') : undefined;
}

function json(part: string): Record<string, unknown> | undefined {
  const bytes = decode(part);
  if (!bytes) return undefined;
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface IdentityVerifier {
  readonly provider: 'apple' | 'google';
  /**
   * The identity in an ID token, when and only when the token is signed by the provider's key,
   * was issued by the provider for one of the owner's client ids, has not expired, and carries
   * exactly the nonce this server gave out for the sign-in. Anything else is nothing: no reason is
   * returned, so a caller cannot tell a caller which check failed.
   */
  verify(idToken: string, nonce: string): Promise<VerifiedIdentity | undefined>;
}

/**
 * Verifies OpenID Connect ID tokens of one provider. Only RS256 is accepted (`none`, HMAC and
 * every other algorithm are refused, so a token cannot choose a weaker check), RSA keys under
 * 2048 bits are refused, and the key comes only from the provider's own key set by `kid`.
 * With no client id configured there is no verifier: the provider is off.
 */
export function createOidcVerifier(
  config: OidcConfig,
  source: JwksSource,
  now: () => number = Date.now,
): IdentityVerifier | undefined {
  const audiences = config.audiences.filter((id) => id.length > 0);
  if (audiences.length === 0) return undefined;
  const keys = new JwksCache(config.jwksUri, source, now);
  return {
    provider: config.provider,
    async verify(idToken, nonce) {
      try {
        return await check(idToken, nonce);
      } catch {
        return undefined;
      }
    },
  };

  async function check(idToken: string, nonce: string): Promise<VerifiedIdentity | undefined> {
    if (nonce.length === 0 || idToken.length > MAX_TOKEN_CHARS) return undefined;
    const parts = idToken.split('.');
    if (parts.length !== 3) return undefined;
    const [head, body, signature] = parts as [string, string, string];
    const header = json(head);
    const claims = json(body);
    const sig = decode(signature);
    if (!header || !claims || !sig || sig.length === 0) return undefined;
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return undefined;

    const jwk = await keys.get(header.kid);
    if (!jwk || jwk.kty !== 'RSA' || typeof jwk.n !== 'string') return undefined;
    if (jwk.use !== undefined && jwk.use !== 'sig') return undefined;
    if (jwk.alg !== undefined && jwk.alg !== 'RS256') return undefined;
    if ((decode(jwk.n)?.length ?? 0) * 8 < MIN_RSA_BITS) return undefined;
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    if (!verify('RSA-SHA256', Buffer.from(`${head}.${body}`), key, sig)) return undefined;

    const at = now();
    if (typeof claims.iss !== 'string' || !config.issuers.includes(claims.iss)) return undefined;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.some((value) => typeof value === 'string' && audiences.includes(value))) {
      return undefined;
    }
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return undefined;
    const exp = claims.exp * 1000;
    if (exp < at - CLOCK_SKEW_MS || exp > at + MAX_LIFETIME_MS + CLOCK_SKEW_MS) return undefined;
    for (const claim of [claims.iat, claims.nbf]) {
      if (claim === undefined) continue;
      if (typeof claim !== 'number' || !Number.isFinite(claim)) return undefined;
      if (claim * 1000 > at + CLOCK_SKEW_MS) return undefined;
    }
    if (typeof claims.nonce !== 'string' || !sameText(claims.nonce, nonce)) return undefined;
    if (typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 255) {
      return undefined;
    }
    const email =
      typeof claims.email === 'string' && claims.email.length <= 254 ? claims.email : undefined;
    // Apple sends the flag as a string, Google as a boolean.
    const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
    return {
      provider: config.provider,
      subject: claims.sub,
      ...(email === undefined ? {} : { email }),
      emailVerified: email !== undefined && emailVerified,
    };
  }
}
