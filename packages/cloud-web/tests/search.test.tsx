import { CloudClient, type Conversation } from '@maka-cloud/client';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ConversationSearch } from '../src/Search';

afterEach(cleanup);
const deferred = () => {
  let resolve!: (value: { conversations: Conversation[] }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ conversations: Conversation[] }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
test('search distinguishes hint, loading, no matches, error and retry', async () => {
  const client = new CloudClient('token');
  const first = deferred();
  const read = vi
    .spyOn(client, 'listConversations')
    .mockReturnValueOnce(first.promise)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ conversations: [] });
  const props = { client, onChoose: vi.fn() };
  const view = render(<ConversationSearch {...props} query="" />);
  expect(screen.getByText('Search conversation titles.')).toBeTruthy();
  expect(read).not.toHaveBeenCalled();
  view.rerender(<ConversationSearch {...props} query="missing" />);
  expect(screen.getByRole('status').textContent).toBe('Loading');
  await act(async () => first.resolve({ conversations: [] }));
  expect(screen.getByText('No matches for “missing”.')).toBeTruthy();
  view.rerender(<ConversationSearch {...props} query="other" />);
  await screen.findByText('Search could not be loaded.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
  await screen.findByText('No matches for “other”.');
});
test.each(['result', 'error'])(
  'a late older %s cannot replace the newer query or empty hint',
  async (kind) => {
    const client = new CloudClient('token');
    const older = deferred();
    const newer = deferred();
    vi.spyOn(client, 'listConversations')
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const props = { client, onChoose: vi.fn() };
    const view = render(<ConversationSearch {...props} query="old" />);
    view.rerender(<ConversationSearch {...props} query="new" />);
    await act(async () =>
      newer.resolve({ conversations: [{ conversationId: 'c', title: 'new title', createdAt: 1 }] }),
    );
    await act(async () => {
      if (kind === 'error') older.reject(new Error('late'));
      else
        older.resolve({
          conversations: [{ conversationId: 'old', title: 'old title', createdAt: 0 }],
        });
    });
    expect(screen.getByRole('button', { name: 'new title' })).toBeTruthy();
    view.rerender(<ConversationSearch {...props} query="" />);
    expect(screen.queryByText('new title')).toBeNull();
    expect(screen.getByText('Search conversation titles.')).toBeTruthy();
  },
);
