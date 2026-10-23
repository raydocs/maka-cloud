export const ITEM_KINDS = [
  'decision',
  'approval',
  'blocked',
  'verification_failed',
  'budget',
  'finished',
  'suggestion',
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** Lower comes first in lists and digests. */
export const KIND_PRIORITY: Record<ItemKind, number> = {
  approval: 0,
  budget: 1,
  decision: 2,
  verification_failed: 3,
  blocked: 4,
  finished: 5,
  suggestion: 6,
};

/** Only `finished` and `suggestion` never interrupt: nothing is wrong, and nobody is waiting. */
export function interrupts(kind: ItemKind): boolean {
  return kind !== 'finished' && kind !== 'suggestion';
}

/** What choosing an option does. */
export type OptionEffect =
  /** Answers the conductor's open question with this option. */
  | 'answer_question'
  /** Posts a user message to the conversation, built by code from `messageKey`. */
  | 'message'
  /** Records the decision and sends nothing. */
  | 'local'
  /** Tells the duties engine which set of standing duties the owner chose (`proposalSetId`). */
  | 'proposal'
  /** Accepts or dismisses a proposed card, or answers the offer to turn a kind off (T30); the host's cards service does it. */
  | 'card';

export interface ItemOption {
  id: string;
  label: string;
  recommended: boolean;
  effect: OptionEffect;
  /** For `message` options: which template of messages.ts to use. */
  messageKey?: string;
  /** For `local` options: why the item closes. */
  closeReason?: 'acknowledged' | 'accepted';
  /** For `local` options: a side effect inside the answer's transaction. `recheck` queues the verification again. */
  localAction?: 'recheck';
  /** For `proposal` options: which set of the proposal this option chooses. */
  proposalSetId?: string;
  /** For `card` options: what the answer does to the card. */
  cardAction?: 'accept' | 'dismiss' | 'turn_off' | 'keep';
}

export type EvidenceLink =
  | { kind: 'artifact'; taskId: string; name: string }
  | { kind: 'link'; url: string; label: string }
  | { kind: 'action'; tool: string; args: string };

export type ItemState = 'open' | 'answering' | 'closed';

export type CloseReason =
  | 'answered'
  | 'handled_elsewhere'
  | 'condition_cleared'
  | 'acknowledged'
  | 'accepted';

export type PushState = 'none' | 'pending' | 'sent' | 'held' | 'muted';

/** What item text and the precondition hash are built from. Agent-written parts are always quoted. */
export interface ItemContext {
  /** Which state the item depends on; picks the precondition and the reassessment. */
  subject:
    | 'question'
    | 'stall'
    | 'failed_twice'
    | 'result'
    | 'verification'
    | 'cap'
    | 'proposal'
    | 'suggestion';
  taskTitle?: string;
  taskId?: string;
  questionId?: string;
  stepKey?: string;
  detail?: string;
  count?: number;
  idleMinutes?: number;
  outcome?: 'succeeded' | 'failed';
  /** Digest of the manifest the item is about. */
  manifestDigest?: string;
  /** For `verification` items: which verification, how often it was queued again, and how it ended. */
  verificationId?: string;
  verificationEpoch?: number;
  verificationState?: string;
  /** For `finished` items: whether an independent check ran. */
  checked?: 'passed' | 'not_checked';
  /** For `suggestion` items (`detail` is the card's id): what the card shows besides its title. */
  suggestion?: SuggestionFacts;
  /** The fixed sentence the ask was built from, so a reader can say it in another language. */
  askTemplate?: AskTemplate;
}

/**
 * Which fixed sentence a rule built an ask from, and its parts. Agent-written parts are already
 * clipped and quote-safe (`quotable`); an empty title means the task has none. The server says the
 * sentence in the owner's language; the ask stays the English one.
 */
export type AskTemplate =
  | { id: 'stall'; title: string; minutes: number }
  | { id: 'failed_twice'; title: string; count: number; reason: string }
  | { id: 'low_confidence'; title: string; summary: string }
  | {
      id: 'finished';
      title: string;
      outcome: 'succeeded' | 'failed';
      checked?: 'passed' | 'not_checked';
      detail: string;
    }
  | { id: 'verification_failed'; title: string; count: number; detail: string; more: number }
  | { id: 'verification_incomplete'; title: string; detail: string };

/** What a proposed card shows beside its verb-first title. Cost and mode are the kind's, not words. */
export interface SuggestionFacts {
  /** The card's kind, for the owner's per-kind switch. */
  kind: string;
  mode: string;
  estimateUsd: number;
  /** The estimate is what finished tasks of this kind typically cost, not a default. */
  typical: boolean;
  repo: string;
  detail: string;
  /** Text from outside the owner shaped the card: the task it starts runs tainted. */
  external: boolean;
}

/** What clients see. No runner, model or vendor name is ever in here. */
export interface ItemView {
  itemId: string;
  kind: ItemKind;
  conversationId: string;
  taskId: string | null;
  ask: string;
  options: Array<{ id: string; label: string; recommended: boolean }>;
  allowText: boolean;
  evidence: EvidenceLink[];
  state: ItemState;
  closeReason: CloseReason | null;
  /** Echo this in the answer: the answer only applies to the state the human saw. */
  preconditionHash: string;
  version: number;
  interrupts: boolean;
  /** For a proposed card: what it will do besides its title. */
  suggestion?: SuggestionFacts;
  /** The fixed sentence the ask was built from; the server turns it into the owner's language and drops it. */
  askTemplate?: AskTemplate;
  /** The answer is chosen and being delivered. */
  delivery: 'none' | 'sending' | 'retrying';
  createdAt: number;
  updatedAt: number;
}
