import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db.js';
import { appendFeed, type FeedHub, type FeedKind } from './feed.js';

export interface QuestionOptionPayload {
  id: string;
  label: string;
}

/**
 * What the conductor publishes into a conversation. `eventId` is the event's
 * stable id from the conductor's outbox: publishing the same id again is a
 * no-op, so the outbox can retry until it gets an acknowledgement.
 */
export type ConductorFeedEvent =
  | { kind: 'message'; eventId: string; conversationId: string; text: string }
  | { kind: 'notice'; eventId: string; conversationId: string; text: string }
  | {
      kind: 'question';
      eventId: string;
      conversationId: string;
      questionId: string;
      reason: 'taste' | 'budget_overrun' | 'irreversible';
      question: string;
      /** The recommended option comes first. */
      options: QuestionOptionPayload[];
      recommended: string;
    }
  | {
      kind: 'answered';
      eventId: string;
      conversationId: string;
      questionId: string;
      optionId: string;
      text?: string;
    };

export type PublishResult =
  | { published: true; duplicate: boolean; feedId: number | null }
  | { published: false; reason: 'unknown_conversation' | 'conflict' };

/** The server side of the conductor's outbox. */
export interface ConversationPublisher {
  publish(event: ConductorFeedEvent): PublishResult;
}

const FEED_KIND: Record<Exclude<ConductorFeedEvent['kind'], 'message'>, FeedKind> = {
  notice: 'conductor.notice',
  question: 'conductor.question',
  answered: 'conductor.answered',
};

/**
 * Writes conductor events into the database and the feed, one transaction per
 * event. Payloads carry only the fields named here: no runner, model or vendor
 * names are added by the server.
 */
export class ConductorFeed implements ConversationPublisher {
  constructor(
    private readonly db: DatabaseSync,
    private readonly hub: FeedHub,
    private readonly now: () => number = Date.now,
  ) {}

  publish(event: ConductorFeedEvent): PublishResult {
    const at = this.now();
    const result = transaction(this.db, (): PublishResult => {
      const earlier = this.db
        .prepare('SELECT conversation_id, kind, data FROM conductor_events WHERE event_id = ?')
        .get(event.eventId) as { conversation_id: string; kind: string; data: string } | undefined;
      const data = JSON.stringify(payloadOf(event));
      if (earlier) {
        const same =
          earlier.conversation_id === event.conversationId &&
          earlier.kind === event.kind &&
          earlier.data === data;
        return same
          ? { published: true, duplicate: true, feedId: null }
          : { published: false, reason: 'conflict' };
      }
      const known = this.db
        .prepare('SELECT 1 FROM conversations WHERE conversation_id = ?')
        .get(event.conversationId);
      if (!known) return { published: false, reason: 'unknown_conversation' };
      let ref = event.eventId;
      let kind: FeedKind;
      if (event.kind === 'message') {
        ref = `msg_${randomUUID().replaceAll('-', '')}`;
        kind = 'message.posted';
        const n = (
          this.db.prepare('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM messages').get() as {
            n: number;
          }
        ).n;
        this.db
          .prepare(
            `INSERT INTO messages (n, message_id, conversation_id, role, text, client_message_id, at)
             VALUES (?, ?, ?, 'assistant', ?, NULL, ?)`,
          )
          .run(n, ref, event.conversationId, event.text, at);
      } else {
        kind = FEED_KIND[event.kind];
      }
      this.db
        .prepare(
          'INSERT INTO conductor_events (event_id, conversation_id, kind, ref, data, at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(event.eventId, event.conversationId, event.kind, ref, data, at);
      const feedId = appendFeed(this.db, kind, event.conversationId, ref, at);
      return { published: true, duplicate: false, feedId };
    });
    if (result.published && !result.duplicate) this.hub.notify();
    return result;
  }
}

/** The client-facing fields of an event. A message's feed entry reads `messages` instead. */
function payloadOf(event: ConductorFeedEvent): Record<string, unknown> {
  switch (event.kind) {
    case 'message':
      return { text: event.text };
    case 'notice':
      return { noticeId: event.eventId, text: event.text };
    case 'question':
      return {
        questionId: event.questionId,
        reason: event.reason,
        question: event.question,
        options: event.options.map((option) => ({ id: option.id, label: option.label })),
        recommended: event.recommended,
      };
    case 'answered':
      return {
        questionId: event.questionId,
        optionId: event.optionId,
        ...(event.text === undefined ? {} : { text: event.text }),
      };
  }
}
