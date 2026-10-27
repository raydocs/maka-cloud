import type { TaskView } from '@maka-cloud/client';
import { act, fireEvent, screen } from '@testing-library/react-native';
import {
  forgetSteers,
  type Steer,
  settledFrom,
  steerPhase,
  steerTarget,
  withdrawable,
} from '@/lib/steer';
import { type Call, frame, openChat, push, running, taskEvent } from './harness';

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useLocalSearchParams: () => ({}),
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

const view = (over: Partial<TaskView> = {}): TaskView => ({
  taskId: 't1',
  title: 'Fix the login loop',
  state: 'running',
  createdAt: 1,
  progress: [],
  cancelRequested: false,
  pauseRequested: false,
  ...over,
});
const steer = (over: Partial<Steer> = {}): Steer => ({
  id: 's1',
  taskId: 't1',
  text: 'Use the staging database',
  at: 1,
  ...over,
});

test('each state of a message to a task is told apart only as far as the server says', () => {
  // Nothing back from the server yet, and then nothing at all.
  expect(steerPhase(steer({ request: 'send' }), view())).toBe('sent');
  expect(steerPhase(steer({ failed: 'Could not complete the request.' }), view())).toBe('failed');
  // The server holds it: running, the agent reads it after its step; paused or waiting, next turn.
  expect(steerPhase(steer({ server: 'pending' }), view())).toBe('received');
  expect(steerPhase(steer({ server: 'pending' }), view({ state: 'paused' }))).toBe('queued');
  expect(steerPhase(steer({ server: 'pending' }), view({ state: 'queued' }))).toBe('queued');
  // The agent has it: being worked in while the task goes on, read once it has ended.
  expect(steerPhase(steer({ server: 'delivered' }), view())).toBe('applying');
  expect(steerPhase(steer({ server: 'delivered' }), view({ state: 'succeeded' }))).toBe('read');
  // Read, but the task is not running: nothing says it is being worked in.
  expect(steerPhase(steer({ server: 'delivered' }), view({ state: 'paused' }))).toBe('read');
  expect(steerPhase(steer({ server: 'withdrawn' }), view())).toBe('withdrawn');
  expect(steerPhase(steer({ server: 'unseen' }), view({ state: 'failed' }))).toBe('unread');
  // Pending when the task ended: what the log says, or that it cannot say.
  expect(steerPhase(steer({ server: 'pending' }), view({ state: 'succeeded' }))).toBe('unknown');
  expect(
    steerPhase(steer({ server: 'pending', settled: 'unread' }), view({ state: 'cancelled' })),
  ).toBe('unread');
  // Only one the server holds and the agent has not read can be taken back.
  expect(['received', 'queued'].every((phase) => withdrawable(phase as never))).toBe(true);
  expect(['sent', 'failed', 'applying', 'read'].some((phase) => withdrawable(phase as never))).toBe(
    false,
  );
});

test('the log settles a message still pending at the end only when its counts can', () => {
  expect(settledFrom({ sent: 2, read: 2, unseen: 0, withdrawn: 0 })).toBe('read');
  expect(settledFrom({ sent: 2, read: 0, unseen: 1, withdrawn: 1 })).toBe('unread');
  expect(settledFrom({ sent: 3, read: 1, unseen: 1, withdrawn: 1 })).toBe('unknown');
  // A take-back whose answer was lost may be this one: it cannot be called read.
  expect(settledFrom({ sent: 2, read: 1, unseen: 0, withdrawn: 1 })).toBe('unknown');
});

test('a take-back refused because the message moved on asks the server where it stands', async () => {
  let sends = 0;
  const { calls } = await openChat(running(), (call) => {
    if (call.method === 'POST' && call.path === '/v1/tasks/t1/messages')
      return Response.json({
        message: { messageId: call.body?.messageId, state: ++sends > 1 ? 'delivered' : 'pending' },
      });
    if (call.method === 'DELETE') return Response.json({ error: 'invalid_state' }, { status: 409 });
    return undefined;
  });
  await screen.findByTestId('steer-chip');
  await fireEvent.changeText(
    screen.getByTestId('field-Keep the conversation going'),
    'Use the staging database',
  );
  await fireEvent.press(screen.getByTestId('button-Send message'));
  await screen.findByTestId('steer-phase-received');
  await fireEvent.press(screen.getByRole('button', { name: 'Take back' }));
  // Not taken to be read: the same message again, and what the server says.
  expect(await screen.findByTestId('steer-phase-applying')).toBeTruthy();
  expect(posts(calls)).toHaveLength(2);
  expect(posts(calls)[1]?.body?.messageId).toBe(posts(calls)[0]?.body?.messageId);
});

test('a check round asks about one message, however many wait', async () => {
  const realNow = Date.now;
  const { calls } = await openChat(running(), (call) =>
    call.method === 'POST' && call.path === '/v1/tasks/t1/messages'
      ? Response.json({ message: { messageId: call.body?.messageId, state: 'pending' } })
      : undefined,
  );
  await screen.findByTestId('steer-chip');
  const field = () => screen.getByTestId('field-Keep the conversation going');
  for (const words of ['First note', 'Second note', 'Third note']) {
    await fireEvent.changeText(field(), words);
    await fireEvent.press(screen.getByTestId('button-Send message'));
    await screen.findByText(words);
  }
  await waitForPosts(calls, 3);
  const later = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 9_000);
  try {
    await act(async () => push(taskEvent(1005, { type: 'task_progress', note: 'Ran the tests' })));
  } finally {
    later.mockRestore();
  }
  // One more: the oldest, sent again unchanged.
  expect(posts(calls)).toHaveLength(4);
  expect(posts(calls)[3]?.body?.messageId).toBe(posts(calls)[0]?.body?.messageId);
});

const waitForPosts = async (calls: Call[], count: number) => {
  for (let i = 0; i < 20 && posts(calls).length < count; i++)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(posts(calls)).toHaveLength(count);
};

test('an earlier message the agent has not read keeps its own "Take back"', async () => {
  const { calls } = await openChat(running(), (call) => {
    if (call.method === 'POST' && call.path === '/v1/tasks/t1/messages')
      return Response.json({ message: { messageId: call.body?.messageId, state: 'pending' } });
    if (call.method === 'DELETE')
      return Response.json({
        message: { messageId: call.path.split('/').at(-1), state: 'withdrawn' },
      });
    return undefined;
  });
  await screen.findByTestId('steer-chip');
  const field = () => screen.getByTestId('field-Keep the conversation going');
  await fireEvent.changeText(field(), 'First note');
  await fireEvent.press(screen.getByTestId('button-Send message'));
  await screen.findByTestId('steer-phase-received');
  await fireEvent.changeText(field(), 'Second note');
  await fireEvent.press(screen.getByTestId('button-Send message'));
  await screen.findAllByTestId('steer-phase-received');
  await fireEvent.press(screen.getByRole('button', { name: 'Take back “First note”' }));
  const first = posts(calls)[0]?.body?.messageId as string;
  expect(calls.some((call) => call.method === 'DELETE' && call.path.endsWith(`/${first}`))).toBe(
    true,
  );
  expect(await screen.findByTestId('steer-phase-withdrawn')).toBeTruthy();
});

test('the task to steer is a top-level task still going, the running one first', () => {
  const old = view({ taskId: 'a', state: 'paused', createdAt: 5 });
  const live = view({ taskId: 'b', state: 'running', createdAt: 2 });
  expect(steerTarget([old, live])?.taskId).toBe('b');
  expect(steerTarget([old])?.taskId).toBe('a');
  expect(steerTarget([view({ state: 'succeeded' })])).toBeUndefined();
  expect(steerTarget([view({ cancelRequested: true })])).toBeUndefined();
});

const posts = (calls: Call[]) =>
  calls.filter((call) => call.method === 'POST' && call.path === '/v1/tasks/t1/messages');

test('while a task runs, a message goes to it: sent, then received, and it can be taken back', async () => {
  let answer: (response: Response) => void = () => {};
  const { calls } = await openChat(running(), (call) => {
    if (call.method === 'POST' && call.path === '/v1/tasks/t1/messages')
      return new Promise((resolve) => {
        answer = resolve;
      });
    if (call.method === 'DELETE' && call.path.startsWith('/v1/tasks/t1/messages/'))
      return Response.json({
        message: { messageId: call.path.split('/').at(-1), state: 'withdrawn' },
      });
    return undefined;
  });
  const chip = await screen.findByTestId('steer-chip');
  expect(chip.props.accessibilityState.checked).toBe(true);
  expect(screen.getByText('To the running task · Fix the login loop')).toBeTruthy();
  const field = screen.getByTestId('field-Keep the conversation going');
  expect(field.props.placeholder).toBe('Tell the running task…');
  await fireEvent.changeText(field, 'Use the staging database');
  await fireEvent.press(screen.getByTestId('button-Send message'));
  // To the task, not the conversation; on screen at once, marked as going to the task.
  expect(posts(calls)).toHaveLength(1);
  expect(posts(calls)[0]?.body?.text).toBe('Use the staging database');
  expect(calls.some((call) => call.path === '/v1/conversations/c1/messages')).toBe(false);
  expect(screen.getByText('Use the staging database')).toBeTruthy();
  expect(screen.getAllByText('Sent, waiting for the server').length).toBeGreaterThan(0);
  const id = posts(calls)[0]?.body?.messageId as string;
  await act(async () => answer(Response.json({ message: { messageId: id, state: 'pending' } })));
  expect(
    screen.getAllByText('Received. The agent reads it after its current step.').length,
  ).toBeGreaterThan(0);
  await fireEvent.press(screen.getByRole('button', { name: 'Take back' }));
  expect(calls.some((call) => call.method === 'DELETE' && call.path.endsWith(`/${id}`))).toBe(true);
  expect(await screen.findByTestId('steer-phase-withdrawn')).toBeTruthy();
  // Settled: nothing more by the composer, and nothing left to take back.
  expect(screen.queryByTestId('steer-state')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Take back' })).toBeNull();
});

test('a paused task queues it for the next turn; a step later the phone asks again with the same message', async () => {
  const realNow = Date.now;
  let state = 'pending';
  const { calls } = await openChat(
    [
      ...running(),
      taskEvent(1003, { type: 'task_pause_requested', by: 's' }),
      taskEvent(1004, { type: 'task_paused' }),
    ],
    (call) =>
      call.method === 'POST' && call.path === '/v1/tasks/t1/messages'
        ? Response.json({ message: { messageId: call.body?.messageId, state } })
        : undefined,
  );
  await screen.findByTestId('steer-chip');
  await fireEvent.changeText(
    screen.getByTestId('field-Keep the conversation going'),
    'Skip the flaky test',
  );
  await fireEvent.press(screen.getByTestId('button-Send message'));
  expect(
    await screen.findAllByText('Queued for the next turn: the task is paused or has not started.'),
  ).not.toHaveLength(0);
  // The task goes on and takes a step; by then the agent has read it.
  state = 'delivered';
  const later = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 9_000);
  try {
    await act(async () =>
      push(
        taskEvent(1005, { type: 'task_resumed' }) +
          taskEvent(1006, { type: 'task_progress', note: 'Ran the tests' }),
      ),
    );
    expect(await screen.findAllByText('The agent has it and is working it in.')).not.toHaveLength(
      0,
    );
  } finally {
    later.mockRestore();
  }
  const sent = posts(calls);
  expect(sent.length).toBeGreaterThanOrEqual(2);
  // A check is the same message again: the server applies it once.
  expect(new Set(sent.map((call) => call.body?.messageId)).size).toBe(1);
  expect(new Set(sent.map((call) => call.body?.text)).size).toBe(1);
  // Read, and the task ends: it stays read.
  await act(async () =>
    push(
      taskEvent(1006, {
        type: 'task_succeeded',
        manifest: { summary: 'Done.', done: [], notDone: [], confidence: 'high', knownIssues: [] },
      }),
    ),
  );
  expect(await screen.findByTestId('steer-phase-read')).toBeTruthy();
});

test('switched off, the message goes to the conversation', async () => {
  const { calls } = await openChat(running());
  await fireEvent.press(await screen.findByTestId('steer-chip'));
  expect(screen.getByTestId('steer-chip').props.accessibilityState.checked).toBe(false);
  await fireEvent.changeText(screen.getByTestId('field-Keep the conversation going'), 'Thanks');
  await fireEvent.press(screen.getByTestId('button-Send message'));
  expect(calls.some((call) => call.path === '/v1/conversations/c1/messages')).toBe(true);
  expect(posts(calls)).toHaveLength(0);
});

test('a task that takes no messages gives the words back, and the next send goes to the conversation', async () => {
  const { calls } = await openChat(running(), (call) =>
    call.method === 'POST' && call.path === '/v1/tasks/t1/messages'
      ? Response.json({ error: 'steer_unsupported' }, { status: 409 })
      : undefined,
  );
  await screen.findByTestId('steer-chip');
  const field = screen.getByTestId('field-Keep the conversation going');
  await fireEvent.changeText(field, 'Use the staging database');
  await fireEvent.press(screen.getByTestId('button-Send message'));
  expect(await screen.findByTestId('steer-refused')).toBeTruthy();
  expect(field.props.value).toBe('Use the staging database');
  expect(screen.getByTestId('steer-chip').props.accessibilityState.checked).toBe(false);
  expect(screen.queryByTestId('steer-bubble')).toBeNull();
  await fireEvent.press(screen.getByTestId('button-Send message'));
  expect(calls.some((call) => call.path === '/v1/conversations/c1/messages')).toBe(true);
});

test('a message over the limit for a task stays in the box to shorten', async () => {
  const { calls } = await openChat(running());
  await screen.findByTestId('steer-chip');
  const field = screen.getByTestId('field-Keep the conversation going');
  const long = 'x'.repeat(4_001);
  await fireEvent.changeText(field, long);
  await fireEvent.press(screen.getByTestId('button-Send message'));
  expect(screen.getByTestId('steer-refused')).toBeTruthy();
  expect(field.props.value).toBe(long);
  expect(posts(calls)).toHaveLength(0);
  expect(screen.queryByTestId('steer-bubble')).toBeNull();
  // At the limit it goes to the task.
  await fireEvent.changeText(field, 'x'.repeat(4_000));
  await fireEvent.press(screen.getByTestId('button-Send message'));
  expect(posts(calls)).toHaveLength(1);
});

test('a message that did not reach the server is sent again as the same message, or deleted', async () => {
  let fail = true;
  const { calls } = await openChat(running(), (call) =>
    call.method === 'POST' && call.path === '/v1/tasks/t1/messages'
      ? fail
        ? new Response('{}', { status: 503 })
        : Response.json({ message: { messageId: call.body?.messageId, state: 'pending' } })
      : undefined,
  );
  await screen.findByTestId('steer-chip');
  await fireEvent.changeText(
    screen.getByTestId('field-Keep the conversation going'),
    'Use the staging database',
  );
  await fireEvent.press(screen.getByTestId('button-Send message'));
  expect(await screen.findByTestId('steer-phase-failed')).toBeTruthy();
  // Settled first: nothing new can be sent until it is sent again or deleted.
  await fireEvent.changeText(screen.getByTestId('field-Keep the conversation going'), 'And more');
  expect(screen.getByTestId('button-Send message').props.accessibilityState.disabled).toBe(true);
  fail = false;
  await fireEvent.press(screen.getByRole('button', { name: 'Send again' }));
  expect(
    await screen.findAllByText('Received. The agent reads it after its current step.'),
  ).not.toHaveLength(0);
  const sent = posts(calls);
  expect(sent).toHaveLength(2);
  expect(sent[1]?.body?.messageId).toBe(sent[0]?.body?.messageId);
});

test('a resend the task refuses keeps the message, failed, with its words and "Delete"', async () => {
  let answer = () => new Response('{}', { status: 503 });
  await openChat(running(), (call) =>
    call.method === 'POST' && call.path === '/v1/tasks/t1/messages' ? answer() : undefined,
  );
  await screen.findByTestId('steer-chip');
  await fireEvent.changeText(
    screen.getByTestId('field-Keep the conversation going'),
    'Use the staging database',
  );
  await fireEvent.press(screen.getByTestId('button-Send message'));
  expect(await screen.findByTestId('steer-phase-failed')).toBeTruthy();
  answer = () => Response.json({ error: 'invalid_state' }, { status: 409 });
  await fireEvent.press(screen.getByRole('button', { name: 'Send again' }));
  expect(
    await screen.findByText('The task is not in a state where that can be done.'),
  ).toBeTruthy();
  expect(screen.getByTestId('steer-phase-failed')).toBeTruthy();
  expect(screen.getByText('Use the staging database')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Delete' }));
  expect(screen.queryByTestId('steer-bubble')).toBeNull();
});

test('a task that ended before reading the message says so, from its log', async () => {
  const { calls } = await openChat(running(), (call) => {
    if (call.method === 'POST' && call.path === '/v1/tasks/t1/messages')
      return Response.json({ message: { messageId: call.body?.messageId, state: 'pending' } });
    if (call.path === '/v1/tasks/t1/timeline')
      return Response.json({
        timeline: { messages: { sent: 1, read: 0, unseen: 1, withdrawn: 0 } },
      });
    return undefined;
  });
  await screen.findByTestId('steer-chip');
  await fireEvent.changeText(
    screen.getByTestId('field-Keep the conversation going'),
    'Use the staging database',
  );
  await fireEvent.press(screen.getByTestId('button-Send message'));
  await screen.findAllByText('Received. The agent reads it after its current step.');
  await act(async () =>
    push(
      taskEvent(1004, { type: 'task_failed', reason: 'tests failed' }) +
        frame('message.posted', {
          messageId: 'm2',
          role: 'assistant',
          text: 'It failed.',
          at: 1005,
        }),
    ),
  );
  expect(await screen.findByTestId('steer-phase-unread')).toBeTruthy();
  expect(calls.some((call) => call.path === '/v1/tasks/t1/timeline')).toBe(true);
  // With nothing still going, there is no task to send to.
  expect(screen.queryByTestId('steer-chip')).toBeNull();
});
