import type { Conversation, InboxItem, TaskView } from '@maka-cloud/client';
import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { FlatList } from 'react-native';
import { groupConversations } from '@/lib/groups';
import { forgetSteers } from '@/lib/steer';
import { frame, openChat, running, taskEvent } from './harness';

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ navigate: () => {}, push: () => {}, dismissTo: () => {}, back: () => {} }),
    useFocusEffect: (effect: () => () => void) => useEffect(effect, [effect]),
  };
});
jest.mock('@/lib/live', () => ({
  keepLive: (feed: { start(): void; stop(): void }) => {
    feed.start();
    return () => feed.stop();
  },
}));

beforeEach(() => forgetSteers());

test('a dropped connection is its own line, says the work goes on, and the task reads as last seen', async () => {
  await openChat(running(), undefined, { drop: true });
  expect(await screen.findByText('Connection · Reconnecting…')).toBeTruthy();
  expect(
    screen.getByText('The work keeps going on the server. Nothing needs resending.'),
  ).toBeTruthy();
  expect(screen.getByTestId('status-task')).toHaveTextContent('Task · In progress (as last seen)');
  // Nothing about the connection reads as a failure, and the task is not said to have failed.
  expect(screen.queryByText(/Failed/u)).toBeNull();
  expect(
    within(screen.getByTestId('status-lines')).queryByTestId('mark-attention', {
      includeHiddenElements: true,
    }),
  ).toBeNull();
});

test('while live, there is no connection line; a stop the machine has not confirmed is its own line', async () => {
  await openChat([
    ...running(),
    taskEvent(1003, { type: 'task_cancel_requested', by: 's' }),
    taskEvent(1004, { type: 'task_stop_pending', cause: 'no answer' }),
  ]);
  expect(await screen.findByTestId('status-machine')).toHaveTextContent(
    'Machine · Not yet confirmed stopped',
  );
  expect(screen.queryByTestId('status-connection')).toBeNull();
  expect(screen.queryByTestId('status-keeps-going')).toBeNull();
});

const ask = (questionId: string) =>
  frame('conductor.question', {
    questionId,
    reason: 'taste',
    question: 'Which branch should it use?',
    options: [
      { id: 'main', label: 'main' },
      { id: 'dev', label: 'dev' },
    ],
    recommended: 'main',
    at: 1010,
  });

test('a decision below the screen shows "N waiting" by the composer; a tap goes to it', async () => {
  const toCard = jest.spyOn(FlatList.prototype, 'scrollToOffset');
  try {
    await openChat([...running(), ask('q1')]);
    await screen.findByText('Which branch should it use?');
    toCard.mockClear();
    const list = screen.getByLabelText('Messages');
    // A long conversation scrolled to its top: the card is far below the composer.
    await act(async () => {
      fireEvent(screen.getByTestId('chat-footer'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 400 } },
      });
      fireEvent(screen.getByTestId('decision-slot-q1'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 40, width: 390, height: 300 } },
      });
      fireEvent(list, 'layout', {
        nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 700 } },
      });
      fireEvent(list, 'contentSizeChange', 390, 3000);
      fireEvent.scroll(list, {
        nativeEvent: {
          contentOffset: { x: 0, y: 0 },
          contentSize: { width: 390, height: 3000 },
          layoutMeasurement: { width: 390, height: 700 },
        },
      });
    });
    const chip = await screen.findByTestId('waiting-chip');
    expect(chip).toHaveTextContent('1 waiting');
    await fireEvent.press(chip);
    expect(toCard).toHaveBeenCalledWith(expect.objectContaining({ offset: 2524 }));
    // Scrolled down to it: the card is on screen and the chip goes.
    await act(async () =>
      fireEvent.scroll(list, {
        nativeEvent: {
          contentOffset: { x: 0, y: 2300 },
          contentSize: { width: 390, height: 3000 },
          layoutMeasurement: { width: 390, height: 700 },
        },
      }),
    );
    expect(screen.queryByTestId('waiting-chip')).toBeNull();
  } finally {
    toCard.mockRestore();
  }
});

test('"N waiting" counts only the cards that cannot be seen, above or below', async () => {
  const toCard = jest.spyOn(FlatList.prototype, 'scrollToOffset');
  try {
    await openChat([...running(), ask('q1'), ask('q2')]);
    await screen.findByTestId('decision-slot-q2');
    toCard.mockClear();
    const list = screen.getByLabelText('Messages');
    const scrollTo = (y: number) =>
      act(async () =>
        fireEvent.scroll(list, {
          nativeEvent: {
            contentOffset: { x: 0, y },
            contentSize: { width: 390, height: 3000 },
            layoutMeasurement: { width: 390, height: 700 },
          },
        }),
      );
    // Footer 700 high at the end of 3000; the cards start 2248 and 2568 down, 300 high each.
    await act(async () => {
      fireEvent(screen.getByTestId('chat-footer'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 700 } },
      });
      fireEvent(screen.getByTestId('decision-slot-q1'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 40, width: 390, height: 300 } },
      });
      fireEvent(screen.getByTestId('decision-slot-q2'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 360, width: 390, height: 300 } },
      });
      fireEvent(list, 'layout', {
        nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 700 } },
      });
      fireEvent(list, 'contentSizeChange', 390, 3000);
    });
    // The first card is in view, the second below the composer.
    await scrollTo(1700);
    expect(await screen.findByTestId('waiting-chip')).toHaveTextContent('1 waiting');
    await fireEvent.press(screen.getByTestId('waiting-chip'));
    expect(toCard).toHaveBeenCalledWith(expect.objectContaining({ offset: 2544 }));
    // Both in view: no chip.
    await scrollTo(2400);
    expect(screen.queryByTestId('waiting-chip')).toBeNull();
    // The first scrolled off above: it counts too.
    await scrollTo(2560);
    expect(await screen.findByTestId('waiting-chip')).toHaveTextContent('1 waiting');
  } finally {
    toCard.mockRestore();
  }
});

const conversation = (conversationId: string, createdAt: number): Conversation => ({
  conversationId,
  title: conversationId,
  createdAt,
});
const item = (conversationId: string, over: Partial<InboxItem> = {}): InboxItem => ({
  itemId: `i-${conversationId}`,
  kind: 'decision',
  conversationId,
  taskId: null,
  ask: 'Which one?',
  options: [],
  allowText: false,
  evidence: [],
  state: 'open',
  closeReason: null,
  preconditionHash: 'h',
  version: 1,
  interrupts: false,
  delivery: 'none',
  createdAt: 10,
  updatedAt: 10,
  ...over,
});
const view = (over: Partial<TaskView>): TaskView => ({
  taskId: 't',
  state: 'running',
  createdAt: 5,
  progress: [],
  cancelRequested: false,
  pauseRequested: false,
  ...over,
});

test('the conversations fall into needs you, working and recent, each newest first, with their state', () => {
  const groups = groupConversations(
    [
      conversation('a', 1),
      conversation('b', 2),
      conversation('c', 3),
      conversation('d', 4),
      conversation('e', 5),
      conversation('f', 6),
    ],
    // A suggestion is not something that needs the person; an answered item neither.
    [item('a'), item('e', { kind: 'suggestion' }), item('f', { state: 'answering' })],
    {
      a: [view({ state: 'running' })],
      b: [view({ state: 'paused', startedAt: 50 })],
      c: [view({ state: 'running', startedAt: 40 })],
      d: [view({ state: 'succeeded', finishedAt: 30 })],
      e: [],
    },
  );
  expect(groups.needs.map((row) => [row.conversation.conversationId, row.state])).toEqual([
    ['a', 'needs'],
  ]);
  expect(groups.working.map((row) => [row.conversation.conversationId, row.state])).toEqual([
    ['b', 'paused'],
    ['c', 'working'],
  ]);
  // f's tasks were not read: it has no state line rather than a guess.
  expect(groups.recent.map((row) => [row.conversation.conversationId, row.state])).toEqual([
    ['d', 'finished'],
    ['f', undefined],
    ['e', 'talk'],
  ]);
});

test('"+" lists the conversations by state, each with its state under its title', async () => {
  const { chosen } = await openChat(running(), (call) => {
    if (call.path === '/v1/inbox/items')
      return Response.json({ items: [item('c2', { itemId: 'i2' })] });
    if (call.path === '/v1/conversations/c1/tasks')
      return Response.json({ tasks: [view({ taskId: 't1', startedAt: 1002 })] });
    return undefined;
  });
  await screen.findByTestId('steer-chip');
  await fireEvent.press(screen.getByTestId('button-Conversations'));
  const needs = await screen.findByTestId('sheet-needs');
  expect(within(needs).getByRole('button', { name: 'Docs, Needs you' })).toBeTruthy();
  const working = await screen.findByTestId('sheet-working');
  const login = within(working).getByRole('button', { name: 'Login, Working' });
  expect(login.props.accessibilityState.selected).toBe(true);
  expect(screen.queryByTestId('sheet-recent')).toBeNull();
  await fireEvent.press(within(needs).getByRole('button', { name: 'Docs, Needs you' }));
  expect(chosen()).toBe('c2');
});
