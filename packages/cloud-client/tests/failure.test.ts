import { expect, test } from 'vitest';
import { confidenceWords, failureWords, type InboxItem, reviewWords } from '../src/index';

test('a bad manifest is said plainly, with the raw reason kept for Details', () => {
  const words = failureWords('invalid manifest: result.json is not valid JSON');
  expect(words.sentence).toBe('Maka finished, but its report of what it did could not be read.');
  expect(words.next).toBe('Ask Maka to try again.');
  expect(words.detail).toBe('invalid manifest: result.json is not valid JSON');
});

test('a runner error and a runner that went silent are told apart', () => {
  expect(failureWords('runner error: exit code 137').sentence).toBe(
    'The computer Maka was working on stopped unexpectedly.',
  );
  expect(failureWords('runner exited without reporting a result').sentence).toBe(
    'Maka stopped before reporting a result.',
  );
});

test('"needs you" keeps the orchestrator’s own words as the sentence and the next step', () => {
  const words = failureWords(
    'needs you: this task was resumed 3 times in a row without finishing a step or spending anything, so it stopped; open it and decide whether to start it again',
  );
  expect(words.sentence).toBe(
    'This task was resumed 3 times in a row without finishing a step or spending anything, so it stopped.',
  );
  expect(words.next).toBe('Open it and decide whether to start it again.');
  expect(failureWords('needs you:').sentence).toBe('This task stopped.');
  expect(failureWords('needs you: it stopped').next).toBe('Decide whether to start it again.');
});

test('a time limit and a budget each get their own sentence', () => {
  expect(failureWords('runner error: timed out after 60000 ms').sentence).toBe(
    'This task ran out of time, so it stopped.',
  );
  expect(failureWords('budget of $2.00 reached ($2.01 spent)').sentence).toBe(
    'The budget for this task ran out, so it stopped.',
  );
  expect(failureWords("this turn's model budget of $1.00 reached ($1.00 spent)").next).toBe(
    'Raise the budget, or ask Maka for a smaller step.',
  );
});

test('a reason already written for people is kept; an unknown machine line is not shown first', () => {
  expect(failureWords('The build broke on the new version. More detail follows.').sentence).toBe(
    'The build broke on the new version.',
  );
  const unknown = failureWords("the run's start could not be recorded: SQLITE_BUSY");
  expect(unknown.sentence).toBe('This task did not finish.');
  expect(unknown.detail).toBe("the run's start could not be recorded: SQLITE_BUSY");
});

test('confidence is a sentence about Maka', () => {
  expect(confidenceWords('high')).toBe('Maka is confident in this result.');
  expect(confidenceWords('low')).toContain('Check it closely');
});

const finished = (ask: string, kind: InboxItem['kind'] = 'finished'): InboxItem => ({
  preconditionHash: 'h',
  version: 1,
  interrupts: false,
  delivery: 'none',
  itemId: 'i1',
  kind,
  conversationId: 'c1',
  taskId: 't1',
  ask,
  options: [],
  allowText: false,
  evidence: [],
  state: 'open',
  closeReason: null,
  createdAt: 1,
  updatedAt: 1,
});

test('the review is shown once: the runner’s review line wins over the supervisor’s check', () => {
  const done = [
    'Fixed it',
    'review: an independent agent reviewed the change and reported no findings',
  ];
  const verdict = finished('“Fix” finished (not independently checked): “Done.”');
  expect(reviewWords(done, verdict)).toEqual([
    'An independent agent reviewed the change and reported no findings.',
  ]);
  expect(reviewWords(['Fixed it'], verdict)).toEqual(['Not independently checked.']);
  expect(reviewWords([], undefined)).toEqual([]);
  // A failed check is always said.
  expect(
    reviewWords(done, finished('The tests failed after the change.', 'verification_failed')),
  ).toHaveLength(2);
});
