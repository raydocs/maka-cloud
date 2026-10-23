import type { TaskView } from '@maka-cloud/client';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Dimensions, Keyboard, type KeyboardEvent, Platform, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Chat from '@/app/(tabs)/chat';
import Projects from '@/app/(tabs)/projects';
import Me from '@/app/me';
import Search from '@/app/search';
import { Composer, ConversationSheet, Dock } from '@/components/Composer';
import { TaskRow } from '@/components/TaskRow';
import { Screen, StatusMark, Thinking, Tile } from '@/components/ui';
import { ReduceMotion } from '@/lib/appearance';
import { SessionProvider, useSession } from '@/lib/session';
import { DARK, LIGHT, type Palette, ThemeContext } from '@/lib/theme';

const mockRouter = { navigate: jest.fn(), push: jest.fn(), dismissTo: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => ({
  useRouter: () => ({ ...mockRouter, canGoBack: () => true }),
  useFocusEffect: () => {},
}));

const fetchMock = () => (globalThis as unknown as { __fetch: jest.Mock }).__fetch;
const flat = (style: unknown) => Object.assign({}, ...[style].flat(Number.POSITIVE_INFINITY));

type Route = (method: string, body: unknown) => Response | Promise<Response>;
let calls: Array<{ method: string; path: string }> = [];
let api: ReturnType<typeof useSession> | undefined;

/** Signed in to a server that answers `routes` by path (and the conversation list), in a theme. */
async function signedIn(node: ReactElement, routes: Record<string, Route>, theme: Palette = LIGHT) {
  calls = [];
  fetchMock().mockImplementation(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? 'GET';
    calls.push({ method, path });
    const route = routes[path];
    if (route) return route(method, init.body ? JSON.parse(String(init.body)) : undefined);
    if (path === '/v1/conversations') return Response.json({ conversations: [] });
    return new Response('{}', { status: 404 });
  });
  function Gate() {
    api = useSession();
    return api.session.status === 'in' ? node : <Text>out</Text>;
  }
  await render(
    <ThemeContext.Provider value={theme}>
      <SessionProvider>
        <Gate />
      </SessionProvider>
    </ThemeContext.Provider>,
  );
  await screen.findByText('out');
  await act(async () => {
    await api?.signIn('maka.example.com', 'invite-token');
  });
}

test.each([
  ['light', LIGHT],
  ['dark', DARK],
])('Chat follows the appearance (%s): no dark slab of its own', async (_, theme) => {
  await signedIn(<Chat />, {}, theme);
  const heading = await screen.findByText('What would you like to get done?');
  expect(flat(heading.props.style).color).toBe(theme.ink);
});

test('the empty Chat scrolls, so large text or the keyboard never hides its ideas', async () => {
  await signedIn(<Chat />, {});
  const scroller = await screen.findByTestId('new-conversation');
  expect(scroller.props.keyboardShouldPersistTaps).toBe('handled');
  expect(within(scroller).getByTestId('button-home.idea.1')).toBeTruthy();
});

test('Projects lists each repository with its branch and duties', async () => {
  await signedIn(<Projects />, {
    '/v1/projects': () =>
      Response.json({
        projects: [
          {
            projectId: 'p1',
            repo: 'example/site',
            defaultBranch: 'main',
            duties: [
              { dutyId: 'd1', name: 'Nightly checks', state: 'active' },
              { dutyId: 'd2', name: 'Dependency bumps', state: 'proposed' },
            ],
          },
        ],
      }),
  });
  expect(await screen.findByText('example/site')).toBeTruthy();
  expect(screen.getByText('Default branch: main · Standing duties: 2')).toBeTruthy();
  expect(screen.getByText('Nightly checks')).toBeTruthy();
  expect(screen.getByText('On')).toBeTruthy();
  expect(screen.getByText('Waiting for you')).toBeTruthy();
  // The composer is here too.
  expect(screen.getByTestId('field-Keep the conversation going')).toBeTruthy();
});

test('Projects on a server without them says so', async () => {
  await signedIn(<Projects />, {});
  expect(await screen.findByText('This server does not list projects.')).toBeTruthy();
});

test('Me holds memory and kept approvals when the server has them; each can be removed', async () => {
  let facts = [{ id: 'f1', text: 'Prefers short answers.' }];
  let grants = [
    {
      grantId: 'g1',
      tool: 'Bash',
      repository: 'example/site',
      scope: 'repository',
      createdAt: 1,
      expiresAt: 2,
      uses: 0,
      lastUsedAt: null,
    },
  ];
  await signedIn(<Me />, {
    '/v1/memory': () => Response.json({ facts, summaries: [] }),
    '/v1/memory/facts/f1': (method) => {
      if (method === 'DELETE') facts = [];
      return new Response(null, { status: 204 });
    },
    '/v1/inbox/grants': () => Response.json({ grants }),
    '/v1/inbox/grants/g1': (method) => {
      if (method === 'DELETE') grants = [];
      return new Response(null, { status: 204 });
    },
  });
  expect(await screen.findByText('Prefers short answers.')).toBeTruthy();
  expect(await screen.findByText('Bash · example/site')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Forget: Prefers short answers.' }));
  expect(await screen.findByText('Nothing remembered yet.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Revoke: Bash in example/site' }));
  expect(await screen.findByText('No kept approvals.')).toBeTruthy();
  expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
    '/v1/memory/facts/f1',
    '/v1/inbox/grants/g1',
  ]);
});

test('Me leaves out memory and kept approvals where the server keeps neither', async () => {
  await signedIn(<Me />, {});
  expect(await screen.findByText('Appearance')).toBeTruthy();
  expect(screen.queryByText('Memory')).toBeNull();
  expect(screen.queryByText('Kept approvals')).toBeNull();
});

test('Me says when memory could not be loaded, and loads it again on retry', async () => {
  let down = true;
  await signedIn(<Me />, {
    '/v1/memory': () =>
      down
        ? Response.json({ error: 'internal' }, { status: 500 })
        : Response.json({ facts: [{ id: 'f1', text: 'Prefers short answers.' }], summaries: [] }),
    '/v1/inbox/grants': () => Response.json({ grants: [] }),
  });
  expect(await screen.findByText('This could not be loaded.')).toBeTruthy();
  expect(screen.getByText('Memory')).toBeTruthy();
  down = false;
  await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Prefers short answers.')).toBeTruthy();
  expect(screen.queryByText('This could not be loaded.')).toBeNull();
});

test('a failed refresh keeps the kept approvals already shown, and says so', async () => {
  const grant = {
    grantId: 'g1',
    tool: 'Bash',
    repository: 'example/site',
    scope: 'repository',
    createdAt: 1,
    expiresAt: 2,
    uses: 0,
    lastUsedAt: null,
  };
  let reads = 0;
  await signedIn(<Me />, {
    '/v1/inbox/grants': () => {
      reads += 1;
      return reads === 1
        ? Response.json({ grants: [grant] })
        : Response.json({ error: 'internal' }, { status: 500 });
    },
    '/v1/inbox/grants/g1': () => new Response(null, { status: 204 }),
  });
  expect(await screen.findByText('Bash · example/site')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Revoke: Bash in example/site' }));
  expect(await screen.findByText('This could not be loaded.')).toBeTruthy();
  expect(screen.getByText('Bash · example/site')).toBeTruthy();
});

test('while a message is on its way the field cannot be typed in, so nothing typed is lost', async () => {
  const field = (sending: boolean) => (
    <ThemeContext.Provider value={LIGHT}>
      <Composer
        draft="Hello"
        onDraft={() => {}}
        sending={sending}
        disabled={sending}
        onSend={() => {}}
      />
    </ThemeContext.Provider>
  );
  await render(field(true));
  expect(screen.getByTestId('field-Keep the conversation going').props.editable).toBe(false);
  await screen.rerender(field(false));
  expect(screen.getByTestId('field-Keep the conversation going').props.editable).toBe(true);
});

test.each([
  [false, 'slide'],
  [true, 'none'],
])('the conversation sheet slides in unless Reduce Motion is on (%s)', async (reduce, kind) => {
  await signedIn(
    <ReduceMotion.Provider value={reduce}>
      <ConversationSheet visible onClose={() => {}} />
    </ReduceMotion.Provider>,
    {},
  );
  expect(
    screen.getByTestId('conversation-sheet', { includeHiddenElements: true }).props.animationType,
  ).toBe(kind);
});

// With no tab bar under the screens, every screen keeps clear of the bottom edge itself (the home
// indicator, Android's navigation), so the floating composer never sits under them.
// The composer floats (absolutely placed), so a keyboard-avoiding view's padding never moved it:
// on the iOS simulator the keyboard covered the field and Start. It is lifted by the keyboard's
// reach above the screen's safe bottom edge instead, and the room it reports grows with it.
test('on iOS the floating composer rides above the keyboard, and comes down when it hides', async () => {
  expect(Platform.OS).toBe('ios');
  const handlers: Partial<Record<string, (event: KeyboardEvent) => void>> = {};
  const listen = jest.spyOn(Keyboard, 'addListener').mockImplementation(((
    name: string,
    handler: (event: KeyboardEvent) => void,
  ) => {
    handlers[name] = handler;
    return { remove: jest.fn() };
  }) as never);
  try {
    const rooms: number[] = [];
    let safeBottom = -1;
    function Probe() {
      safeBottom = useSafeAreaInsets().bottom;
      return null;
    }
    await render(
      <ThemeContext.Provider value={LIGHT}>
        <Probe />
        <Dock height={0} onHeight={(room) => rooms.push(room)}>
          <Text>Composer</Text>
        </Dock>
      </ThemeContext.Provider>,
    );
    const dock = () => flat(screen.getByTestId('dock').props.style);
    expect(dock().bottom).toBe(0);
    await fireEvent(screen.getByTestId('dock'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 70 } },
    });
    expect(rooms.at(-1)).toBe(70);
    const window = Dimensions.get('window').height;
    const keyboard = (screenY: number, height: number) =>
      ({
        duration: 250,
        easing: 'keyboard',
        endCoordinates: { screenX: 0, screenY, width: 390, height },
      }) as KeyboardEvent;
    await act(async () => handlers.keyboardWillShow?.(keyboard(window - 336, 336)));
    const lift = 336 - safeBottom;
    expect(lift).toBeGreaterThan(0);
    expect(dock().bottom).toBe(lift);
    expect(rooms.at(-1)).toBe(70 + lift);
    await act(async () => handlers.keyboardWillHide?.(keyboard(window, 0)));
    expect(dock().bottom).toBe(0);
    expect(rooms.at(-1)).toBe(70);
  } finally {
    listen.mockRestore();
  }
});

test('every screen keeps clear of the bottom edge', async () => {
  await render(
    <Screen>
      <Text>Inside</Text>
    </Screen>,
  );
  expect(screen.getByTestId('screen').props.edges).toEqual(
    expect.objectContaining({ top: 'additive', bottom: 'additive' }),
  );
});

test('while the first message is on its way, an idea cannot replace it', async () => {
  let land: (response: Response) => void = () => {};
  await signedIn(<Chat />, {
    '/v1/conversations': (method) =>
      method === 'POST'
        ? new Promise<Response>((resolve) => {
            land = resolve;
          })
        : Response.json({ conversations: [] }),
    '/v1/conversations/c-new/messages': () => Response.json({ messageId: 'm1' }),
  });
  const field = await screen.findByTestId('field-Keep the conversation going');
  await fireEvent.changeText(field, 'Write the release notes');
  await act(async () => {
    fireEvent.press(screen.getByTestId('button-Send message'));
  });
  const idea = screen.getByTestId('button-home.idea.1');
  expect(idea.props.accessibilityState).toMatchObject({ disabled: true });
  await fireEvent.press(idea);
  expect(screen.getByTestId('field-Keep the conversation going').props.value).toBe(
    'Write the release notes',
  );
  await act(async () => {
    land(Response.json({ conversationId: 'c-new' }));
  });
  expect(calls.filter((c) => c.path === '/v1/conversations/c-new/messages')).toHaveLength(1);
});

test("a disabled tile (Home's ideas while a conversation starts) cannot be pressed", async () => {
  const onPress = jest.fn();
  await render(
    <ThemeContext.Provider value={LIGHT}>
      <Tile title="Plan a trip" disabled onPress={onPress} />
    </ThemeContext.Provider>,
  );
  const tile = screen.getByRole('button', { name: 'Plan a trip' });
  expect(tile.props.accessibilityState).toMatchObject({ disabled: true });
  await fireEvent.press(tile);
  expect(onPress).not.toHaveBeenCalled();
});

test('Search says when some tasks could not be read, never "nothing matches", and retries those', async () => {
  let down = true;
  await signedIn(<Search />, {
    '/v1/conversations': () =>
      Response.json({
        conversations: [{ conversationId: 'c1', title: 'Release notes', createdAt: 1 }],
      }),
    '/v1/conversations/c1/tasks': () =>
      down
        ? Response.json({ error: 'internal' }, { status: 500 })
        : Response.json({
            tasks: [
              {
                taskId: 't1',
                title: 'Fix the login loop',
                state: 'succeeded',
                createdAt: 1,
                progress: [],
                cancelRequested: false,
                pauseRequested: false,
              },
            ],
          }),
  });
  await fireEvent.changeText(await screen.findByTestId('field-Search'), 'login');
  expect(
    await screen.findByText('Some tasks could not be loaded, so results may be missing.'),
  ).toBeTruthy();
  expect(screen.queryByText('Nothing matches “login”.')).toBeNull();
  down = false;
  await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Fix the login loop')).toBeTruthy();
  expect(
    screen.queryByText('Some tasks could not be loaded, so results may be missing.'),
  ).toBeNull();
  expect(calls.filter((c) => c.path === '/v1/conversations/c1/tasks')).toHaveLength(2);
});

test('Search filters the conversations and tasks already on the phone, and opens a hit in Chat', async () => {
  mockRouter.dismissTo.mockClear();
  const task: TaskView = {
    taskId: 't1',
    title: 'Fix the login loop',
    state: 'succeeded',
    createdAt: 1,
    progress: [],
    cancelRequested: false,
    pauseRequested: false,
  };
  await signedIn(<Search />, {
    '/v1/conversations': () =>
      Response.json({
        conversations: [
          { conversationId: 'c1', title: 'Release notes', createdAt: 1 },
          { conversationId: 'c2', title: 'Login bug', createdAt: 2 },
        ],
      }),
    '/v1/conversations/c2/tasks': () => Response.json({ tasks: [task] }),
    '/v1/conversations/c1/tasks': () => Response.json({ tasks: [] }),
  });
  const field = await screen.findByTestId('field-Search');
  await fireEvent.changeText(field, 'login');
  expect(screen.getByText('Login bug')).toBeTruthy();
  expect(await screen.findByText('Fix the login loop')).toBeTruthy();
  expect(screen.queryByText('Release notes')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Fix the login loop' }));
  expect(api?.session.status === 'in' && api.session.chosen).toBe('c2');
  expect(mockRouter.dismissTo).toHaveBeenCalledWith('/chat');
  await fireEvent.changeText(field, 'nothing like this');
  expect(screen.getByText('Nothing matches “nothing like this”.')).toBeTruthy();
  // Only the server's own task lists were read; there is no search endpoint.
  expect(calls.some((c) => c.path.includes('search'))).toBe(false);
});

test('one attention colour, for what needs the person; done and failed are ink', async () => {
  await render(
    <ThemeContext.Provider value={LIGHT}>
      <StatusMark tone="attention" />
      <StatusMark tone="ok" />
      <StatusMark tone="bad" />
      <StatusMark tone="idle" />
    </ThemeContext.Provider>,
  );
  const style = (tone: string) =>
    flat(screen.getByTestId(`mark-${tone}`, { includeHiddenElements: true }).props.style);
  expect(style('attention').backgroundColor).toBe(LIGHT.warn);
  expect(style('ok').backgroundColor).toBe(LIGHT.ink);
  expect(style('bad').borderColor).toBe(LIGHT.ink);
  expect(style('idle').borderColor).toBe(LIGHT.inkMuted);
  for (const tone of ['ok', 'bad', 'idle']) {
    expect(style(tone).backgroundColor).not.toBe(LIGHT.bad);
    expect(style(tone).borderColor).not.toBe(LIGHT.warn);
  }
});

test('the thinking mark breathes, and is a still dot under Reduce Motion', async () => {
  const view = await render(
    <ReduceMotion.Provider value={false}>
      <Thinking />
    </ReduceMotion.Provider>,
  );
  expect(screen.getByTestId('thinking', { includeHiddenElements: true }).children).toHaveLength(2);
  await view.rerender(
    <ReduceMotion.Provider value>
      <Thinking />
    </ReduceMotion.Provider>,
  );
  expect(screen.getByTestId('thinking', { includeHiddenElements: true }).children).toHaveLength(1);
});

test('a work item carries a small tabular line: when, who, and the latest tool', async () => {
  const task: TaskView = {
    taskId: 't1',
    title: 'Tag the release',
    state: 'running',
    createdAt: Date.UTC(2026, 9, 22, 6, 5),
    progress: [],
    cancelRequested: false,
    pauseRequested: false,
    panels: [
      { panelId: 'a', kind: 'shell', state: 'passed', title: 'Install', summary: 'ok' },
      { panelId: 'b', kind: 'tests', state: 'running', title: 'Tests', summary: '' },
    ],
  };
  await render(
    <ThemeContext.Provider value={LIGHT}>
      <TaskRow task={task} tasks={[]} noPause={new Set()} busy={false} onControl={() => {}} />
    </ThemeContext.Provider>,
  );
  const meta = screen.getByTestId('task-meta');
  expect(meta.props.children).toMatch(/^\d{1,2}:\d{2}( [AP]M)? · Maka · Tests$/u);
  expect(flat(meta.props.style).fontVariant).toEqual(['tabular-nums']);
});
