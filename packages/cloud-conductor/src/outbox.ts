import type { HeldCall, QuestionOption, QuestionReason } from './state.js';

/**
 * Every event carries `eventId`, stable across retries: the conductor sends an
 * event again until a call resolves, so the receiver drops an id it has seen.
 */
interface OutboxEvent {
  eventId: string;
}

export type OutboxKind = 'message' | 'question' | 'notice' | 'answered';

export interface OutboxMessage extends OutboxEvent {
  conversationId: string;
  runId: string;
  text: string;
}

export interface OutboxQuestion extends OutboxEvent {
  conversationId: string;
  runId: string;
  questionId: string;
  reason: QuestionReason;
  /** Built by code for budget and irreversible questions; the model's text only for taste. */
  question: string;
  /** The recommended option comes first. */
  options: QuestionOption[];
  recommended: string;
  /** irreversible: the model's own words, shown under the question as supplementary context. */
  note?: string;
  /** irreversible: the held call, exactly as it runs if approved. */
  action?: HeldCall;
}

export interface OutboxAnswered extends OutboxEvent {
  conversationId: string;
  runId: string;
  questionId: string;
  optionId: string;
  text?: string;
}

export interface OutboxNotice extends OutboxEvent {
  conversationId: string;
  runId?: string;
  text: string;
}

/**
 * Where the conductor's output goes. The cloud server implements it (PR B):
 * assistant messages, question cards and notices in the conversation's feed.
 *
 * Delivery is at least once. A call that resolves acks the event; one that
 * throws is retried with the same `eventId`, also after a restart, and the
 * conversation's later events wait behind it.
 */
export interface ConductorOutbox {
  message(message: OutboxMessage): void | Promise<void>;
  question(question: OutboxQuestion): void | Promise<void>;
  notice(notice: OutboxNotice): void | Promise<void>;
  /** A question was answered (once per question), before the answer reaches the model. */
  answered?(answered: OutboxAnswered): void | Promise<void>;
}

/** Keeps everything in arrays; for tests and local runs. */
export class MemoryOutbox implements ConductorOutbox {
  readonly messages: OutboxMessage[] = [];
  readonly questions: OutboxQuestion[] = [];
  readonly notices: OutboxNotice[] = [];
  readonly answers: OutboxAnswered[] = [];

  message(message: OutboxMessage): void {
    this.messages.push(message);
  }

  question(question: OutboxQuestion): void {
    this.questions.push(question);
  }

  notice(notice: OutboxNotice): void {
    this.notices.push(notice);
  }

  answered(answered: OutboxAnswered): void {
    this.answers.push(answered);
  }
}
