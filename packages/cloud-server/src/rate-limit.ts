import { BoundedCache } from '@maka-cloud/orchestrator';

interface Bucket {
  tokens: number;
  at: number;
}

/**
 * A token bucket per key. The table is a bounded cache: a key evicted for
 * space comes back with a full bucket, which only ever favors the client, and
 * the table cannot grow with the number of keys seen.
 */
export class RateLimiter {
  private readonly buckets: BoundedCache<string, Bucket>;

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    keys = 1024,
  ) {
    this.buckets = new BoundedCache({ maxEntries: keys });
  }

  /** Takes one token, or returns how many milliseconds until one is free. */
  take(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    const perMs = this.perMinute / 60_000;
    const bucket = this.buckets.get(key) ?? { tokens: this.perMinute, at: now };
    bucket.tokens = Math.min(this.perMinute, bucket.tokens + (now - bucket.at) * perMs);
    bucket.at = now;
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return { ok: false, retryAfterMs: Math.ceil((1 - bucket.tokens) / perMs) };
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return { ok: true };
  }
}
