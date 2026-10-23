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
test('loads once on opening and filters locally without loading between keystrokes', async () => {
  const client = new CloudClient('token');
  const first = deferred();
  const read = vi.spyOn(client, 'listConversations').mockReturnValue(first.promise);
  const props = { client, onChoose: vi.fn() };
  const view = render(<ConversationSearch {...props} query="" />);
  expect(screen.getByRole('status').textContent).toBe('Loading');
  expect(read).toHaveBeenCalledTimes(1);
  view.rerender(<ConversationSearch {...props} query="a" />);
  expect(screen.getByRole('status').textContent).toBe('Loading');
  await act(async () =>
    first.resolve({
      conversations: [
        { conversationId: 'a', title: 'Alpha', createdAt: 1 },
        { conversationId: 'b', title: 'Beta', createdAt: 2 },
      ],
    }),
  );
  expect(screen.getByRole('button', { name: 'Alpha' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Beta' })).toBeTruthy();
  for (const query of ['al', 'alp', 'alph']) {
    view.rerender(<ConversationSearch {...props} query={query} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Beta' })).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  }
  view.rerender(<ConversationSearch {...props} query="missing" />);
  expect(screen.getByText('No matches for “missing”.')).toBeTruthy();
  view.rerender(<ConversationSearch {...props} query="" />);
  expect(screen.getByRole('button', { name: 'Alpha' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Beta' })).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(1);
});
test('the conversations already on the page show at once, then the fresh list replaces them', async () => {
  const client = new CloudClient('token');
  const fresh = deferred();
  const read = vi.spyOn(client, 'listConversations').mockReturnValue(fresh.promise);
  render(
    <ConversationSearch
      client={client}
      known={[{ conversationId: 'a', title: 'Alpha', createdAt: 1 }]}
      onChoose={vi.fn()}
      query=""
    />,
  );
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('button', { name: 'Alpha' })).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () =>
    fresh.resolve({ conversations: [{ conversationId: 'b', title: 'Beta', createdAt: 2 }] }),
  );
  expect(screen.getByRole('button', { name: 'Beta' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Alpha' })).toBeNull();
});
test('with nothing typed and no conversations, the hint shows', async () => {
  const client = new CloudClient('token');
  vi.spyOn(client, 'listConversations').mockResolvedValue({ conversations: [] });
  render(<ConversationSearch client={client} onChoose={vi.fn()} query="" />);
  await screen.findByText('Search conversation titles.');
});
test('an error and Retry make exactly one new load', async () => {
  const client = new CloudClient('token');
  const next = deferred();
  const read = vi
    .spyOn(client, 'listConversations')
    .mockRejectedValueOnce(new Error('offline'))
    .mockReturnValueOnce(next.promise);
  const props = { client, onChoose: vi.fn() };
  const view = render(<ConversationSearch {...props} query="missing" />);
  await screen.findByText('Search could not be loaded.');
  view.rerender(<ConversationSearch {...props} query="other" />);
  expect(screen.getByText('Search could not be loaded.')).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
  expect(read).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('status').textContent).toBe('Loading');
  await act(async () => next.resolve({ conversations: [] }));
  expect(screen.getByText('No matches for “other”.')).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(2);
});
test.each(['result', 'error'])('a stale %s cannot replace a newer load', async (kind) => {
  const client = new CloudClient('old-token');
  const replacement = new CloudClient('new-token');
  const older = deferred();
  const newer = deferred();
  vi.spyOn(client, 'listConversations').mockReturnValueOnce(older.promise);
  vi.spyOn(replacement, 'listConversations').mockReturnValueOnce(newer.promise);
  const onChoose = vi.fn();
  const view = render(<ConversationSearch client={client} onChoose={onChoose} query="new" />);
  view.rerender(<ConversationSearch client={replacement} onChoose={onChoose} query="new" />);
  await act(async () =>
    newer.resolve({ conversations: [{ conversationId: 'c', title: 'new title', createdAt: 1 }] }),
  );
  await act(async () => {
    if (kind === 'error') older.reject(new Error('late'));
    else older.resolve({ conversations: [] });
  });
  expect(screen.getByRole('button', { name: 'new title' })).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByText('Search could not be loaded.')).toBeNull();
});
