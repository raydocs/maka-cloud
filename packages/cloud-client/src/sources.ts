import type { SourceLabel, SourceListing } from './contract';

export const LABEL_WORDS: Record<SourceLabel, string> = {
  source: 'a source',
  docs: 'the docs',
  alternative: 'an alternative',
  pull_request: 'the pull request',
  preview: 'the preview',
  test_report: 'the test report',
};

/** Why a card is in the stack comes first: the change itself, then how to see it, then the reading. */
const LABEL_ORDER: SourceLabel[] = [
  'pull_request',
  'preview',
  'test_report',
  'docs',
  'source',
  'alternative',
];
const STACK_SIZE = 3;

export function stackOf(sources: readonly SourceListing[]): SourceListing[] {
  return [...sources]
    .sort(
      (a, b) => LABEL_ORDER.indexOf(a.label) - LABEL_ORDER.indexOf(b.label) || a.index - b.index,
    )
    .slice(0, STACK_SIZE);
}
