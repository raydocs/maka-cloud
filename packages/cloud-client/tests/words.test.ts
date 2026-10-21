import { expect, test } from 'vitest';
import {
  budgetWords,
  type DutyView,
  type InboxItem,
  type SourceListing,
  stackOf,
  triggerWords,
  verdictOf,
  visibleInbox,
} from '../src/index';

const duty = (over: Partial<DutyView> = {}): DutyView => ({
  dutyId: 'd1',
  name: 'Fix red CI',
  trigger: { kind: 'ci_failed_default_branch' },
  authority: 'open-pr',
  runBudgetUsd: 2,
  dailyCapUsd: 6,
  state: 'active',
  activatedAt: 1,
  offReason: null,
  consecutiveFailures: 0,
  ...over,
});

const inboxItem = (over: Partial<InboxItem>): InboxItem => ({
  itemId: 'i1',
  kind: 'finished',
  conversationId: 'c1',
  taskId: 't1',
  ask: 'Finished (independently checked): the login loop is fixed.',
  options: [],
  allowText: false,
  evidence: [],
  state: 'closed',
  closeReason: null,
  preconditionHash: 'h',
  version: 1,
  interrupts: false,
  delivery: 'none',
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

test('triggers, authority and budget are said in words', () => {
  expect(triggerWords({ kind: 'schedule', everyMinutes: 15 })).toBe('Every 15 min');
  expect(triggerWords({ kind: 'schedule', everyMinutes: 120 })).toBe('Every 2 h');
  expect(triggerWords({ kind: 'schedule', everyMinutes: 1440 })).toBe('Every 1 day');
  expect(triggerWords({ kind: 'issue_opened' })).toBe('When an issue is opened');
  expect(triggerWords({ kind: 'something_new' })).toBe('When something happens');
  expect(budgetWords(duty())).toBe('Up to $2.00 a run, $6.00 a day');
});

test('the review verdict is the supervisor’s own sentence for that task, the newest one', () => {
  const items = [
    inboxItem({ itemId: 'old', ask: 'old', updatedAt: 1 }),
    inboxItem({ itemId: 'new', ask: 'new', updatedAt: 5 }),
    inboxItem({ itemId: 'other', ask: 'other', taskId: 't2', updatedAt: 9 }),
    inboxItem({ itemId: 'dec', kind: 'decision', ask: 'decision', updatedAt: 10 }),
  ];
  expect(verdictOf(items, 't1')?.ask).toBe('new');
  expect(verdictOf(items, 't3')).toBeUndefined();
});

const source = (index: number, label: SourceListing['label'], site = `site${index}.example`) =>
  ({ index, label, site, url: `https://${site}/page` }) satisfies SourceListing;

test('the stack shows at most three, the change first, then how to see it, then the reading', () => {
  const ordered = stackOf([
    source(0, 'alternative'),
    source(1, 'docs'),
    source(2, 'test_report'),
    source(3, 'preview'),
    source(4, 'pull_request'),
  ]).map((s) => s.label);
  expect(ordered).toEqual(['pull_request', 'preview', 'test_report']);
  // Equal labels keep the order the pages were opened in.
  expect(
    stackOf([source(5, 'docs'), source(2, 'docs'), source(9, 'docs')]).map((s) => s.index),
  ).toEqual([2, 5, 9]);
});

test('an open item that repeats a question the conversation is asking is shown once', () => {
  const asked = inboxItem({
    itemId: 'q',
    kind: 'decision',
    ask: 'Which direction feels right?',
    state: 'open',
  });
  const other = inboxItem({
    itemId: 'o',
    kind: 'blocked',
    ask: 'A step may be stuck.',
    state: 'open',
  });
  const shown = visibleInbox([asked, other], new Set(['Which direction feels right?']));
  expect(shown.live.map((entry) => entry.itemId)).toEqual(['o']);
  // Once the question is answered, the item is the only record of it.
  expect(visibleInbox([asked, other], new Set()).live).toHaveLength(2);
  // A closed item is kept apart, under "Done".
  expect(visibleInbox([{ ...asked, state: 'closed' }], new Set()).closed).toHaveLength(1);
});
