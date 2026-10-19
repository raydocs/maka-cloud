export interface CacheLimits {
  /** Entries kept; 0 turns the cache off. */
  maxEntries: number;
  /** Rough ceiling on the summed `sizeOf` of the entries. */
  maxBytes?: number;
}

/** A least-recently-used cache with a hard size limit, so nothing built on it can grow without bound. */
export class BoundedCache<K, V> {
  private readonly entries = new Map<K, { value: V; bytes: number }>();
  private totalBytes = 0;

  constructor(
    private readonly limits: CacheLimits,
    private readonly sizeOf: (value: V) => number = () => 0,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    this.delete(key);
    const bytes = this.sizeOf(value);
    if (this.limits.maxEntries <= 0) return;
    if (this.limits.maxBytes !== undefined && bytes > this.limits.maxBytes) return;
    this.entries.set(key, { value, bytes });
    this.totalBytes += bytes;
    for (const [oldest, entry] of this.entries) {
      if (
        this.entries.size <= this.limits.maxEntries &&
        (this.limits.maxBytes === undefined || this.totalBytes <= this.limits.maxBytes)
      ) {
        break;
      }
      this.entries.delete(oldest);
      this.totalBytes -= entry.bytes;
    }
  }

  delete(key: K): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }
}
