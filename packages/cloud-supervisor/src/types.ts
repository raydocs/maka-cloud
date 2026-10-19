export const ITEM_KINDS = [
  'decision',
  'approval',
  'blocked',
  'verification_failed',
  'budget',
  'finished',
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
};

/** Only `finished` never interrupts. */
export function interrupts(kind: ItemKind): boolean {
  return kind !== 'finished';
}

/** What choosing an option does. */
export type OptionEffect =
  /** Answers the conductor's open question with this option. */
  | 'answer_question'
  /** Posts a user message to the conversation, built by code from `messageKey`. */
  | 'message'
  /** Records the decision and sends nothing. */
  | 'local';

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
  subject: 'question' | 'stall' | 'failed_twice' | 'result' | 'verification';
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
  /** The answer is chosen and being delivered. */
  delivery: 'none' | 'sending' | 'retrying';
  createdAt: number;
  updatedAt: number;
}
