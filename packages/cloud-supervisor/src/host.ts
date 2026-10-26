/**
 * What the supervisor needs from the server it runs in. Declared structurally,
 * so this package imports nothing from `@maka-cloud/server`; the server (or the
 * composition code) passes an object of this shape.
 */

import type { AskTemplate, SuggestionFacts } from './types.js';

/** One entry of the server's feed, as `readFeed` returns it. */
export interface FeedEntry {
  id: number;
  kind: string;
  conversationId: string | null;
  at: number;
  data: unknown;
}

export interface QuestionDelivery {
  conversationId: string;
  questionId: string;
  optionId: string;
  text?: string;
  /** Who answered (`AnswerRequest.caller`); the host checks it again before the answer takes effect. */
  caller?: string;
}

/** The conductor's answers route: idempotent per question, the same option again is a duplicate. */
export type QuestionOutcome =
  | { accepted: true; duplicate: boolean }
  | {
      accepted: false;
      reason: 'not_found' | 'not_open' | 'unknown_option' | 'conflict' | 'closed' | 'text_too_long';
    };

export type ProposalOutcome =
  | { accepted: true; duplicate: boolean }
  | {
      accepted: false;
      reason: 'not_found' | 'forbidden' | 'unknown_set' | 'conflict' | 'duty_limit';
    };

/**
 * What the owner's tap on a proposed card did. A refusal is final (the answer is closed without
 * delivery); `decide` throws for a failure that may pass, and the supervisor tries again.
 */
export type SuggestionOutcome =
  | { accepted: true; duplicate: boolean }
  | { accepted: false; reason: 'not_found' | 'forbidden' | 'stale' | 'closed' };

/** Whether a proposed card still describes the repository, read fresh before a tap acts. */
export type SuggestionCheck =
  | { state: 'fresh' }
  /** The state moved: the card was replaced by this one, to show instead of acting. */
  | { state: 'refreshed'; card: SuggestionCard }
  /** The work is gone: nothing to offer any more. */
  | { state: 'gone' };

/** A card as the supervisor shows it. Whoever builds it has already made its text safe to show. */
export interface SuggestionCard {
  lineage: string;
  cardId: string;
  title: string;
  facts: SuggestionFacts;
}

/** What an interrupt carries. The channel decides how to show it. */
export interface Interrupt {
  /** One item, or a batch of items that were held back and are now released together. */
  items: Array<{
    itemId: string;
    conversationId: string;
    kind: string;
    ask: string;
    /** The fixed sentence the ask was built from, when a rule built it; see `ItemView`. */
    askTemplate?: AskTemplate;
  }>;
  batch: boolean;
}

export interface SupervisorHost {
  feed: {
    /** Entries after `after`, in order, of all conversations. Synchronous: it is a database read. */
    read(after: number, limit: number): FeedEntry[];
    /** Called after the feed moved. Returns the unsubscribe function. */
    subscribe(listener: () => void): () => void;
  };
  /** Appends an inbox event to the feed clients stream. Called at least once per item version. */
  publish(event: {
    kind: 'inbox.item' | 'inbox.digest';
    conversationId: string | null;
    data: unknown;
  }): void | Promise<void>;
  /** The channels an interrupt goes out on (a conversation notice, later web push). */
  notifier: {
    interrupt(interrupt: Interrupt): void | Promise<void>;
  };
  /** The conductor's answers route. */
  answers: {
    deliver(answer: QuestionDelivery, signal: AbortSignal): Promise<QuestionOutcome>;
  };
  /**
   * The conversation's message route: idempotent on `clientMessageId`. `caller`
   * is who answered; when the host no longer accepts them it answers `refused`
   * and posts nothing.
   */
  messages: {
    post(
      message: { conversationId: string; text: string; clientMessageId: string; caller?: string },
      signal: AbortSignal,
    ): Promise<{ messageId: string } | { refused: string }>;
  };
  /**
   * The duties engine's decision route, for `proposal` options. Idempotent per proposal: the same
   * set again is a duplicate, another set is a conflict. Absent when no duties engine runs; a
   * proposal item is then never raised.
   */
  proposals?: {
    decide(
      decision: { proposalId: string; setId: string; caller?: string },
      signal: AbortSignal,
    ): Promise<ProposalOutcome>;
  };
  /**
   * Proposed cards (T30). `verify` reads the repository again before a tap on "Do it" acts, and
   * says whether the card is still true; `decide` accepts or dismisses it, once. Absent when no
   * cards run; a suggestion is then never raised.
   */
  suggestions?: {
    verify(
      request: { cardId: string; caller?: string },
      signal: AbortSignal,
    ): Promise<SuggestionCheck>;
    decide(
      decision: {
        /** A card's id, or `offerRef` for the answer to an offer to turn a kind off. */
        cardId: string;
        action: 'accept' | 'dismiss' | 'turn_off' | 'keep';
        caller?: string;
      },
      signal: AbortSignal,
    ): Promise<SuggestionOutcome>;
  };
  /**
   * The owner of a conversation (an invite), or undefined when nobody owns it. With it the
   * digest is built per owner and its summary is that owner's to pay for; without it there is
   * one digest of every item.
   */
  ownerOf?(conversationId: string): string | undefined;
  /** Reports things that must not stop the supervisor. */
  onWarning?(message: string, detail?: unknown): void;
}

/** Writes the digest summary and orders items. It never decides what interrupts. */
export interface SummaryModel {
  summarize(
    input: {
      items: Array<{ id: string; kind: string; ask: string; ageMs: number }>;
    },
    signal: AbortSignal,
    /** Whose items these are: the one who pays. Undefined for items nobody owns. */
    owner?: string,
  ): Promise<{ order: string[]; summary: string }>;
}
