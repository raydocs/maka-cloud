import type { AnswerRecord, ItemRecord } from './store.js';
import { type ItemView, KIND_PRIORITY } from './types.js';

export function toView(item: ItemRecord, answer?: AnswerRecord): ItemView {
  return {
    itemId: item.itemId,
    kind: item.kind,
    conversationId: item.conversationId,
    taskId: item.taskId,
    ask: item.ask,
    options: item.options.map(({ id, label, recommended }) => ({ id, label, recommended })),
    allowText: item.allowText,
    evidence: item.evidence,
    state: item.state,
    closeReason: item.closeReason,
    preconditionHash: item.precondition,
    version: item.version,
    interrupts: item.interrupt,
    ...(item.context.subject === 'suggestion' && item.context.suggestion
      ? { suggestion: item.context.suggestion }
      : {}),
    delivery:
      item.state === 'answering' && answer
        ? answer.attempts <= 1 && answer.inFlight
          ? 'sending'
          : 'retrying'
        : 'none',
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/** Most urgent first, then oldest first. */
export function byUrgency(a: ItemRecord, b: ItemRecord): number {
  return KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || a.createdAt - b.createdAt || a.n - b.n;
}
