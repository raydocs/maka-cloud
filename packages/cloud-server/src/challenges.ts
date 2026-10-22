import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const NONCE_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_LIVE = 10_000;
const MAX_WRONG_CODES = 5;
/** A new code for the same address is not sent sooner than this, and not more than `MAX_SENDS` an hour. */
const RESEND_AFTER_MS = 30_000;
const MAX_SENDS_PER_HOUR = 5;

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function sameHash(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Drops the oldest entries of an insertion-ordered map until there is room for one more. */
function makeRoom<V>(map: Map<string, V>, max: number): void {
  while (map.size >= max) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

/**
 * Nonces for Apple and Google sign-in. One is given out per attempt, goes into the provider's
 * request, and comes back inside the signed ID token; it is good once and for ten minutes, so a
 * token that was captured cannot be replayed. Held in memory: one process owns the server, and a
 * restart only makes a person start the sign-in again.
 */
export class NonceStore {
  private readonly live = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(): string {
    makeRoom(this.live, MAX_LIVE);
    const nonce = randomBytes(24).toString('base64url');
    this.live.set(nonce, this.now() + NONCE_TTL_MS);
    return nonce;
  }

  /** True once per issued, unexpired nonce. */
  consume(nonce: string): boolean {
    const expires = this.live.get(nonce);
    this.live.delete(nonce);
    return expires !== undefined && expires > this.now();
  }
}

/** The address, in the form it is compared and mailed in, or nothing for one that cannot be one. */
export function normalizeEmail(value: string): string | undefined {
  const address = value.trim().toLowerCase();
  if (address.length < 3 || address.length > 254) return undefined;
  // One @, a local part and a dotted domain, ASCII only and no spaces, quotes, commas, brackets or
  // control characters: an address that needs more than this is not one we will mail a code to.
  if (!/^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(address)) return undefined;
  return address;
}

export interface Mailer {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

export interface EmailChallenge {
  challengeId: string;
  /** Kept by the device that asked; the code is useless without it. */
  deviceSecret: string;
  expiresAt: number;
}

interface Pending {
  address: string;
  codeHash: Buffer;
  deviceHash: Buffer;
  expiresAt: number;
  wrong: number;
}

/**
 * Sign-in by a code mailed to an address. The device that asks gets a challenge id and a secret;
 * the code arrives only in the mail; redeeming needs all three, so a code that someone else sees
 * is no use from another device. A code works once, for ten minutes, and dies after five wrong
 * tries. Mail goes out through the owner's mailer, and with none there is no email sign-in.
 */
export class EmailCodes {
  private readonly pending = new Map<string, Pending>();
  private readonly sends = new Map<string, number[]>();

  constructor(
    private readonly mailer: Mailer,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Mails a code to a valid address and returns the challenge, or says why not: `invalid` for a
   * bad address, `slow_down` when this address was mailed too recently or too often, `mail_failed`
   * when the mailer refused. It never says whether the address already has an account.
   */
  async request(
    rawAddress: string,
  ): Promise<
    | { ok: true; challenge: EmailChallenge }
    | { ok: false; reason: 'invalid' | 'slow_down' | 'mail_failed' }
  > {
    const address = normalizeEmail(rawAddress);
    if (address === undefined) return { ok: false, reason: 'invalid' };
    const at = this.now();
    const recent = (this.sends.get(address) ?? []).filter((time) => at - time < 60 * 60 * 1000);
    const last = recent[recent.length - 1];
    if (
      recent.length >= MAX_SENDS_PER_HOUR ||
      (last !== undefined && at - last < RESEND_AFTER_MS)
    ) {
      return { ok: false, reason: 'slow_down' };
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const challengeId = `chl_${randomBytes(9).toString('base64url')}`;
    const deviceSecret = randomBytes(24).toString('base64url');
    // A new code replaces the older one for the same address: only the last mail can be redeemed.
    for (const [id, other] of this.pending) if (other.address === address) this.pending.delete(id);
    makeRoom(this.pending, MAX_LIVE);
    const expiresAt = at + CODE_TTL_MS;
    this.pending.set(challengeId, {
      address,
      codeHash: sha256(code),
      deviceHash: sha256(deviceSecret),
      expiresAt,
      wrong: 0,
    });
    makeRoom(this.sends, MAX_LIVE);
    this.sends.set(address, [...recent, at]);
    try {
      await this.mailer.send({
        to: address,
        subject: 'Your sign-in code',
        text: `Your sign-in code is ${code}. It works once, for ten minutes, in the app or page that asked for it. If you did not ask, ignore this mail.`,
      });
    } catch {
      this.pending.delete(challengeId);
      return { ok: false, reason: 'mail_failed' };
    }
    return { ok: true, challenge: { challengeId, deviceSecret, expiresAt } };
  }

  /**
   * The address a code proves, once. Every failure is the same nothing: a wrong or reused code, a
   * wrong device secret, an expired or unknown challenge. A wrong code or secret counts against
   * the challenge, which is gone after the fifth.
   */
  redeem(challengeId: string, deviceSecret: string, code: string): string | undefined {
    const entry = this.pending.get(challengeId);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.pending.delete(challengeId);
      return undefined;
    }
    const right =
      sameHash(entry.deviceHash, sha256(deviceSecret)) &&
      sameHash(entry.codeHash, sha256(code.trim()));
    if (!right) {
      entry.wrong += 1;
      if (entry.wrong >= MAX_WRONG_CODES) this.pending.delete(challengeId);
      return undefined;
    }
    this.pending.delete(challengeId);
    return entry.address;
  }
}
