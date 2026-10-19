import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db.js';
import { appendFeed, type FeedHub } from './feed.js';

export type ExtensionKind = 'inbox.item' | 'inbox.digest';

/** What a component inside the server process puts into the feed. */
export interface ExtensionEvent {
  kind: ExtensionKind;
  /** The conversation the event belongs to, or null for one that belongs to none. */
  conversationId: string | null;
  /** Anything that survives `JSON.stringify`; clients receive it as the event's data. */
  data: unknown;
}

export const MAX_EXTENSION_DATA_BYTES = 256 * 1024;

/** Writes extension events into the database and the feed, one transaction per event. */
export class ExtensionFeed {
  constructor(
    private readonly db: DatabaseSync,
    private readonly hub: FeedHub,
    private readonly now: () => number = Date.now,
  ) {}

  /** Appends the event and returns its feed position. Throws for data that cannot be stored or an unknown conversation. */
  publish(event: ExtensionEvent): number {
    const data = JSON.stringify(event.data);
    if (data === undefined || Buffer.byteLength(data) > MAX_EXTENSION_DATA_BYTES) {
      throw new Error('The event data is missing or too large');
    }
    const at = this.now();
    const feedId = transaction(this.db, () => {
      if (
        event.conversationId !== null &&
        !this.db
          .prepare('SELECT 1 FROM conversations WHERE conversation_id = ?')
          .get(event.conversationId)
      ) {
        throw new Error('The event names an unknown conversation');
      }
      const { lastInsertRowid } = this.db
        .prepare(
          'INSERT INTO extension_events (conversation_id, kind, data, at) VALUES (?, ?, ?, ?)',
        )
        .run(event.conversationId, event.kind, data, at);
      return appendFeed(this.db, event.kind, event.conversationId, Number(lastInsertRowid), at);
    });
    this.hub.notify();
    return feedId;
  }
}
