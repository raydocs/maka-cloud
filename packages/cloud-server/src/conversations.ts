import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { IssuedSession } from '@maka-cloud/orchestrator';
import { z } from 'zod';
import { transaction } from './db.js';
import { appendFeed, type FeedHub } from './feed.js';

export interface ConversationInfo {
  conversationId: string;
  title: string | null;
  createdAt: number;
}

export const MAX_TITLE_LENGTH = 200;
export const MAX_MESSAGE_BYTES = 32_000;

/**
 * What an in-process caller (a standing duty) attaches to a message. `external`: the text comes
 * from outside the owner. `run`: the limits of the run the message starts.
 */
export const MessageMetaSchema = z
  .object({
    external: z.boolean(),
    run: z
      .object({
        dutyId: z.string().min(1).max(100),
        authority: z.enum(['read-only', 'open-pr', 'merge-when-green']),
        budgetUsd: z.number().positive().max(1000),
      })
      .strict()
      .optional(),
  })
  .strict();
export type MessageMeta = z.infer<typeof MessageMetaSchema>;

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

  /** `owner` is the invite id of the caller; everything in the conversation belongs to it. */
  create(owner: string, title?: string, startKey?: string): ConversationInfo {
    const conversationId = `cnv_${randomUUID().replaceAll('-', '')}`;
    const createdAt = this.now();
    // Keys are per owner, so one invite's key can never find or block another's.
    const key = startKey === undefined ? undefined : `${owner}\u0000${startKey}`;
    const earlier = transaction(this.db, (): ConversationInfo | undefined => {
      // A start with a key that was used before returns that conversation: a retry makes none.
      if (key !== undefined) {
        const row = this.db
          .prepare(
            `SELECT c.conversation_id, c.title, c.created_at FROM system_starts s
             JOIN conversations c ON c.conversation_id = s.conversation_id
             WHERE s.start_key = ? AND c.owner = ?`,
          )
          .get(key, owner) as
          | { conversation_id: string; title: string | null; created_at: number }
          | undefined;
        if (row) {
          return {
            conversationId: row.conversation_id,
            title: row.title,
            createdAt: row.created_at,
          };
        }
      }
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
          'INSERT INTO conversations (conversation_id, n, title, session_id, created_at, owner) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(conversationId, n, title ?? null, session.sessionId, createdAt, owner);
      if (key !== undefined) {
        this.db
          .prepare('INSERT INTO system_starts (start_key, conversation_id) VALUES (?, ?)')
          .run(key, conversationId);
      }
      appendFeed(this.db, 'conversation.created', conversationId, conversationId, createdAt);
      return undefined;
    });
    if (earlier) return earlier;
    this.hub.notify();
    return { conversationId, title: title ?? null, createdAt };
  }

  /**
   * The conversation `owner` started with `startKey`, once its first message (posted under the
   * same key, with its run meta) is stored. A conversation made but never posted to, as after a
   * crash between the two commits of a start, is not a started one. Reads only.
   */
  startedBy(owner: string, startKey: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT s.conversation_id FROM system_starts s
         JOIN conversations c ON c.conversation_id = s.conversation_id
         JOIN messages m ON m.conversation_id = c.conversation_id AND m.client_message_id = ?
         WHERE s.start_key = ? AND c.owner = ?`,
      )
      .get(startKey, `${owner}\u0000${startKey}`, owner) as { conversation_id: string } | undefined;
    return row?.conversation_id;
  }

  /** The conversations of one owner, oldest first. */
  list(owner: string): ConversationInfo[] {
    const rows = this.db
      .prepare(
        'SELECT conversation_id, title, created_at FROM conversations WHERE owner = ? ORDER BY n',
      )
      .all(owner) as unknown as Array<{
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

  /** The invite that owns the conversation; undefined for an unknown or unowned one. */
  ownerOf(conversationId: string): string | undefined {
    const row = this.db
      .prepare('SELECT owner FROM conversations WHERE conversation_id = ?')
      .get(conversationId) as { owner: string | null } | undefined;
    return row?.owner ?? undefined;
  }

  /** Whether `owner` owns the conversation. False for an unknown or unowned one. */
  owns(owner: string, conversationId: string): boolean {
    return this.ownerOf(conversationId) === owner;
  }

  /** The ids of an owner's conversations. */
  idsOf(owner: string): string[] {
    const rows = this.db
      .prepare('SELECT conversation_id FROM conversations WHERE owner = ? ORDER BY n')
      .all(owner) as unknown as Array<{ conversation_id: string }>;
    return rows.map((row) => row.conversation_id);
  }

  /** Gives every unowned conversation to `owner`. For the command line, with the server stopped. */
  adoptUnowned(owner: string): number {
    const result = this.db
      .prepare('UPDATE conversations SET owner = ? WHERE owner IS NULL')
      .run(owner);
    return Number(result.changes);
  }

  post(
    conversationId: string,
    text: string,
    clientMessageId?: string,
    meta?: MessageMeta,
  ): PostResult {
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
      if (meta !== undefined) {
        this.db
          .prepare('INSERT INTO message_meta (message_id, external, run) VALUES (?, ?, ?)')
          .run(
            messageId,
            meta.external ? 1 : 0,
            meta.run === undefined ? null : JSON.stringify(meta.run),
          );
      }
      // Committed with the message, so a crash before the handler acks leaves it to retry.
      this.db
        .prepare(
          'INSERT INTO message_deliveries (message_id, conversation_id, next_attempt_at) VALUES (?, ?, ?)',
        )
        .run(messageId, conversationId, at);
      return { found: true, messageId, duplicate: false, text, sessionId };
    });
    if (result.found && !result.duplicate) this.hub.notify();
    return result;
  }
}
