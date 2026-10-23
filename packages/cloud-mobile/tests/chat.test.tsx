import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import Chat from '@/app/(tabs)/chat';
import { SessionProvider, useSession } from '@/lib/session';
import { LIGHT, ThemeContext } from '@/lib/theme';

// The chat's stream opens when the screen is in front: here, as soon as it is shown.
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ navigate: () => {}, push: () => {}, dismissTo: () => {}, back: () => {} }),
    useFocusEffect: (effect: () => () => void) => useEffect(effect, [effect]),
  };
});

// The app's foreground state is not modelled here (tests/live.test.ts covers `keepLive`): the stream
// simply runs while the screen is shown.
jest.mock('@/lib/live', () => ({
  keepLive: (feed: { start(): void; stop(): void }) => {
    feed.start();
    return () => feed.stop();
  },
}));

const fetchMock = () => (globalThis as unknown as { __fetch: jest.Mock }).__fetch;

let frameId = 0;
const frame = (kind: string, data: Record<string, unknown>) =>
  `id: ${++frameId}\nevent: ${kind}\ndata: ${JSON.stringify({ conversationId: 'c1', ...data })}\n\n`;
const task = (at: number, event: Record<string, unknown>) =>
  frame('task.event', { seq: frameId + 1, at, event: { taskId: 't1', ...event } });

/** An event stream that sends `frames` and then stays open, as the server's does. */
function stream(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`: open\n\n${frames.join('')}`));
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/** The person asked for a fix; a task started for it and is running its tests. */
const working = () => [
  frame('message.posted', { messageId: 'm1', role: 'user', text: 'Fix the login loop', at: 1000 }),
  task(1001, { type: 'task_created', sessionId: 's', title: 'Fix the login loop', mode: 'async' }),
  task(1002, { type: 'task_started' }),
  task(1003, { type: 'task_narration', line: "Running the repository's tests" }),
  task(1004, {
    type: 'task_panel',
    panelId: 'diff',
    kind: 'diff',
    state: 'passed',
    title: 'Change',
    summary: '+12 −3 in 2 files',
  }),
  task(1005, {
    type: 'task_panel',
    panelId: 'tests',
    kind: 'tests',
    state: 'running',
    title: 'Repository tests',
    summary: 'running',
  }),
];

type Post = (body: { text: string; clientMessageId: string }) => Promise<Response>;

async function openChat(frames: string[], post: Post = async () => Response.json({})) {
  frameId = 0;
  fetchMock().mockImplementation(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    if (path === '/v1/conversations')
      return Response.json({
        conversations: [{ conversationId: 'c1', title: 'Login', createdAt: 1 }],
      });
    if (path === '/v1/events') return stream(frames);
    if (path === '/v1/conversations/c1/messages' && init.method === 'POST')
      return post(JSON.parse(String(init.body)));
    if (path === '/v1/conversations/c1/tasks') return Response.json({ tasks: [] });
    return new Response('{}', { status: 404 });
  });
  let api: ReturnType<typeof useSession> | undefined;
  function Gate() {
    api = useSession();
    return api.session.status === 'in' ? <Chat /> : <Text>out</Text>;
  }
  await render(
    <ThemeContext.Provider value={LIGHT}>
      <SessionProvider>
        <Gate />
      </SessionProvider>
    </ThemeContext.Provider>,
  );
  await screen.findByText('out');
  await act(async () => {
    await api?.signIn('maka.example.com', 'invite-token');
  });
  await act(async () => {
    if (api?.session.status === 'in') api.open('c1');
  });
}

test('a message’s work shows under it: the live line, a row per step, and a pill for its task', async () => {
  await openChat(working());
  expect(await screen.findByText("Running the repository's tests")).toBeTruthy();
  expect(screen.getByText('Change')).toBeTruthy();
  expect(screen.getByText('+12 −3 in 2 files')).toBeTruthy();
  expect(screen.getByText('Repository tests')).toBeTruthy();
  const pill = screen.getByRole('button', { name: 'Task: Fix the login loop, In progress' });
  // The pill opens the task's row with its controls.
  expect(screen.queryByRole('button', { name: 'Cancel task' })).toBeNull();
  await fireEvent.press(pill);
  expect(screen.getByRole('button', { name: 'Cancel task' })).toBeTruthy();
});

test('once the task is done the block folds to one line, and the result links back to its task', async () => {
  await openChat([
    ...working(),
    task(1006, {
      type: 'task_panel',
      panelId: 'tests',
      kind: 'tests',
      state: 'passed',
      title: 'Repository tests',
      summary: '41 passed',
    }),
    task(1000 + 3 * 60_000, {
      type: 'task_succeeded',
      manifest: {
        summary: 'The login page no longer loops.',
        done: [],
        notDone: [],
        confidence: 'high',
        knownIssues: [],
      },
    }),
    frame('message.posted', { messageId: 'm2', role: 'assistant', text: 'Fixed.', at: 200_000 }),
  ]);
  expect(await screen.findByText('Worked for 3 min · 2 steps')).toBeTruthy();
  expect(screen.queryByText('Repository tests')).toBeNull();
  expect(screen.queryByTestId('thinking', { includeHiddenElements: true })).toBeNull();
  const pill = screen.getByRole('button', { name: 'Task: Fix the login loop, Finished' });
  expect(pill.props.accessibilityState.expanded).toBe(false);
  await fireEvent.press(screen.getByRole('link', { name: 'Go to the task: Fix the login loop' }));
  expect(
    screen.getByRole('button', { name: 'Task: Fix the login loop, Finished' }).props
      .accessibilityState.expanded,
  ).toBe(true);
});

test('a send is taken at once; a failed one says so and is sent again as the same message', async () => {
  const posts: string[] = [];
  let answer: (response: Response) => void = () => {};
  await openChat(
    [
      ...working(),
      task(1006, {
        type: 'task_succeeded',
        manifest: { summary: 'Done.', done: [], notDone: [], confidence: 'high', knownIssues: [] },
      }),
      frame('message.posted', { messageId: 'm2', role: 'assistant', text: 'Fixed.', at: 2000 }),
    ],
    (body) => {
      posts.push(body.clientMessageId);
      return new Promise((resolve) => {
        answer = resolve;
      });
    },
  );
  await screen.findByText('Fixed.');
  const field = screen.getByTestId('field-Keep the conversation going');
  await fireEvent.changeText(field, 'Also update the docs');
  await fireEvent.press(screen.getByTestId('button-Send message'));
  // Before the server has answered, the words are in the list and say they are on their way.
  expect(screen.getByText('Also update the docs')).toBeTruthy();
  expect(screen.getByTestId('outgoing-sending')).toBeTruthy();
  expect(field.props.value).toBe('');
  await act(async () => answer(new Response('{}', { status: 500 })));
  expect(await screen.findByText('Not sent')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Send again' }));
  await act(async () => answer(Response.json({})));
  expect(posts).toHaveLength(2);
  expect(posts[1]).toBe(posts[0]);
  // Taken: the agent is on it before the conversation shows the message.
  expect(await screen.findByText('Maka is working…')).toBeTruthy();
  expect(screen.queryByText('Not sent')).toBeNull();
});
