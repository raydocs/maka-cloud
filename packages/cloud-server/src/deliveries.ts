import type { DatabaseSync } from 'node:sqlite';

export interface PendingMessage {
  conversationId: string;
  messageId: string;
  text: string;
  sessionId: string;
}

export interface DeliveryOptions {
  /** The first retry waits this long; each later one twice as long as the one before. */
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface DeliveryStats {
  /** Messages the handler has not acknowledged yet. */
  pending: number;
  /** Attempts waiting for the handler. */
  inFlight: number;
  /** Whether a retry timer is set. */
  timerArmed: boolean;
}

interface PendingRow {
  message_id: string;
  conversation_id: string;
  attempts: number;
  text: string;
  session_id: string;
}

/**
 * Hands user messages to the conversation handler at least once. The message
 * and its delivery row are committed together (`ConversationStore.post`); the
 * row is marked delivered only when the handler's promise resolves. A failed
 * attempt is retried with a growing delay, and whatever is pending at start is
 * tried again, so a crash between the commit and the handler loses nothing.
 * One attempt per message runs at a time; the handler dedupes by `messageId`
 * (the conductor admits each message id once), so a delivery that reached it
 * just before a crash is harmless when it comes again.
 */
export class MessageDeliveries {
  private readonly inFlight = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(
    private readonly db: DatabaseSync,
    private readonly target: (message: PendingMessage) => void | Promise<void>,
    private readonly warn: (message: string, detail?: unknown) => void,
    options: DeliveryOptions = {},
    private readonly now: () => number = Date.now,
  ) {
    this.retryBaseMs = options.retryBaseMs ?? 1000;
    this.retryMaxMs = options.retryMaxMs ?? 60_000;
  }

  /** Tries every pending message now, oldest first, whatever its retry time: for the start of a process. */
  start(): void {
    const rows = this.db
      .prepare(
        `SELECT d.message_id FROM message_deliveries d JOIN messages m ON m.message_id = d.message_id
         WHERE d.delivered_at IS NULL ORDER BY m.n`,
      )
      .all() as unknown as Array<{ message_id: string }>;
    for (const row of rows) this.attempt(row.message_id);
    this.arm();
  }

  /** Tries one message now unless it was delivered or an attempt is already running. */
  kick(messageId: string): void {
    this.attempt(messageId);
  }

  /** No attempt starts after this. Attempts already running finish on their own and are not retried. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Resolves when the attempts running now have settled. */
  async settled(): Promise<void> {
    await Promise.all([...this.inFlight.values()]);
  }

  stats(): DeliveryStats {
    const { count } = this.db
      .prepare('SELECT COUNT(*) AS count FROM message_deliveries WHERE delivered_at IS NULL')
      .get() as { count: number };
    return { pending: count, inFlight: this.inFlight.size, timerArmed: this.timer !== undefined };
  }

  private attempt(messageId: string): void {
    if (this.stopped || this.inFlight.has(messageId)) return;
    const row = this.db
      .prepare(
        `SELECT d.message_id, d.conversation_id, d.attempts, m.text, c.session_id
         FROM message_deliveries d
         JOIN messages m ON m.message_id = d.message_id
         JOIN conversations c ON c.conversation_id = d.conversation_id
         WHERE d.message_id = ? AND d.delivered_at IS NULL`,
      )
      .get(messageId) as unknown as PendingRow | undefined;
    if (!row) return;
    const attempts = row.attempts + 1;
    // The retry time is set before the attempt, so a crash during it leaves a row that is due.
    this.db
      .prepare(
        'UPDATE message_deliveries SET attempts = ?, next_attempt_at = ? WHERE message_id = ?',
      )
      .run(attempts, this.now() + this.backoff(attempts), messageId);
    const run = (async () => {
      let failed = false;
      try {
        await this.target({
          conversationId: row.conversation_id,
          messageId: row.message_id,
          text: row.text,
          sessionId: row.session_id,
        });
        // The handler acknowledged it: record that even when stopping, so it is not sent again.
        if (this.db.isOpen) {
          this.db
            .prepare(
              'UPDATE message_deliveries SET delivered_at = ? WHERE message_id = ? AND delivered_at IS NULL',
            )
            .run(this.now(), messageId);
        }
      } catch (error) {
        failed = true;
        if (!this.stopped) this.warn('The conversation handler failed', error);
      } finally {
        this.inFlight.delete(messageId);
      }
      if (failed) this.arm();
    })();
    this.inFlight.set(messageId, run);
  }

  private backoff(attempts: number): number {
    return Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(attempts - 1, 20));
  }

  /** Sets the one timer for the earliest pending message that is not being attempted. */
  private arm(): void {
    if (this.stopped || !this.db.isOpen) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const rows = this.db
      .prepare(
        `SELECT message_id, next_attempt_at FROM message_deliveries
         WHERE delivered_at IS NULL ORDER BY next_attempt_at LIMIT ?`,
      )
      .all(this.inFlight.size + 1) as unknown as Array<{
      message_id: string;
      next_attempt_at: number;
    }>;
    const next = rows.find((row) => !this.inFlight.has(row.message_id));
    if (!next) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.retryDue();
      },
      Math.max(0, next.next_attempt_at - this.now()),
    );
  }

  private retryDue(): void {
    if (this.stopped || !this.db.isOpen) return;
    const due = this.db
      .prepare(
        `SELECT message_id FROM message_deliveries
         WHERE delivered_at IS NULL AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 100`,
      )
      .all(this.now()) as unknown as Array<{ message_id: string }>;
    for (const row of due) this.attempt(row.message_id);
    this.arm();
  }
}
