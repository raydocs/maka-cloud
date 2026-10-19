import type { QuestionOption, QuestionReason } from './state.js';

export interface OutboxMessage {
  conversationId: string;
  runId: string;
  text: string;
}

export interface OutboxQuestion {
  conversationId: string;
  runId: string;
  questionId: string;
  reason: QuestionReason;
  question: string;
  /** The recommended option comes first. */
  options: QuestionOption[];
  recommended: string;
}

export interface OutboxAnswered {
  conversationId: string;
  runId: string;
  questionId: string;
  optionId: string;
  text?: string;
}

export interface OutboxNotice {
  conversationId: string;
  runId?: string;
  text: string;
}

/**
 * Where the conductor's output goes. The cloud server implements it (PR B):
 * assistant messages, question cards and notices in the conversation's feed.
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
