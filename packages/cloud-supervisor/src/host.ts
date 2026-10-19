/**
 * What the supervisor needs from the server it runs in. Declared structurally,
 * so this package imports nothing from `@maka-cloud/server`; the server (or the
 * composition code) passes an object of this shape.
 */

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
}

/** The conductor's answers route: idempotent per question, the same option again is a duplicate. */
export type QuestionOutcome =
  | { accepted: true; duplicate: boolean }
  | {
      accepted: false;
      reason: 'not_found' | 'not_open' | 'unknown_option' | 'conflict' | 'closed' | 'text_too_long';
    };

/** What an interrupt carries. The channel decides how to show it. */
export interface Interrupt {
  /** One item, or a batch of items that were held back and are now released together. */
  items: Array<{
    itemId: string;
    conversationId: string;
    kind: string;
    ask: string;
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
  /** The conversation's message route: idempotent on `clientMessageId`. */
  messages: {
    post(
      message: { conversationId: string; text: string; clientMessageId: string },
      signal: AbortSignal,
    ): Promise<{ messageId: string }>;
  };
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
  ): Promise<{ order: string[]; summary: string }>;
}
