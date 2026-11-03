import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Persisted outbox: an outside action (GitHub comment, push, PR open,
 * notification, message to an executor session) is stored before it runs,
 * retried with backoff, and delivered in order per session. Nothing wires this
 * into the runtime yet.
 */

export type OutboxState = 'pending' | 'done' | 'dead';

export interface OutboxItem {
  id: string;
  tenantId: string;
  sessionKey: string;
  kind: string;
  /** JSON string. The outbox never parses it. */
  payload: string;
  idempotencyKey: string;
  state: OutboxState;
  attempts: number;
  /** Earliest time (ms) the next delivery may run. */
  nextAt: number;
  lastError?: string;
  createdAt: number;
  doneAt?: number;
  /** Monotonic insert order, assigned by the store. */
  seq: number;
}

export type NewOutboxItem = Omit<OutboxItem, 'seq'>;

export interface OutboxFilter {
  tenantId?: string;
  sessionKey?: string;
  state?: OutboxState;
}

export interface OutboxStore {
  /** Insert a new row and assign its `seq`. */
  insert(item: NewOutboxItem): OutboxItem;
  findByIdempotency(tenantId: string, idempotencyKey: string): OutboxItem | undefined;
  get(id: string): OutboxItem | undefined;
  update(item: OutboxItem): void;
  /** The oldest pending item of each (tenantId, sessionKey), by seq. */
  pendingHeads(): OutboxItem[];
  /** The oldest pending item of one session, if any. */
  pendingHead(tenantId: string, sessionKey: string): OutboxItem | undefined;
  list(filter?: OutboxFilter): OutboxItem[];
}

export class MemoryOutboxStore implements OutboxStore {
  readonly #rows = new Map<string, OutboxItem>();
  #seq = 0;

  insert(item: NewOutboxItem): OutboxItem {
    const row: OutboxItem = { ...item, seq: ++this.#seq };
    this.#rows.set(row.id, row);
    return { ...row };
  }

  findByIdempotency(tenantId: string, idempotencyKey: string): OutboxItem | undefined {
    for (const row of this.#rows.values()) {
      if (row.tenantId === tenantId && row.idempotencyKey === idempotencyKey) return { ...row };
    }
    return undefined;
  }

  get(id: string): OutboxItem | undefined {
    const row = this.#rows.get(id);
    return row ? { ...row } : undefined;
  }

  update(item: OutboxItem): void {
    if (!this.#rows.has(item.id)) throw new Error(`outbox item not found: ${item.id}`);
    this.#rows.set(item.id, { ...item });
  }

  pendingHeads(): OutboxItem[] {
    const heads = new Map<string, OutboxItem>();
    for (const row of this.#rows.values()) {
      if (row.state !== 'pending') continue;
      const key = `${row.tenantId}\u0000${row.sessionKey}`;
      const current = heads.get(key);
      if (!current || row.seq < current.seq) heads.set(key, row);
    }
    return [...heads.values()].sort((a, b) => a.seq - b.seq).map((row) => ({ ...row }));
  }

  pendingHead(tenantId: string, sessionKey: string): OutboxItem | undefined {
    return this.list({ tenantId, sessionKey, state: 'pending' })[0];
  }

  list(filter: OutboxFilter = {}): OutboxItem[] {
    return [...this.#rows.values()]
      .filter(
        (row) =>
          (filter.tenantId === undefined || row.tenantId === filter.tenantId) &&
          (filter.sessionKey === undefined || row.sessionKey === filter.sessionKey) &&
          (filter.state === undefined || row.state === filter.state),
      )
      .sort((a, b) => a.seq - b.seq)
      .map((row) => ({ ...row }));
  }
}

/** Additive table. No user_version bump (same approach as `documents`). */
const OUTBOX_SQL = `
CREATE TABLE IF NOT EXISTS outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (state, session_key, seq);
CREATE UNIQUE INDEX IF NOT EXISTS outbox_idem ON outbox (tenant_id, idempotency_key);
`;

interface OutboxRow {
  seq: number;
  id: string;
  tenant_id: string;
  session_key: string;
  kind: string;
  payload: string;
  idempotency_key: string;
  state: string;
  attempts: number;
  next_at: number;
  last_error: string | null;
  created_at: number;
  done_at: number | null;
}

function fromRow(row: OutboxRow): OutboxItem {
  const item: OutboxItem = {
    id: row.id,
    tenantId: row.tenant_id,
    sessionKey: row.session_key,
    kind: row.kind,
    payload: row.payload,
    idempotencyKey: row.idempotency_key,
    state: row.state as OutboxState,
    attempts: row.attempts,
    nextAt: row.next_at,
    createdAt: row.created_at,
    seq: row.seq,
  };
  if (row.last_error !== null) item.lastError = row.last_error;
  if (row.done_at !== null) item.doneAt = row.done_at;
  return item;
}

export class SqliteOutboxStore implements OutboxStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(OUTBOX_SQL);
  }

  insert(item: NewOutboxItem): OutboxItem {
    const result = this.#db
      .prepare(
        `INSERT INTO outbox (id, tenant_id, session_key, kind, payload, idempotency_key,
           state, attempts, next_at, last_error, created_at, done_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.tenantId,
        item.sessionKey,
        item.kind,
        item.payload,
        item.idempotencyKey,
        item.state,
        item.attempts,
        item.nextAt,
        item.lastError ?? null,
        item.createdAt,
        item.doneAt ?? null,
      );
    return { ...item, seq: Number(result.lastInsertRowid) };
  }

  findByIdempotency(tenantId: string, idempotencyKey: string): OutboxItem | undefined {
    const row = this.#db
      .prepare('SELECT * FROM outbox WHERE tenant_id = ? AND idempotency_key = ?')
      .get(tenantId, idempotencyKey) as unknown as OutboxRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  get(id: string): OutboxItem | undefined {
    const row = this.#db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as unknown as
      | OutboxRow
      | undefined;
    return row ? fromRow(row) : undefined;
  }

  update(item: OutboxItem): void {
    const result = this.#db
      .prepare(
        `UPDATE outbox SET state = ?, attempts = ?, next_at = ?, last_error = ?, done_at = ?
         WHERE id = ?`,
      )
      .run(
        item.state,
        item.attempts,
        item.nextAt,
        item.lastError ?? null,
        item.doneAt ?? null,
        item.id,
      );
    if (result.changes === 0) throw new Error(`outbox item not found: ${item.id}`);
  }

  pendingHeads(): OutboxItem[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM outbox o
         WHERE o.state = 'pending'
           AND o.seq = (SELECT MIN(p.seq) FROM outbox p
                        WHERE p.state = 'pending'
                          AND p.tenant_id = o.tenant_id AND p.session_key = o.session_key)
         ORDER BY o.seq`,
      )
      .all() as unknown as OutboxRow[];
    return rows.map(fromRow);
  }

  pendingHead(tenantId: string, sessionKey: string): OutboxItem | undefined {
    const row = this.#db
      .prepare(
        `SELECT * FROM outbox WHERE state = 'pending' AND tenant_id = ? AND session_key = ?
         ORDER BY seq LIMIT 1`,
      )
      .get(tenantId, sessionKey) as unknown as OutboxRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(filter: OutboxFilter = {}): OutboxItem[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.tenantId !== undefined) {
      where.push('tenant_id = ?');
      args.push(filter.tenantId);
    }
    if (filter.sessionKey !== undefined) {
      where.push('session_key = ?');
      args.push(filter.sessionKey);
    }
    if (filter.state !== undefined) {
      where.push('state = ?');
      args.push(filter.state);
    }
    const sql = `SELECT * FROM outbox${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq`;
    return (this.#db.prepare(sql).all(...args) as unknown as OutboxRow[]).map(fromRow);
  }
}

/** Throw from a handler when retrying cannot help: the item goes straight to `dead`. */
export class PermanentOutboxError extends Error {
  readonly permanent = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentOutboxError';
  }
}

export type OutboxHandler = (item: OutboxItem) => Promise<void>;

export interface OutboxOptions {
  store: OutboxStore;
  /** Defaults to Date.now. */
  now?: () => number;
  /** Returns [0, 1). Defaults to Math.random. */
  random?: () => number;
  newId?: () => string;
  /** Attempts before an item goes `dead`. Default 8. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Called once when an item turns `dead`; the caller raises a needs-person card. */
  onDead?: (item: OutboxItem) => void | Promise<void>;
}

export interface EnqueueInput {
  tenantId: string;
  sessionKey: string;
  kind: string;
  payload: string;
  idempotencyKey: string;
}

export interface DrainResult {
  delivered: number;
  failed: number;
  dead: number;
  /** Heads whose kind has no handler. They stay pending and block their session. */
  skipped: number;
  /** Errors thrown by `onDead`; the item stays dead. */
  callbackErrors: string[];
}

export const OUTBOX_BASE_DELAY_MS = 1_000;
export const OUTBOX_MAX_DELAY_MS = 5 * 60_000;
export const OUTBOX_MAX_ATTEMPTS = 8;
const MAX_ERROR_CHARS = 500;

/**
 * Delay before retry number `attempts` (1 = after the first failure):
 * min(cap, base * 2^(attempts - 1)), then scaled by 0.5 + 0.5 * random so that
 * the delay lies in [raw / 2, raw] and never exceeds the cap.
 */
export function outboxBackoffMs(
  attempts: number,
  random: () => number,
  baseMs = OUTBOX_BASE_DELAY_MS,
  capMs = OUTBOX_MAX_DELAY_MS,
): number {
  const exponent = Math.max(0, attempts - 1);
  const raw = Math.min(capMs, baseMs * 2 ** Math.min(exponent, 40));
  return Math.round(raw * (0.5 + 0.5 * random()));
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}...` : text;
}

export class Outbox {
  readonly #store: OutboxStore;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #newId: () => string;
  readonly #maxAttempts: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #onDead: ((item: OutboxItem) => void | Promise<void>) | undefined;
  #draining: Promise<DrainResult> | undefined;

  constructor(options: OutboxOptions) {
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#newId = options.newId ?? randomUUID;
    this.#maxAttempts = options.maxAttempts ?? OUTBOX_MAX_ATTEMPTS;
    this.#baseDelayMs = options.baseDelayMs ?? OUTBOX_BASE_DELAY_MS;
    this.#maxDelayMs = options.maxDelayMs ?? OUTBOX_MAX_DELAY_MS;
    this.#onDead = options.onDead;
  }

  /** Store an action before it runs. A repeated idempotency key returns the existing row. */
  enqueue(input: EnqueueInput): OutboxItem {
    const existing = this.#store.findByIdempotency(input.tenantId, input.idempotencyKey);
    if (existing) return existing;
    const now = this.#now();
    return this.#store.insert({
      id: this.#newId(),
      tenantId: input.tenantId,
      sessionKey: input.sessionKey,
      kind: input.kind,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      state: 'pending',
      attempts: 0,
      nextAt: now,
      createdAt: now,
    });
  }

  get(id: string): OutboxItem | undefined {
    return this.#store.get(id);
  }

  list(filter?: OutboxFilter): OutboxItem[] {
    return this.#store.list(filter);
  }

  /**
   * Deliver due items. Each session works through its pending items oldest first:
   * a head that fails (or is not due yet, or has no handler) blocks the later
   * items of that session until it succeeds or turns `dead`; other sessions are
   * unaffected. After a success a session moves on to its next item if that item
   * is due. Concurrent calls share one run.
   */
  drain(handlers: Record<string, OutboxHandler>, now: number = this.#now()): Promise<DrainResult> {
    if (this.#draining) return this.#draining;
    const run = this.#drain(handlers, now).finally(() => {
      this.#draining = undefined;
    });
    this.#draining = run;
    return run;
  }

  async #drain(handlers: Record<string, OutboxHandler>, now: number): Promise<DrainResult> {
    const result: DrainResult = {
      delivered: 0,
      failed: 0,
      dead: 0,
      skipped: 0,
      callbackErrors: [],
    };
    for (const first of this.#store.pendingHeads()) {
      let head: OutboxItem | undefined = first;
      while (head && head.nextAt <= now) {
        const handler = Object.hasOwn(handlers, head.kind) ? handlers[head.kind] : undefined;
        if (!handler) {
          result.skipped += 1;
          break;
        }
        const outcome = await this.#deliver(head, handler, now, result);
        // A dead head no longer blocks: its session moves on, and onDead raised the card.
        if (outcome === 'retry') break;
        head = this.#store.pendingHead(head.tenantId, head.sessionKey);
      }
    }
    return result;
  }

  async #deliver(
    item: OutboxItem,
    handler: OutboxHandler,
    now: number,
    result: DrainResult,
  ): Promise<'done' | 'retry' | 'dead'> {
    try {
      await handler({ ...item });
    } catch (error) {
      const attempts = item.attempts + 1;
      const lastError = describeError(error);
      if (error instanceof PermanentOutboxError || attempts >= this.#maxAttempts) {
        const dead: OutboxItem = { ...item, state: 'dead', attempts, lastError };
        this.#store.update(dead);
        result.dead += 1;
        if (this.#onDead) {
          try {
            await this.#onDead({ ...dead });
          } catch (callbackError) {
            result.callbackErrors.push(describeError(callbackError));
          }
        }
        return 'dead';
      }
      const delay = outboxBackoffMs(attempts, this.#random, this.#baseDelayMs, this.#maxDelayMs);
      this.#store.update({ ...item, attempts, lastError, nextAt: now + delay });
      result.failed += 1;
      return 'retry';
    }
    this.#store.update({ ...item, state: 'done', attempts: item.attempts + 1, doneAt: now });
    result.delivered += 1;
    return 'done';
  }
}
