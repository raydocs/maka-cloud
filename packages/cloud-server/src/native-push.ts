import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db.js';
import type { FeedHub } from './feed.js';
import { DEFAULT_LANGUAGE, type Language, messages } from './i18n.js';
import { pushAccountTag } from './push.js';

/**
 * Native push for the phone app, through the Expo push service, which hands each message to APNs
 * or FCM with the credentials the owner put into EAS. The server holds no APNs or FCM credential;
 * only, when the Expo project asks for one, an Expo access token.
 */
export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

/** One message as the Expo push service takes it. */
export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  /** Ids only: what the app needs to open the right screen, never what a task or model wrote. */
  data: Record<string, string>;
  /** The notification's actions, which the app registers ("Got it", "Not now"; never Approve). */
  categoryId: string;
  sound: 'default';
  priority: 'default' | 'high';
  ttl: number;
}

export type ExpoTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message?: string; details?: { error?: string } };

export type ExpoReceipt =
  | { status: 'ok' }
  | { status: 'error'; message?: string; details?: { error?: string } };

/**
 * Talks to the Expo push service. `send` answers one ticket per message, in order; both reject on
 * a network error, an HTTP error or an abort. Tests pass a fake.
 */
export interface ExpoTransport {
  send(messages: ExpoMessage[], signal: AbortSignal): Promise<ExpoTicket[]>;
  receipts(ids: string[], signal: AbortSignal): Promise<Record<string, ExpoReceipt>>;
}

export interface NativePushOptions {
  /** Sent as a bearer token when the Expo project requires one. Held in memory only. */
  accessToken?: string;
  /** Default: HTTPS to the Expo push service. */
  transport?: ExpoTransport;
  now?: () => number;
  /** Wait before the next attempt is `retryDelayMs` times the attempts so far. */
  retryDelayMs?: number;
  /** Attempts per device and message before the message is dropped. */
  maxAttempts?: number;
  /** How long after a send its receipt is asked for (Expo keeps receipts for a day). */
  receiptDelayMs?: number;
  timeoutMs?: number;
  onWarning?: (message: string, detail?: unknown) => void;
}

export type NativeRegisterResult = 'created' | 'updated' | 'invalid_token' | 'limit';

export type NativePushApi = Pick<NativePushService, 'register' | 'remove'>;

/** What an Expo push token looks like; anything else is refused before it is stored. */
const TOKEN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/u;
const TOKENS_PER_INVITE = 10;
const TOKENS_TOTAL = 1000;
const BATCH = 100;
const RECEIPT_BATCH = 300;
const TTL_SECONDS = 24 * 60 * 60;
const DAY_MS = TTL_SECONDS * 1000;

/** Inbox kinds the phone is told about, and the category (actions) each is shown with. */
const CATEGORY_OF_ITEM: Record<string, 'approval' | 'decision'> = {
  approval: 'approval',
  budget: 'decision',
  decision: 'decision',
  verification_failed: 'decision',
  blocked: 'decision',
};

const STATE_OF: Record<string, string> = {
  task_succeeded: 'succeeded',
  task_failed: 'failed',
  task_cancelled: 'cancelled',
};

interface Pending {
  token: string;
  inviteId: string;
  /** `task:<taskId>` or `item:<itemId>`: one message per device. */
  ref: string;
  conversationId: string;
  kind: 'task' | 'item';
  id: string;
  /** The task's end, or the item's kind. */
  detail: string;
}

const PENDING_TASKS_SQL = `
SELECT s.token, s.invite_id, t.task_id AS id, f.conversation_id,
  json_extract(t.event, '$.type') AS detail
FROM feed f
JOIN task_log t ON t.seq = CAST(f.ref AS INTEGER)
JOIN task_index i ON i.task_id = t.task_id AND i.parent_task_id IS NULL
JOIN conversations c ON c.conversation_id = f.conversation_id
JOIN native_push_tokens s ON f.id > s.since_feed_id AND s.invite_id = c.owner
LEFT JOIN native_push_deliveries d ON d.token = s.token AND d.ref = 'task:' || t.task_id
WHERE f.kind = 'task.event' AND f.id > ?
  AND json_extract(t.event, '$.type') IN ('task_succeeded', 'task_failed', 'task_cancelled')
  AND d.ref IS NULL
ORDER BY f.id, s.token
LIMIT ?`;

const PENDING_ITEMS_SQL = `
SELECT s.token, s.invite_id, m.item_id AS id, m.conversation_id, m.kind AS detail
FROM native_push_items m
JOIN conversations c ON c.conversation_id = m.conversation_id
JOIN native_push_tokens s ON m.seq > s.since_item_seq AND s.invite_id = c.owner
LEFT JOIN native_push_deliveries d ON d.token = s.token AND d.ref = 'item:' || m.item_id
WHERE d.ref IS NULL
ORDER BY m.seq, s.token
LIMIT ?`;

/**
 * Tells the person's phones that they are needed: an inbox item that waits for a decision or an
 * approval (as the supervisor decided to interrupt, after mutes, quiet hours and the hourly cap),
 * or a top-level task of theirs that ended, so its result card is ready. A device hears only about
 * the conversations its own invite owns, and only about what came after it registered.
 *
 * The message is fixed words from the server's catalogue in the person's language, and ids:
 * nothing a task or a model wrote reaches the push service. What is owed is derived from the
 * database (the feed, the needs-you list and `native_push_deliveries`), so a restart sends what was
 * missed and nothing twice. A device the service says is gone (`DeviceNotRegistered`, in a ticket
 * or a later receipt) is forgotten.
 */
export class NativePushService {
  private readonly transport: ExpoTransport;
  private readonly abort = new AbortController();
  private readonly cooling = new Map<string, { attempts: number; notBefore: number }>();
  private readonly now: () => number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly receiptDelayMs: number;
  private readonly timeoutMs: number;
  private floor = 0;
  private dirty = false;
  private running: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;
  private offRevoke: (() => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly hub: FeedHub,
    private readonly invites: {
      active(inviteId: string): boolean;
      onRevoke?(listener: (inviteId: string) => void): () => void;
      language?(inviteId: string): Language;
    },
    private readonly options: NativePushOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.retryDelayMs = options.retryDelayMs ?? 5_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.receiptDelayMs = options.receiptDelayMs ?? 15 * 60_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.transport = options.transport ?? expoHttpsTransport(options.accessToken);
  }

  /** Keeps one row per device token; a token another invite held moves here and starts afresh. */
  register(inviteId: string, token: string, platform: 'ios' | 'android'): NativeRegisterResult {
    if (!TOKEN.test(token)) return 'invalid_token';
    return transaction(this.db, (): NativeRegisterResult => {
      const existing = this.db
        .prepare('SELECT invite_id FROM native_push_tokens WHERE token = ?')
        .get(token) as { invite_id: string } | undefined;
      if (existing?.invite_id === inviteId) {
        this.db
          .prepare('UPDATE native_push_tokens SET platform = ? WHERE token = ?')
          .run(platform, token);
        return 'updated';
      }
      if (
        !existing &&
        (this.count('SELECT COUNT(*) AS n FROM native_push_tokens WHERE invite_id = ?', inviteId) >=
          TOKENS_PER_INVITE ||
          this.count('SELECT COUNT(*) AS n FROM native_push_tokens') >= TOKENS_TOTAL)
      ) {
        return 'limit';
      }
      const { feed } = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS feed FROM feed').get() as {
        feed: number;
      };
      const { item } = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS item FROM native_push_items')
        .get() as { item: number };
      // A device that moves is owed nothing from before, and keeps no record of the old invite's.
      this.db.prepare('DELETE FROM native_push_deliveries WHERE token = ?').run(token);
      this.db
        .prepare(
          `INSERT INTO native_push_tokens (token, invite_id, platform, since_feed_id, since_item_seq, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (token) DO UPDATE SET invite_id = excluded.invite_id, platform = excluded.platform,
             since_feed_id = excluded.since_feed_id, since_item_seq = excluded.since_item_seq,
             created_at = excluded.created_at`,
        )
        .run(token, inviteId, platform, feed, item, this.now());
      this.uncool(token);
      return existing ? 'updated' : 'created';
    });
  }

  /** Removes a token its own invite registered (the phone turning notifications off, or signing out). */
  remove(inviteId: string, token: string): boolean {
    const removed =
      Number(
        this.db
          .prepare('DELETE FROM native_push_tokens WHERE token = ? AND invite_id = ?')
          .run(token, inviteId).changes,
      ) > 0;
    if (removed) this.forget(token);
    return removed;
  }

  /**
   * The supervisor decided to interrupt for these items: each device of the owner of the item's
   * conversation is told once that a decision (or an approval) waits. Other kinds are ignored.
   */
  needed(items: ReadonlyArray<{ itemId: string; conversationId: string; kind: string }>): void {
    if (this.closed) return;
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO native_push_items (item_id, conversation_id, kind, at) VALUES (?, ?, ?, ?)',
    );
    for (const item of items) {
      if (CATEGORY_OF_ITEM[item.kind] === undefined) continue;
      insert.run(item.itemId, item.conversationId, item.kind, this.now());
    }
    this.kick();
  }

  start(): void {
    if (this.closed || this.unsubscribe) return;
    this.unsubscribe = this.hub.subscribe(() => this.kick());
    this.offRevoke = this.invites.onRevoke?.((inviteId) => {
      const rows = this.db
        .prepare('SELECT token FROM native_push_tokens WHERE invite_id = ?')
        .all(inviteId) as unknown as Array<{ token: string }>;
      for (const row of rows) this.forget(row.token);
    });
    this.kick();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    this.offRevoke?.();
    clearTimeout(this.timer);
    this.abort.abort();
    await this.running;
  }

  private count(sql: string, ...args: string[]): number {
    return (this.db.prepare(sql).get(...args) as { n: number }).n;
  }

  private warn(message: string, detail?: unknown): void {
    this.options.onWarning?.(message, detail);
  }

  private kick(): void {
    this.dirty = true;
    if (this.running || this.closed) return;
    this.running = this.pump().finally(() => {
      this.running = undefined;
      if (this.dirty && !this.closed) this.kick();
    });
  }

  private async pump(): Promise<void> {
    try {
      while (this.dirty && !this.closed) {
        this.dirty = false;
        await this.pass();
      }
    } catch (error) {
      // The next commit tries again; nothing here may take the server down.
      this.warn('Native push pass failed', error);
    }
  }

  private async pass(): Promise<void> {
    const at = this.now();
    // Items are owed for a day, like the messages themselves.
    transaction(this.db, () => {
      this.db
        .prepare(
          `DELETE FROM native_push_deliveries WHERE ref IN
           (SELECT 'item:' || item_id FROM native_push_items WHERE at < ?)`,
        )
        .run(at - DAY_MS);
      this.db.prepare('DELETE FROM native_push_items WHERE at < ?').run(at - DAY_MS);
    });
    const { mark } = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS mark FROM feed').get() as {
      mark: number;
    };
    const limit = BATCH + this.cooling.size;
    const batch = [...this.pendingTasks(limit), ...this.pendingItems(limit)];
    const due = batch.filter((item) => (this.cooling.get(keyOf(item))?.notBefore ?? 0) <= at);
    for (let i = 0; i < due.length && !this.closed; i += BATCH) {
      await this.send(due.slice(i, i + BATCH));
    }
    await this.checkReceipts();
    if (batch.length === 0 && this.cooling.size === 0) this.floor = Math.max(this.floor, mark);
    if (batch.length > due.length || due.length >= BATCH) this.dirty = true;
    this.schedule();
  }

  private pendingTasks(limit: number): Pending[] {
    const rows = this.db.prepare(PENDING_TASKS_SQL).all(this.floor, limit) as unknown as Row[];
    return rows.map((row) => toPending(row, 'task'));
  }

  private pendingItems(limit: number): Pending[] {
    const rows = this.db.prepare(PENDING_ITEMS_SQL).all(limit) as unknown as Row[];
    return rows.map((row) => toPending(row, 'item'));
  }

  /** The owner is read again right before the send: the device may have moved or the invite gone. */
  private current(item: Pending): 'send' | 'skip' | 'revoked' {
    const row = this.db
      .prepare(
        `SELECT 1 FROM native_push_tokens s, conversations c
         WHERE s.token = ? AND s.invite_id = ? AND c.conversation_id = ? AND c.owner = s.invite_id`,
      )
      .get(item.token, item.inviteId, item.conversationId);
    if (!row) return 'skip';
    return this.invites.active(item.inviteId) ? 'send' : 'revoked';
  }

  private message(item: Pending): ExpoMessage {
    const lang = this.invites.language?.(item.inviteId) ?? DEFAULT_LANGUAGE;
    const words = messages(lang).push;
    const accountTag = pushAccountTag(this.db, item.inviteId);
    if (item.kind === 'task') {
      return {
        to: item.token,
        ...words.taskFinished,
        data: {
          type: 'task.finished',
          accountTag,
          conversationId: item.conversationId,
          taskId: item.id,
          state: STATE_OF[item.detail] ?? item.detail,
        },
        categoryId: 'finished',
        sound: 'default',
        priority: 'default',
        ttl: TTL_SECONDS,
      };
    }
    const category = CATEGORY_OF_ITEM[item.detail] ?? 'decision';
    return {
      to: item.token,
      ...words.decisionWaiting,
      data: {
        type: 'inbox.needed',
        accountTag,
        conversationId: item.conversationId,
        itemId: item.id,
        kind: category,
      },
      categoryId: category,
      sound: 'default',
      priority: 'high',
      ttl: TTL_SECONDS,
    };
  }

  private async send(items: Pending[]): Promise<void> {
    const sendable: Pending[] = [];
    for (const item of items) {
      const state = this.current(item);
      if (state === 'revoked') this.finish(item, 'revoked');
      else if (state === 'send') sendable.push(item);
    }
    if (sendable.length === 0) return;
    let tickets: ExpoTicket[] | undefined;
    try {
      tickets = await this.transport.send(
        sendable.map((item) => this.message(item)),
        AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.timeoutMs)]),
      );
    } catch (error) {
      if (this.closed) return;
      this.warn('The Expo push service did not take the messages', errorName(error));
    }
    sendable.forEach((item, index) => {
      const ticket = tickets?.[index];
      if (ticket?.status === 'ok') {
        if (this.finish(item, 'sent') && typeof ticket.id === 'string') {
          this.db
            .prepare(
              'INSERT OR IGNORE INTO native_push_receipts (ticket_id, token, at) VALUES (?, ?, ?)',
            )
            .run(ticket.id, item.token, this.now());
        }
        return;
      }
      const code = ticket?.details?.error;
      if (code === 'DeviceNotRegistered') return this.forget(item.token);
      if (ticket !== undefined && code !== 'MessageRateExceeded') {
        if (code === 'InvalidCredentials' || code === 'MismatchSenderId') {
          this.warn('The Expo push service refused the app credentials', code);
        }
        this.finish(item, 'dropped');
        return;
      }
      // No answer, a rate limit or a server error: try again a few times.
      const key = keyOf(item);
      const attempts = (this.cooling.get(key)?.attempts ?? 0) + 1;
      if (attempts >= this.maxAttempts) {
        this.finish(item, 'dropped');
        return;
      }
      this.cooling.set(key, { attempts, notBefore: this.now() + this.retryDelayMs * attempts });
    });
  }

  /** Asks for the receipts of sends old enough to have one, and forgets the devices that are gone. */
  private async checkReceipts(): Promise<void> {
    const at = this.now();
    this.db.prepare('DELETE FROM native_push_receipts WHERE at < ?').run(at - DAY_MS);
    const rows = this.db
      .prepare(
        'SELECT ticket_id, token FROM native_push_receipts WHERE at <= ? ORDER BY at LIMIT ?',
      )
      .all(at - this.receiptDelayMs, RECEIPT_BATCH) as unknown as Array<{
      ticket_id: string;
      token: string;
    }>;
    if (rows.length === 0 || this.closed) return;
    let receipts: Record<string, ExpoReceipt>;
    try {
      receipts = await this.transport.receipts(
        rows.map((row) => row.ticket_id),
        AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.timeoutMs)]),
      );
    } catch (error) {
      if (!this.closed) this.warn('The Expo push receipts could not be read', errorName(error));
      return;
    }
    for (const row of rows) {
      const receipt = receipts[row.ticket_id];
      if (receipt === undefined) continue;
      this.db.prepare('DELETE FROM native_push_receipts WHERE ticket_id = ?').run(row.ticket_id);
      if (receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
        this.forget(row.token);
      }
    }
  }

  /** Records the message for the device, unless the device moved meanwhile. True when recorded. */
  private finish(item: Pending, state: 'sent' | 'dropped' | 'revoked'): boolean {
    this.cooling.delete(keyOf(item));
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO native_push_deliveries (token, ref, state, at)
         SELECT ?, ?, ?, ? WHERE EXISTS
           (SELECT 1 FROM native_push_tokens WHERE token = ? AND invite_id = ?)`,
      )
      .run(item.token, item.ref, state, this.now(), item.token, item.inviteId);
    return Number(result.changes) > 0;
  }

  /** The device is gone (the service says so, or its invite removed it): its records go, whoever holds it. */
  private forget(token: string): void {
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM native_push_tokens WHERE token = ?').run(token);
      this.db.prepare('DELETE FROM native_push_deliveries WHERE token = ?').run(token);
      this.db.prepare('DELETE FROM native_push_receipts WHERE token = ?').run(token);
    });
    this.uncool(token);
  }

  private uncool(token: string): void {
    for (const key of [...this.cooling.keys()]) {
      if (key.startsWith(`${token}\n`)) this.cooling.delete(key);
    }
  }

  /** Wakes the pump for the earliest retry, or the next receipt. */
  private schedule(): void {
    clearTimeout(this.timer);
    if (this.closed) return;
    const times = [...this.cooling.values()].map((entry) => entry.notBefore);
    const receipt = this.db.prepare('SELECT MIN(at) AS at FROM native_push_receipts').get() as {
      at: number | null;
    };
    if (receipt.at !== null) times.push(receipt.at + this.receiptDelayMs);
    if (times.length === 0) return;
    this.timer = setTimeout(() => this.kick(), Math.max(0, Math.min(...times) - this.now()));
    this.timer.unref();
  }
}

interface Row {
  token: string;
  invite_id: string;
  id: string;
  conversation_id: string;
  detail: string;
}

function toPending(row: Row, kind: 'task' | 'item'): Pending {
  return {
    token: row.token,
    inviteId: row.invite_id,
    ref: `${kind}:${row.id}`,
    conversationId: row.conversation_id,
    kind,
    id: row.id,
    detail: row.detail,
  };
}

function keyOf(item: { token: string; ref: string }): string {
  return `${item.token}\n${item.ref}`;
}

/** Never the error's text: it may quote a request that carried the access token. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * HTTPS to the Expo push service, at its fixed address. The access token, when there is one, goes
 * in the `Authorization` header and nowhere else. The answer is read to at most 1 MiB.
 */
export function expoHttpsTransport(accessToken?: string): ExpoTransport {
  const post = async (url: string, body: unknown, signal: AbortSignal): Promise<unknown> => {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok)
      throw Object.assign(new Error('expo push error'), { name: `HTTP${response.status}` });
    if (text.length > 1024 * 1024) throw new Error('expo push answer too large');
    return JSON.parse(text) as unknown;
  };
  return {
    async send(list, signal) {
      const answer = (await post(EXPO_PUSH_URL, list, signal)) as { data?: unknown };
      if (!Array.isArray(answer.data) || answer.data.length !== list.length) {
        throw new Error('expo push answer has no tickets');
      }
      return answer.data as ExpoTicket[];
    },
    async receipts(ids, signal) {
      const answer = (await post(EXPO_RECEIPTS_URL, { ids }, signal)) as { data?: unknown };
      if (typeof answer.data !== 'object' || answer.data === null) {
        throw new Error('expo push answer has no receipts');
      }
      return answer.data as Record<string, ExpoReceipt>;
    },
  };
}
