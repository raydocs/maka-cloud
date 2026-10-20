import { createECDH } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import webpush from 'web-push';
import { transaction } from './db.js';
import type { FeedHub } from './feed.js';
import { createHttpsTransport, type PushTransport } from './push-transport.js';

/** Push services browsers are known to hand out; `allowedHosts` replaces this list. */
export const DEFAULT_PUSH_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  '*.push.services.mozilla.com',
  '*.push.apple.com',
  '*.notify.windows.com',
];

const MAX_ENDPOINT_LENGTH = 2048;
const SUBSCRIPTIONS_PER_INVITE = 10;
const SUBSCRIPTIONS_TOTAL = 1000;
const MAX_COOLING = 1000;
const TTL_SECONDS = 24 * 60 * 60;

export interface PushConfig {
  /** VAPID public key, URL-safe base64. */
  publicKey: string;
  /** VAPID private key. Held in memory only: never logged, never stored. */
  privateKey: string;
  /** `mailto:` or `https:` contact for the push services. */
  subject: string;
  /** Hostnames subscriptions may point at: exact, or `*.suffix`. */
  allowedHosts?: string[];
}

export interface PushOptions {
  config: PushConfig;
  /** Default: HTTPS with connect-time address checks. Tests pass a fake. */
  transport?: PushTransport;
  now?: () => number;
  /** Wait before the next attempt is `retryDelayMs` times the attempts so far. */
  retryDelayMs?: number;
  /** Attempts per subscription and task before the message is dropped. */
  maxAttempts?: number;
  /** Sends in flight at once. */
  concurrency?: number;
  timeoutMs?: number;
  onWarning?: (message: string, detail?: unknown) => void;
}

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type RegisterResult = 'created' | 'updated' | 'invalid_endpoint' | 'invalid_keys' | 'limit';

export type PushApi = Pick<PushService, 'publicKey' | 'register' | 'remove'>;

/**
 * Reads the push settings from the environment: `CLOUD_PUSH_VAPID_PUBLIC`,
 * `CLOUD_PUSH_VAPID_PRIVATE`, `CLOUD_PUSH_SUBJECT` and optionally
 * `CLOUD_PUSH_ALLOWED_HOSTS` (comma separated). None set means push is off; a
 * partial set is an error that names the missing variable and nothing else.
 */
export function pushConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PushConfig | undefined {
  const names = ['CLOUD_PUSH_VAPID_PUBLIC', 'CLOUD_PUSH_VAPID_PRIVATE', 'CLOUD_PUSH_SUBJECT'];
  const [publicKey, privateKey, subject] = names.map((name) => env[name]?.trim() || undefined);
  if (publicKey === undefined && privateKey === undefined && subject === undefined)
    return undefined;
  const missing = names.filter((_, i) => [publicKey, privateKey, subject][i] === undefined);
  if (missing.length > 0 || !publicKey || !privateKey || !subject) {
    throw new Error(`Web Push needs ${missing.join(', ')} too`);
  }
  const hosts = env.CLOUD_PUSH_ALLOWED_HOSTS?.split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== '');
  return { publicKey, privateKey, subject, ...(hosts?.length ? { allowedHosts: hosts } : {}) };
}

/** The endpoint as a URL when it is a plain https push-service address, otherwise nothing. */
export function parsePushEndpoint(endpoint: string, allowedHosts: string[]): URL | undefined {
  if (endpoint.length > MAX_ENDPOINT_LENGTH || !/^https:\/\//iu.test(endpoint)) return undefined;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (url.username !== '' || url.password !== '' || (url.port !== '' && url.port !== '443')) {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const allowed = allowedHosts.some((pattern) =>
    pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern,
  );
  return allowed ? url : undefined;
}

interface Pending {
  endpoint: string;
  /** The invite that owned the subscription and the conversation when the row was read. */
  inviteId: string;
  /** The endpoint's generation when the row was read; a delete, move or re-create changes it. */
  generation: number;
  p256dh: string;
  auth: string;
  taskId: string;
  conversationId: string | null;
  type: string;
}

const STATE_OF: Record<string, string> = {
  task_succeeded: 'succeeded',
  task_failed: 'failed',
  task_cancelled: 'cancelled',
};

const PENDING_SQL = `
SELECT s.endpoint, s.invite_id, s.p256dh, s.auth, t.task_id, f.conversation_id,
  json_extract(t.event, '$.type') AS type
FROM feed f
JOIN task_log t ON t.seq = CAST(f.ref AS INTEGER)
JOIN task_index i ON i.task_id = t.task_id AND i.parent_task_id IS NULL
JOIN conversations c ON c.conversation_id = f.conversation_id
JOIN push_subscriptions s ON f.id > s.since_feed_id AND s.invite_id = c.owner
LEFT JOIN push_deliveries d ON d.endpoint = s.endpoint AND d.task_id = t.task_id
WHERE f.kind = 'task.event' AND f.id > ?
  AND json_extract(t.event, '$.type') IN ('task_succeeded', 'task_failed', 'task_cancelled')
  AND d.task_id IS NULL
ORDER BY f.id, s.endpoint
LIMIT ?`;

/**
 * Tells a device when a top-level task of a conversation its invite owns ends; a
 * conversation nobody owns, or another invite owns, never reaches it. What
 * still has to be sent is derived from the database: a terminal event of a
 * top-level task that came after the subscription and has no `push_deliveries` row. So
 * a restart sends what was missed, and nothing is sent twice. The payload names
 * the task and its state and nothing the task or a model wrote.
 */
export class PushService {
  readonly publicKey: string;
  private readonly allowedHosts: string[];
  private readonly transport: PushTransport;
  private readonly closeTransport: () => void;
  private readonly abort = new AbortController();
  private readonly cooling = new Map<string, { attempts: number; notBefore: number }>();
  private readonly now: () => number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private floor = 0;
  private dirty = false;
  private running: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;
  private offRevoke: (() => void) | undefined;
  /** Sends under way, so a revoke, delete or move can cut them off. */
  private readonly inflight = new Map<string, { inviteId: string; controller: AbortController }>();
  /**
   * Endpoints whose subscription was deleted, moved or created while a pass was
   * under way. A queue item or a send belongs to the generation its endpoint had when it
   * was read, so it cannot outlive the subscription it was read for. Nothing needs to
   * outlive a pass, so the table is emptied when one ends.
   */
  private readonly generations = new Map<string, number>();
  private lastGeneration = 0;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly hub: FeedHub,
    private readonly invites: {
      active(inviteId: string): boolean;
      onRevoke?(listener: (inviteId: string) => void): () => void;
    },
    private readonly options: PushOptions,
  ) {
    const { config } = options;
    this.publicKey = config.publicKey;
    this.allowedHosts = (config.allowedHosts ?? DEFAULT_PUSH_HOSTS).map((host) =>
      host.toLowerCase(),
    );
    this.now = options.now ?? Date.now;
    this.retryDelayMs = options.retryDelayMs ?? 5_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.concurrency = options.concurrency ?? 4;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (options.transport) {
      this.transport = options.transport;
      this.closeTransport = () => undefined;
    } else {
      const https = createHttpsTransport();
      this.transport = https;
      this.closeTransport = () => https.close();
    }
    checkConfig(config);
  }

  register(inviteId: string, input: PushSubscriptionInput): RegisterResult {
    if (!parsePushEndpoint(input.endpoint, this.allowedHosts)) return 'invalid_endpoint';
    if (!validKeys(input.p256dh, input.auth)) return 'invalid_keys';
    const at = this.now();
    return transaction(this.db, (): RegisterResult => {
      const existing = this.db
        .prepare('SELECT invite_id FROM push_subscriptions WHERE endpoint = ?')
        .get(input.endpoint) as { invite_id: string } | undefined;
      if (existing && existing.invite_id === inviteId) {
        this.db
          .prepare('UPDATE push_subscriptions SET p256dh = ?, auth = ? WHERE endpoint = ?')
          .run(input.p256dh, input.auth, input.endpoint);
        return 'updated';
      }
      if (existing) {
        // The device now belongs to another invite: it starts afresh, owed nothing from before.
        const { id } = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM feed').get() as {
          id: number;
        };
        this.db
          .prepare(
            'UPDATE push_subscriptions SET invite_id = ?, p256dh = ?, auth = ?, since_feed_id = ?, created_at = ? WHERE endpoint = ?',
          )
          .run(inviteId, input.p256dh, input.auth, id, at, input.endpoint);
        this.db.prepare('DELETE FROM push_deliveries WHERE endpoint = ?').run(input.endpoint);
        this.invalidate(input.endpoint);
        return 'updated';
      }
      const count = (sql: string, ...args: string[]) =>
        (this.db.prepare(sql).get(...args) as { n: number }).n;
      if (
        count('SELECT COUNT(*) AS n FROM push_subscriptions WHERE invite_id = ?', inviteId) >=
          SUBSCRIPTIONS_PER_INVITE ||
        count('SELECT COUNT(*) AS n FROM push_subscriptions') >= SUBSCRIPTIONS_TOTAL
      ) {
        return 'limit';
      }
      const { id } = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM feed').get() as {
        id: number;
      };
      this.db
        .prepare(
          'INSERT INTO push_subscriptions (endpoint, invite_id, p256dh, auth, since_feed_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(input.endpoint, inviteId, input.p256dh, input.auth, id, at);
      this.invalidate(input.endpoint);
      return 'created';
    });
  }

  /** Removes a subscription its own invite registered. */
  remove(inviteId: string, endpoint: string): boolean {
    const result = this.db
      .prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND invite_id = ?')
      .run(endpoint, inviteId);
    const removed = Number(result.changes) > 0;
    if (removed) this.invalidate(endpoint);
    return removed;
  }

  /** Starts watching the feed and sends what a previous run left undone. */
  start(): void {
    if (this.closed || this.unsubscribe) return;
    this.unsubscribe = this.hub.subscribe(() => this.kick());
    this.offRevoke = this.invites.onRevoke?.((inviteId) => this.revokeInvite(inviteId));
    this.kick();
  }

  /** Stops watching, aborts sends in flight and waits for them to settle. */
  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    this.offRevoke?.();
    clearTimeout(this.timer);
    this.abort.abort();
    try {
      await this.running;
    } finally {
      this.closeTransport();
    }
  }

  private kick(): void {
    this.dirty = true;
    if (this.running || this.closed) return;
    this.running = this.pump().finally(() => {
      this.running = undefined;
      if (this.dirty && !this.closed) this.kick();
    });
  }

  private warn(message: string, detail?: unknown): void {
    this.options.onWarning?.(message, detail);
  }

  private async pump(): Promise<void> {
    try {
      while (this.dirty && !this.closed) {
        this.dirty = false;
        await this.pass();
      }
    } catch (error) {
      // The next commit tries again; nothing here may take the server down.
      this.warn('Push delivery pass failed', error);
    }
  }

  private async pass(): Promise<void> {
    try {
      await this.passOnce();
    } finally {
      this.generations.clear();
    }
  }

  private async passOnce(): Promise<void> {
    const { id: mark } = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM feed').get() as {
      id: number;
    };
    const batch = this.pending(100 + this.cooling.size);
    const due = batch.filter(
      (item) => (this.cooling.get(keyOf(item))?.notBefore ?? 0) <= this.now(),
    );
    for (let i = 0; i < due.length && !this.closed; i += this.concurrency) {
      await Promise.all(due.slice(i, i + this.concurrency).map((item) => this.deliver(item)));
    }
    if (batch.length === 0 && this.cooling.size === 0) this.floor = Math.max(this.floor, mark);
    if (batch.length > due.length || due.length === 100) this.dirty = true;
    this.schedule();
  }

  private pending(limit: number): Pending[] {
    const rows = this.db.prepare(PENDING_SQL).all(this.floor, limit) as unknown as Array<{
      endpoint: string;
      invite_id: string;
      p256dh: string;
      auth: string;
      task_id: string;
      conversation_id: string | null;
      type: string;
    }>;
    return rows.map((row) => ({
      endpoint: row.endpoint,
      inviteId: row.invite_id,
      generation: this.generations.get(row.endpoint) ?? 0,
      p256dh: row.p256dh,
      auth: row.auth,
      taskId: row.task_id,
      conversationId: row.conversation_id,
      type: row.type,
    }));
  }

  /** Wakes the pump for the earliest retry. */
  private schedule(): void {
    clearTimeout(this.timer);
    if (this.closed || this.cooling.size === 0) return;
    const next = Math.min(...[...this.cooling.values()].map((entry) => entry.notBefore));
    this.timer = setTimeout(() => this.kick(), Math.max(0, next - this.now()));
    this.timer.unref();
  }

  private async deliver(item: Pending): Promise<void> {
    const key = keyOf(item);
    if (this.generationOf(item.endpoint) !== item.generation) return;
    // The owner is read again here: the device may have moved since the batch was read.
    const current = this.db
      .prepare(
        `SELECT s.invite_id, s.p256dh, s.auth, c.owner
         FROM push_subscriptions s, conversations c
         WHERE s.endpoint = ? AND c.conversation_id = ?`,
      )
      .get(item.endpoint, item.conversationId) as
      | { invite_id: string; p256dh: string; auth: string; owner: string | null }
      | undefined;
    if (!current) return;
    const { invite_id: inviteId } = current;
    if (inviteId !== item.inviteId || current.owner !== inviteId) return;
    if (!this.invites.active(inviteId)) return this.finish(item, 'revoked');
    let request: ReturnType<typeof webpush.generateRequestDetails>;
    try {
      request = webpush.generateRequestDetails(
        { endpoint: item.endpoint, keys: { p256dh: current.p256dh, auth: current.auth } },
        JSON.stringify({
          type: 'task.finished',
          conversationId: item.conversationId,
          taskId: item.taskId,
          state: STATE_OF[item.type] ?? item.type,
        }),
        { vapidDetails: this.vapid(), TTL: TTL_SECONDS, urgency: 'normal' },
      );
    } catch {
      // Keys that cannot encrypt will not start to work: forget the subscription.
      return this.forget(item.endpoint);
    }
    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [name, String(value)]),
    );
    let status: number | undefined;
    const controller = new AbortController();
    this.inflight.set(key, { inviteId, controller });
    try {
      const signal = AbortSignal.any([
        this.abort.signal,
        controller.signal,
        AbortSignal.timeout(this.timeoutMs),
      ]);
      status = (
        await this.transport(
          { endpoint: item.endpoint, headers, body: request.body ?? Buffer.alloc(0) },
          signal,
        )
      ).status;
    } catch {
      if (this.closed) return;
    } finally {
      this.inflight.delete(key);
    }
    // A revoke, delete or move while the send was out: it is no longer this invite's to record.
    if (this.generationOf(item.endpoint) !== item.generation) return;
    if (!this.subscribed(item.endpoint, inviteId)) return;
    if (status !== undefined && status >= 200 && status < 300) return this.finish(item, 'sent');
    if (status === 404 || status === 410) return this.forget(item.endpoint);
    if (status !== undefined && status !== 429 && status < 500) return this.finish(item, 'dropped');
    // Server error, rate limit, timeout or network failure: try again a few times.
    const attempts = (this.cooling.get(key)?.attempts ?? 0) + 1;
    if (attempts >= this.maxAttempts) return this.finish(item, 'dropped');
    this.cooling.delete(key);
    this.cooling.set(key, { attempts, notBefore: this.now() + this.retryDelayMs * attempts });
    if (this.cooling.size > MAX_COOLING) {
      const oldest = this.cooling.keys().next().value;
      if (oldest !== undefined) {
        this.cooling.delete(oldest);
        this.warn('Push retry table is full; the oldest message was dropped');
      }
    }
  }

  private finish(item: Pending, state: 'sent' | 'dropped' | 'revoked'): void {
    this.cooling.delete(keyOf(item));
    this.db
      .prepare(
        'INSERT OR IGNORE INTO push_deliveries (endpoint, task_id, state, at) VALUES (?, ?, ?, ?)',
      )
      .run(item.endpoint, item.taskId, state, this.now());
  }

  private subscribed(endpoint: string, inviteId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND invite_id = ?')
        .get(endpoint, inviteId) !== undefined
    );
  }

  private generationOf(endpoint: string): number {
    return this.generations.get(endpoint) ?? 0;
  }

  /**
   * The endpoint's subscription is gone, moved or new: what was queued, waiting to
   * be retried or in flight for the one before is dropped, whoever held it.
   */
  private invalidate(endpoint: string): void {
    if (this.running) this.generations.set(endpoint, ++this.lastGeneration);
    for (const key of [...this.cooling.keys()]) {
      if (key.startsWith(`${endpoint}\n`)) this.cooling.delete(key);
    }
    for (const [key, entry] of this.inflight) {
      if (key.startsWith(`${endpoint}\n`)) entry.controller.abort();
    }
  }

  /** The invite is revoked: its devices are forgotten and sends to them are cut off. */
  private revokeInvite(inviteId: string): void {
    const endpoints = (
      this.db
        .prepare('SELECT endpoint FROM push_subscriptions WHERE invite_id = ?')
        .all(inviteId) as unknown as Array<{ endpoint: string }>
    ).map((row) => row.endpoint);
    for (const endpoint of endpoints) this.forget(endpoint);
    for (const entry of this.inflight.values()) {
      if (entry.inviteId === inviteId) entry.controller.abort();
    }
  }

  private forget(endpoint: string): void {
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
      this.db.prepare('DELETE FROM push_deliveries WHERE endpoint = ?').run(endpoint);
    });
    this.invalidate(endpoint);
  }

  private vapid() {
    const { subject, publicKey, privateKey } = this.options.config;
    return { subject, publicKey, privateKey };
  }
}

function keyOf(item: { endpoint: string; taskId: string }): string {
  return `${item.endpoint}\n${item.taskId}`;
}

function validKeys(p256dh: string, auth: string): boolean {
  const key = Buffer.from(p256dh, 'base64url');
  return key.length === 65 && key[0] === 4 && Buffer.from(auth, 'base64url').length === 16;
}

/** Fails at startup, with no key in the message, if the VAPID settings cannot sign a request. */
function checkConfig(config: PushConfig): void {
  try {
    const device = createECDH('prime256v1');
    device.generateKeys();
    webpush.generateRequestDetails(
      {
        endpoint: 'https://fcm.googleapis.com/fcm/send/check',
        keys: {
          p256dh: device.getPublicKey().toString('base64url'),
          auth: Buffer.alloc(16, 1).toString('base64url'),
        },
      },
      '{}',
      {
        vapidDetails: {
          subject: config.subject,
          publicKey: config.publicKey,
          privateKey: config.privateKey,
        },
      },
    );
  } catch {
    throw new Error('The Web Push (VAPID) settings are not valid');
  }
}
