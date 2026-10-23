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

/** Sends more frames down the latest open stream of conversation c1. */
let push: (frames: string) => void = () => {};

/** An event stream that sends `frames` and then stays open, as the server's does. */
function stream(frames: string[], live = false): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (more: string) => controller.enqueue(new TextEncoder().encode(more));
      if (live) push = send;
      send(`: open\n\n${frames.join('')}`);
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

// Frame ids only grow, across tests too, so a frame pushed later is never taken as one already seen.
async function openChat(frames: string[], post: Post = async () => Response.json({})) {
  fetchMock().mockImplementation(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    if (path === '/v1/conversations')
      return Response.json({
        conversations: [
          { conversationId: 'c1', title: 'Login', createdAt: 1 },
          { conversationId: 'c2', title: 'Docs', createdAt: 2 },
        ],
      });
    if (path === '/v1/events')
      return new URL(url).searchParams.get('conversation') === 'c1'
        ? stream(frames, true)
        : stream([]);
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
  const open = (conversationId: string) =>
    act(async () => {
      if (api?.session.status === 'in') api.open(conversationId);
    });
  await open('c1');
  return { open };
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
  // Words typed meanwhile wait: they cannot be sent, and they do not take the failed one's id.
  await fireEvent.changeText(field, 'and the changelog');
  expect(screen.getByTestId('button-Send message').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(screen.getByRole('button', { name: 'Send again' }));
  await act(async () => answer(Response.json({})));
  expect(posts).toHaveLength(2);
  expect(posts[1]).toBe(posts[0]);
  // Taken: the agent is on it before the conversation shows the message.
  expect(await screen.findByText('Maka is working…')).toBeTruthy();
  expect(screen.queryByText('Not sent')).toBeNull();
});

const finished = () => [
  ...working(),
  task(1006, {
    type: 'task_succeeded',
    manifest: { summary: 'Done.', done: [], notDone: [], confidence: 'high', knownIssues: [] },
  }),
  frame('message.posted', { messageId: 'm2', role: 'assistant', text: 'Fixed.', at: 2000 }),
];

test('a send that looked failed but reached the server is taken off once it shows', async () => {
  const posts: string[] = [];
  let fail = true;
  await openChat(finished(), async (body) => {
    posts.push(body.clientMessageId);
    return fail ? new Response('{}', { status: 502 }) : Response.json({});
  });
  await screen.findByText('Fixed.');
  const field = screen.getByTestId('field-Keep the conversation going');
  await fireEvent.changeText(field, 'Also update the docs');
  await fireEvent.press(screen.getByTestId('button-Send message'));
  expect(await screen.findByText('Not sent')).toBeTruthy();
  // The server had taken it: the stream brings it.
  await act(async () =>
    push(
      frame('message.posted', {
        messageId: 'm3',
        role: 'user',
        text: 'Also update the docs',
        at: 3000,
      }),
    ),
  );
  expect(await screen.findByText('Maka is working…')).toBeTruthy();
  expect(screen.queryByText('Not sent')).toBeNull();
  expect(screen.getAllByText('Also update the docs')).toHaveLength(1);
  // The next message is a new one, with an id of its own.
  fail = false;
  await fireEvent.changeText(field, 'Thanks');
  await fireEvent.press(screen.getByTestId('button-Send message'));
  expect(posts).toHaveLength(2);
  expect(posts[1]).not.toBe(posts[0]);
});

test('a failed send is still there after leaving and coming back, and is sent again as the same message', async () => {
  const posts: string[] = [];
  let fail = true;
  const { open } = await openChat(finished(), async (body) => {
    posts.push(body.clientMessageId);
    return fail ? new Response('{}', { status: 500 }) : Response.json({});
  });
  await screen.findByText('Fixed.');
  await fireEvent.changeText(
    screen.getByTestId('field-Keep the conversation going'),
    'Also update the docs',
  );
  await fireEvent.press(screen.getByTestId('button-Send message'));
  expect(await screen.findByText('Not sent')).toBeTruthy();
  await open('c2');
  expect(await screen.findByText('Docs')).toBeTruthy();
  expect(screen.queryByText('Not sent')).toBeNull();
  await open('c1');
  expect(await screen.findByText('Not sent')).toBeTruthy();
  expect(screen.getByText('Also update the docs')).toBeTruthy();
  fail = false;
  await fireEvent.press(screen.getByRole('button', { name: 'Send again' }));
  await screen.findByText('Maka is working…');
  expect(posts).toHaveLength(2);
  expect(posts[1]).toBe(posts[0]);
});

test('a send still on its way when the person leaves is kept if it fails, and gone if it succeeds', async () => {
  const posts: string[] = [];
  const answers: Array<(response: Response) => void> = [];
  const { open } = await openChat(finished(), (body) => {
    posts.push(body.clientMessageId);
    return new Promise((resolve) => {
      answers.push(resolve);
    });
  });
  await screen.findByText('Fixed.');
  const field = () => screen.getByTestId('field-Keep the conversation going');
  await fireEvent.changeText(field(), 'Also update the docs');
  await fireEvent.press(screen.getByTestId('button-Send message'));
  await open('c2');
  await screen.findByText('Docs');
  await act(async () => answers[0]?.(new Response('{}', { status: 503 })));
  await open('c1');
  expect(await screen.findByText('Not sent')).toBeTruthy();
  // Deleting it ends it for good.
  await fireEvent.press(screen.getByRole('button', { name: 'Delete' }));
  await open('c2');
  await open('c1');
  await screen.findByText('Fixed.');
  expect(screen.queryByText('Not sent')).toBeNull();
  // One that succeeds while the person is away leaves nothing behind.
  await fireEvent.changeText(field(), 'Thanks');
  await fireEvent.press(screen.getByTestId('button-Send message'));
  await open('c2');
  await screen.findByText('Docs');
  await act(async () => answers[1]?.(Response.json({})));
  await open('c1');
  await screen.findByText('Fixed.');
  expect(screen.queryByText('Not sent')).toBeNull();
  expect(screen.queryByText('Thanks')).toBeNull();
  expect(posts).toHaveLength(2);
  expect(posts[1]).not.toBe(posts[0]);
});

test('older messages with the same words never stand in for a send that failed, even after coming back', async () => {
  const { open } = await openChat(
    [
      ...finished(),
      frame('message.posted', { messageId: 'm3', role: 'user', text: 'Try again', at: 3000 }),
      frame('message.posted', { messageId: 'm4', role: 'assistant', text: 'Tried.', at: 4000 }),
    ],
    async () => new Response('{}', { status: 500 }),
  );
  await screen.findByText('Tried.');
  await fireEvent.changeText(screen.getByTestId('field-Keep the conversation going'), 'Try again');
  await fireEvent.press(screen.getByTestId('button-Send message'));
  expect(await screen.findByText('Not sent')).toBeTruthy();
  // The screen reader hears where it stands, with the words.
  expect(screen.getByLabelText('You: Try again (Not sent)')).toBeTruthy();
  await open('c2');
  await screen.findByText('Docs');
  await open('c1');
  await screen.findByText('Tried.');
  expect(screen.getByText('Not sent')).toBeTruthy();
  // Kept for as long as the app runs: deleted here, so the next test starts without it.
  await fireEvent.press(screen.getByRole('button', { name: 'Delete' }));
});

test('a request of an earlier visit that ends late does not clear a newer send', async () => {
  const posts: string[] = [];
  const answers: Array<(response: Response) => void> = [];
  const { open } = await openChat(finished(), (body) => {
    posts.push(body.clientMessageId);
    return new Promise((resolve) => {
      answers.push(resolve);
    });
  });
  await screen.findByText('Fixed.');
  const field = () => screen.getByTestId('field-Keep the conversation going');
  await fireEvent.changeText(field(), 'Also update the docs');
  await fireEvent.press(screen.getByTestId('button-Send message'));
  // Away and back while it is still on its way: it is offered again, and deleted.
  await open('c2');
  await screen.findByText('Docs');
  await open('c1');
  await fireEvent.press(await screen.findByRole('button', { name: 'Delete' }));
  await fireEvent.changeText(field(), 'Thanks');
  await fireEvent.press(screen.getByTestId('button-Send message'));
  expect(screen.getByLabelText('You: Thanks (Sending…)')).toBeTruthy();
  // The first request ends now, after all; the second fails.
  await act(async () => answers[0]?.(Response.json({})));
  await act(async () => answers[1]?.(new Response('{}', { status: 503 })));
  expect(await screen.findByText('Not sent')).toBeTruthy();
  await open('c2');
  await screen.findByText('Docs');
  await open('c1');
  expect(await screen.findByText('Not sent')).toBeTruthy();
  expect(screen.getByText('Thanks')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Send again' }));
  expect(posts).toHaveLength(3);
  expect(posts[2]).toBe(posts[1]);
  expect(posts[1]).not.toBe(posts[0]);
});
