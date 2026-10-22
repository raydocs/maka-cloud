import type { InboxEvidence, InboxItem, Question } from './contract';
import { displayJson, displayText, exactText, publicLink } from './presentation';

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

const HEADING: Record<string, string> = {
  approval: 'Needs your approval',
  budget: 'Needs your decision on the budget',
  decision: 'Needs your decision',
  blocked: 'Might be stuck',
  verification_failed: 'A check of the result failed',
  finished: 'Finished',
};
export const inboxHeading = (kind: string) => HEADING[kind] ?? 'Needs you';

/** One line of what backs a card, ready to show. A link is only offered when it is safe to open. */
export type EvidenceLine =
  | { kind: 'artifact'; text: string }
  | { kind: 'action'; tool: string; args: string }
  | { kind: 'link'; label: string; href: string | undefined };

function evidenceLine(evidence: InboxEvidence, exact: boolean): EvidenceLine {
  if (evidence.kind === 'artifact')
    return { kind: 'artifact', text: `Result file: ${displayText(evidence.name)}` };
  if (evidence.kind === 'action')
    return {
      kind: 'action',
      tool: exact ? evidence.tool : displayText(evidence.tool),
      args: exact ? evidence.args : displayText(evidence.args),
    };
  return { kind: 'link', label: displayText(evidence.label), href: publicLink(evidence.url) };
}

/**
 * A finished-task card's sentence split into its parts, when it has the supervisor's usual shape
 * (`“Title” finished (not independently checked): “Outcome”`). The words are the supervisor's own,
 * cut apart and never rewritten; any other shape is not split and is shown whole.
 */
export function finishedParts(
  item: InboxItem,
): { title: string; check: string; outcome: string } | undefined {
  if (item.kind !== 'finished') return undefined;
  const match =
    /^[“"]([^”"]{1,200})[”"] finished \(((?:not )?independently checked)\): [“"](.*)[”"]$/su.exec(
      displayText(item.ask).trim(),
    );
  if (!match) return undefined;
  const [, title, check, outcome] = match;
  return { title: title ?? '', check: check ?? '', outcome: outcome ?? '' };
}

/**
 * What a decision card shows, worked out once for every client. An approval binds the card's exact
 * text: it is shown as sent, with the held call's arguments, and a card that cannot be shown exactly
 * cannot be approved (the approve option is left out). Other cards are filtered like any server
 * text. The recommended option comes first.
 */
export function inboxCardModel(item: InboxItem) {
  const approval = item.kind === 'approval';
  const exact = approval ? exactText(item.ask) : undefined;
  const options = [...item.options]
    .filter((option) => !approval || exact !== undefined || option.id !== 'approve')
    .sort((a, b) => Number(b.recommended) - Number(a.recommended));
  return {
    heading: inboxHeading(item.kind),
    text: exact ?? displayText(item.ask),
    cannotApproveHere: approval && exact === undefined,
    evidence: item.evidence.map((evidence) => evidenceLine(evidence, exact !== undefined)),
    options,
    hasRecommended: options.some((option) => option.recommended),
    /** Said in place of the buttons once an answer is chosen. */
    answering:
      item.state !== 'answering'
        ? undefined
        : item.delivery === 'retrying'
          ? 'Your answer is chosen. Delivering it is taking a few tries, and it will keep trying.'
          : 'Your answer is chosen and is being delivered.',
  };
}

const REASON_HEADING = {
  taste: 'Needs your decision',
  budget_overrun: 'Needs your decision on the budget',
  irreversible: 'Needs your approval',
} as const;

/**
 * What a question from the conversation shows. Same rule as `inboxCardModel`: an approval is shown
 * exactly as sent, and when it cannot be, the approve option is not offered.
 */
export function questionCardModel(question: Question, answered?: string) {
  const approval = question.reason === 'irreversible';
  const exact = approval ? exactText(question.question) : undefined;
  const options = [...question.options]
    .filter((o) => !approval || exact !== undefined || o.id !== 'approve')
    .sort((a, b) => Number(b.id === question.recommended) - Number(a.id === question.recommended));
  return {
    heading: answered
      ? 'Decision recorded'
      : (REASON_HEADING[question.reason] ?? REASON_HEADING.taste),
    text: exact ?? displayText(question.question),
    cannotApproveHere: approval && exact === undefined && !answered,
    note: question.note ? displayText(question.note) : undefined,
    held:
      question.action && !answered
        ? { tool: question.action.tool, args: displayJson(question.action.args) }
        : undefined,
    answeredLabel: answered
      ? displayText(question.options.find((o) => o.id === answered)?.label ?? 'Selected option')
      : undefined,
    options: options.map((o) => ({
      id: o.id,
      label: displayText(o.label),
      recommended: o.id === question.recommended,
    })),
    firstOption: options[0]?.id ?? '',
  };
}

/** "Pull request #42" for a GitHub pull request link, which would otherwise be named "github.com". */
export function pullRequestName(url: string | undefined): string | undefined {
  const number = url?.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)(?:[/?#]|$)/u)?.[1];
  return number ? `Pull request #${number}` : undefined;
}
