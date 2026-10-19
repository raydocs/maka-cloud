import type {
  ConductorOutbox,
  OutboxAnswered,
  OutboxMessage,
  OutboxNotice,
  OutboxQuestion,
} from '@maka-cloud/conductor';
import type { ConductorFeedEvent, ConversationPublisher } from '@maka-cloud/server';

/**
 * The conductor's outbox, delivered into the server's conversation feed. The
 * conductor retries an event until a call resolves; the feed drops an event id
 * it already has, so a retry never shows twice. A refusal that a retry cannot
 * fix (an unknown conversation, a different event under the same id) is
 * reported and acknowledged, so it cannot hold the conversation's later events
 * forever. A database error throws, and the conductor retries.
 */
export class ServerOutbox implements ConductorOutbox {
  constructor(
    private readonly publisher: ConversationPublisher,
    private readonly warn: (message: string, detail?: unknown) => void = () => undefined,
  ) {}

  message(message: OutboxMessage): void {
    this.publish({
      kind: 'message',
      eventId: message.eventId,
      conversationId: message.conversationId,
      text: message.text,
    });
  }

  notice(notice: OutboxNotice): void {
    this.publish({
      kind: 'notice',
      eventId: notice.eventId,
      conversationId: notice.conversationId,
      text: notice.text,
    });
  }

  question(question: OutboxQuestion): void {
    this.publish({
      kind: 'question',
      eventId: question.eventId,
      conversationId: question.conversationId,
      questionId: question.questionId,
      reason: question.reason,
      question: question.question,
      options: question.options.map((option) => ({ id: option.id, label: option.label })),
      recommended: question.recommended,
      ...(question.note === undefined ? {} : { note: question.note }),
      ...(question.action === undefined
        ? {}
        : { action: { tool: question.action.tool, args: question.action.args } }),
    });
  }

  answered(answered: OutboxAnswered): void {
    this.publish({
      kind: 'answered',
      eventId: answered.eventId,
      conversationId: answered.conversationId,
      questionId: answered.questionId,
      optionId: answered.optionId,
      ...(answered.text === undefined ? {} : { text: answered.text }),
    });
  }

  private publish(event: ConductorFeedEvent): void {
    const result = this.publisher.publish(event);
    if (!result.published) {
      this.warn(`The feed refused conductor event ${event.eventId}: ${result.reason}`, event);
    }
  }
}
