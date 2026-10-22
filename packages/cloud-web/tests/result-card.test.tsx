import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { type InboxItem, resultParts } from '@maka-cloud/client';
import { ResultCard } from '../src/Inbox';

afterEach(cleanup);

const item: InboxItem = {
  itemId: 'itm_1',
  kind: 'finished',
  conversationId: 'cnv_1',
  taskId: 'tsk_1',
  ask: '“Fix the flaky login test” finished (not independently checked): “The login test passed 50 runs in a row.”',
  options: [{ id: 'ack', label: 'Got it', recommended: true }],
  allowText: false,
  evidence: [
    { kind: 'artifact', taskId: 'tsk_1', name: 'changes.diff' },
    { kind: 'link', label: 'github.com', url: 'https://github.com/acme/widgets/pull/42' },
  ],
  state: 'open',
  closeReason: null,
  preconditionHash: 'h',
  version: 1,
  interrupts: false,
  delivery: 'none',
  createdAt: 1,
  updatedAt: 1,
};

test('a finished task reads as "[Review] title", the outcome, the check and its chips', () => {
  const onReview = vi.fn();
  const onAnswer = vi.fn();
  render(
    <ResultCard
      item={item}
      parts={resultParts(item) as never}
      disabled={false}
      onAnswer={onAnswer}
      onReview={onReview}
    />,
  );
  expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(
    'Review Fix the flaky login test',
  );
  expect(screen.getByText('The login test passed 50 runs in a row.')).toBeTruthy();
  expect(screen.getByText('Not checked by a second agent')).toBeTruthy();
  expect(screen.getByText('changes.diff')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Pull request #42 ↗' }).getAttribute('href')).toBe(
    'https://github.com/acme/widgets/pull/42',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review: Fix the flaky login test' }));
  expect(onReview).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
  expect(onAnswer).toHaveBeenCalledWith('ack');
});
