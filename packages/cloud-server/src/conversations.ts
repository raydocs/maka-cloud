import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { IssuedSession } from '@maka-cloud/orchestrator';
import { transaction } from './db.js';
import { appendFeed, type FeedHub } from './feed.js';

export interface ConversationInfo {
  conversationId: string;
  title: string | null;
  createdAt: number;
}

export const MAX_TITLE_LENGTH = 200;
export const MAX_MESSAGE_BYTES = 32_000;

export type PostResult =
  | { found: false }
  | { found: true; messageId: string; duplicate: boolean; text: string; sessionId: string };

/** Conversations and their messages. Rows are only ever added. */
export class ConversationStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly hub: FeedHub,
    private readonly issueSession: () => IssuedSession,
    private readonly now: () => number = Date.now,
  ) {}

  create(title?: string): ConversationInfo {
    const conversationId = `cnv_${randomUUID().replaceAll('-', '')}`;
    const createdAt = this.now();
    transaction(this.db, () => {
      // The conversation's orchestrator session is stored by the session store,
      // inside this same transaction.
      const session = this.issueSession();
      const n = (
        this.db.prepare('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM conversations').get() as {
          n: number;
        }
      ).n;
      this.db
        .prepare(
          'INSERT INTO conversations (conversation_id, n, title, session_id, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(conversationId, n, title ?? null, session.sessionId, createdAt);
      appendFeed(this.db, 'conversation.created', conversationId, conversationId, createdAt);
    });
    this.hub.notify();
    return { conversationId, title: title ?? null, createdAt };
  }

  list(): ConversationInfo[] {
    const rows = this.db
      .prepare('SELECT conversation_id, title, created_at FROM conversations ORDER BY n')
      .all() as unknown as Array<{
      conversation_id: string;
      title: string | null;
      created_at: number;
    }>;
    return rows.map((row) => ({
      conversationId: row.conversation_id,
      title: row.title,
      createdAt: row.created_at,
    }));
  }

  /** The orchestrator session id the conversation's tasks hang off. Never sent to clients. */
  sessionOf(conversationId: string): string | undefined {
    const row = this.db
      .prepare('SELECT session_id FROM conversations WHERE conversation_id = ?')
      .get(conversationId) as { session_id: string } | undefined;
    return row?.session_id;
  }

  /** The conversation a session belongs to, if it belongs to one. */
  conversationOf(sessionId: string): string | undefined {
    const row = this.db
      .prepare('SELECT conversation_id FROM conversations WHERE session_id = ?')
      .get(sessionId) as { conversation_id: string } | undefined;
    return row?.conversation_id;
  }

  exists(conversationId: string): boolean {
    return this.sessionOf(conversationId) !== undefined;
  }

  post(conversationId: string, text: string, clientMessageId?: string): PostResult {
    const at = this.now();
    const result = transaction(this.db, (): PostResult => {
      const sessionId = this.sessionOf(conversationId);
      if (sessionId === undefined) return { found: false };
      if (clientMessageId !== undefined) {
        const earlier = this.db
          .prepare(
            'SELECT message_id, text FROM messages WHERE conversation_id = ? AND client_message_id = ?',
          )
          .get(conversationId, clientMessageId) as { message_id: string; text: string } | undefined;
        if (earlier) {
          return {
            found: true,
            messageId: earlier.message_id,
            duplicate: true,
            text: earlier.text,
            sessionId,
          };
        }
      }
      const messageId = `msg_${randomUUID().replaceAll('-', '')}`;
      const n = (
        this.db.prepare('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM messages').get() as {
          n: number;
        }
      ).n;
      this.db
        .prepare(
          `INSERT INTO messages (n, message_id, conversation_id, role, text, client_message_id, at)
           VALUES (?, ?, ?, 'user', ?, ?, ?)`,
        )
        .run(n, messageId, conversationId, text, clientMessageId ?? null, at);
      appendFeed(this.db, 'message.posted', conversationId, messageId, at);
      return { found: true, messageId, duplicate: false, text, sessionId };
    });
    if (result.found && !result.duplicate) this.hub.notify();
    return result;
  }
}
