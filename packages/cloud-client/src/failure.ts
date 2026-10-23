import { BRAND } from './brand';
import type { InboxItem } from './contract';
import { finishedParts } from './inbox';
import { displayText, firstSentence } from './presentation';

/** A failed task said plainly: what happened, what to do next, and the server's own words for "Details". */
export interface FailureWords {
  sentence: string;
  next: string;
  /** The reason exactly as the server sent it, shown only on request. */
  detail: string;
}

const AGAIN = `Ask ${BRAND.name} to try again.`;

function capitalized(text: string): string {
  const flat = text
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.;:,]+$/u, '');
  return flat === '' ? flat : `${flat[0]?.toUpperCase()}${flat.slice(1)}.`;
}

/**
 * Maps an orchestrator or runner failure reason (`invalid manifest: …`, `runner error: …`,
 * `needs you: …`, a time limit, a budget) to one plain sentence and a next step. Anything it does
 * not recognise still reads as a sentence; the raw reason is kept for "Details".
 */
export function failureWords(reason: string): FailureWords {
  const detail = reason.trim();
  const lower = detail.toLowerCase();
  const name = BRAND.name;
  if (lower.startsWith('needs you:')) {
    // The orchestrator writes "what happened; what to do", already in plain words.
    const [what = '', ...rest] = detail.slice('needs you:'.length).split(';');
    const next = rest.join(';').trim();
    return {
      sentence: capitalized(what.replace(/^this task\b/iu, 'This task')) || 'This task stopped.',
      next: next ? capitalized(next) : 'Decide whether to start it again.',
      detail,
    };
  }
  if (/\bbudget\b/u.test(lower) && /reached|used up|spent|exceeded/u.test(lower))
    return {
      sentence: 'The budget for this task ran out, so it stopped.',
      next: `Raise the budget, or ask ${name} for a smaller step.`,
      detail,
    };
  if (/timed out|time ?out|run time|deadline/u.test(lower))
    return {
      sentence: 'This task ran out of time, so it stopped.',
      next: `Ask ${name} to try again, perhaps in smaller steps.`,
      detail,
    };
  if (lower.startsWith('invalid manifest:'))
    return {
      sentence: `${name} finished, but its report of what it did could not be read.`,
      next: AGAIN,
      detail,
    };
  if (lower.startsWith('runner exited without reporting'))
    return { sentence: `${name} stopped before reporting a result.`, next: AGAIN, detail };
  if (lower.startsWith('runner error:'))
    return {
      sentence: `The computer ${name} was working on stopped unexpectedly.`,
      next: AGAIN,
      detail,
    };
  // A reason already written as a sentence for people is kept; a machine's line is not shown first.
  const plain = /^[A-Z][^:]*(?:[.!?]|$)/u.test(detail) && !/[{}<>\\]|error:/iu.test(detail);
  return {
    sentence: plain ? firstSentence(detail) : 'This task did not finish.',
    next: AGAIN,
    detail,
  };
}

const CONFIDENCE: Record<string, string> = {
  high: `${BRAND.name} is confident in this result.`,
  medium: `${BRAND.name} is fairly confident in this result.`,
  low: `${BRAND.name} is not confident in this result. Check it closely.`,
};

/** The confidence a finished task reported, as a sentence about Maka. */
export function confidenceWords(confidence: string): string {
  return CONFIDENCE[confidence] ?? `${BRAND.name}'s confidence: ${confidence}.`;
}

export const REVIEW_PREFIX = 'review: ';

/** The runner's own `review:` line of a manifest's `done`, if it wrote one. */
export function reviewLineOf(done: readonly string[] | undefined): string | undefined {
  return done?.find((entry) => entry.startsWith(REVIEW_PREFIX));
}

/**
 * The one "Review" a finished task shows: the runner's own `review:` line when it wrote one (it
 * says what the independent review found), otherwise how far the supervisor checked the result.
 * A failed check is always said.
 */
export function reviewWords(
  done: readonly string[] | undefined,
  verdict: InboxItem | undefined,
): string[] {
  const lines: string[] = [];
  const line = reviewLineOf(done);
  if (line !== undefined) lines.push(capitalized(displayText(line.slice(REVIEW_PREFIX.length))));
  if (verdict?.kind === 'verification_failed') lines.push(displayText(verdict.ask));
  else if (line === undefined && verdict) {
    const parts = finishedParts(verdict);
    lines.push(
      parts
        ? parts.check.startsWith('not ')
          ? 'Not independently checked.'
          : 'Independently checked.'
        : displayText(verdict.ask),
    );
  }
  return lines;
}
