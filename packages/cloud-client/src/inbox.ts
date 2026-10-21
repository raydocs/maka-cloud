import type { InboxItem } from './contract';
import { displayText } from './presentation';

/** Kinds the supervisor builds from a conductor question, which the conversation already shows as a decision card. */
const QUESTION_KINDS = new Set(['approval', 'budget', 'decision']);

/**
 * The items to show, newest first within each state. An open item that repeats a question the
 * conversation is still asking word for word is left out: answering either one answers both, so a
 * missed match only shows the same ask twice.
 */
export function visibleInbox(items: InboxItem[], openQuestions: ReadonlySet<string>) {
  const byRecency = [...items].sort((a, b) => b.updatedAt - a.updatedAt);
  const live = byRecency.filter((item) => item.state !== 'closed');
  return {
    live: live.filter(
      (item) =>
        !(
          item.state === 'open' &&
          QUESTION_KINDS.has(item.kind) &&
          openQuestions.has(displayText(item.ask).trim())
        ),
    ),
    closed: byRecency.filter((item) => item.state === 'closed'),
  };
}

/** The reviewer's sentence for a task: the supervisor's own text, label included, never worked out here. */
export function verdictOf(items: readonly InboxItem[], taskId: string): InboxItem | undefined {
  return items
    .filter(
      (item) =>
        item.taskId === taskId && (item.kind === 'finished' || item.kind === 'verification_failed'),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}
