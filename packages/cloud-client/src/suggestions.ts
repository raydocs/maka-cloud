import type { InboxItem, SuggestionFacts } from './contract';
import { displayText, dollars } from './presentation';

const MODE_WORDS: Record<SuggestionFacts['mode'], string> = {
  quick: 'Quick',
  standard: 'Standard',
  deep: 'Deep',
};

/** "Standard · about $3.00 (typical) · acme/widgets": what a proposed card will cost and where, in words. */
export function suggestionLine(facts: SuggestionFacts): string {
  const cost = `about ${dollars(facts.estimateUsd)}${facts.typical ? ' (typical)' : ''}`;
  return [MODE_WORDS[facts.mode] ?? 'Standard', cost, displayText(facts.repo)].join(' · ');
}

/**
 * The open items split for Home: what needs a decision, and what the employee only suggests. A
 * suggestion never counts as something that "needs you": it is an offer, and ignoring it is fine.
 */
export function splitSuggestions(items: readonly InboxItem[]): {
  waiting: InboxItem[];
  suggested: InboxItem[];
} {
  const waiting: InboxItem[] = [];
  const suggested: InboxItem[] = [];
  for (const item of items) (item.kind === 'suggestion' ? suggested : waiting).push(item);
  return { waiting, suggested };
}
