import type { HomeCard, HomeSnapshot, InboxItem, TaskView } from '@maka-cloud/client';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { AppState, type AppStateStatus, Text } from 'react-native';
import Home from '@/app/(tabs)/index';
import { SessionProvider, useSession } from '@/lib/session';
import { partOfDay, todayOf, WORKING_REFRESH_MS } from '@/lib/today';

// Home runs outside a navigator here; a test focuses and blurs it by hand.
const mockFocus: { effect?: () => undefined | (() => void) } = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: () => {} }),
  useFocusEffect: (effect: () => undefined | (() => void)) => {
    mockFocus.effect = effect;
  },
}));

const fetchMock = () => (globalThis as unknown as { __fetch: jest.Mock }).__fetch;

const NOW = Date.now();

const item = (itemId: string, over: Partial<InboxItem> = {}): InboxItem => ({
  itemId,
  kind: 'approval',
  conversationId: 'c1',
  taskId: 't-run',
  ask: `Run "git push" for ${itemId}?`,
  options: [
    { id: 'deny', label: 'Deny', recommended: false },
    { id: 'approve', label: 'Approve', recommended: true },
  ],
  allowText: false,
  evidence: [],
  state: 'open',
  closeReason: null,
  preconditionHash: 'h',
  version: 1,
  interrupts: false,
  delivery: 'none',
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const task = (taskId: string, over: Partial<TaskView> = {}): TaskView => ({
  taskId,
  state: 'running',
  createdAt: NOW - 600_000,
  progress: [],
  cancelRequested: false,
  pauseRequested: false,
  ...over,
});

const card = (cardId: string, over: Partial<HomeCard>): HomeCard => ({
  cardId,
  kind: 'waiting',
  ref: { type: 'inbox', id: cardId },
  rank: 0,
  seenAt: null,
  at: NOW,
  ...over,
});

const TASKS: TaskView[] = [
  task('t-run', {
    title: 'Update the changelog',
    startedAt: NOW - 300_000,
    narration: 'Reading the release notes',
  }),
  // A subtask is part of its parent's story, not a line of its own.
  task('t-sub', { title: 'A subtask', parentTaskId: 't-run' }),
  task('t-done', {
    title: 'Tag the release',
    state: 'succeeded',
    finishedAt: NOW - 60_000,
    manifest: { summary: 'Tagged v1.2.0.' } as TaskView['manifest'],
    costUsd: 0.5,
  }),
];

const CARDS: HomeCard[] = [
  card('waiting:i1', { ref: { type: 'inbox', id: 'i1' } }),
  // An item this phone has not read is left out, and not reported as seen.
  card('waiting:gone', { ref: { type: 'inbox', id: 'gone' } }),
  card('finished:t-done', {
    kind: 'finished',
    ref: { type: 'task', id: 't-done', conversationId: 'c1' },
    state: 'succeeded',
  }),
  // A task of a conversation this phone did not read: the server's word for how it ended.
  card('finished:t-far', {
    kind: 'finished',
    ref: { type: 'task', id: 't-far', conversationId: 'c9' },
    state: 'failed',
  }),
  card('note:n1', {
    kind: 'note',
    ref: { type: 'note', id: 'n1' },
    text: 'example/site #12 was merged.',
  }),
  // A duty of a project that is not listed is left out.
  card('scheduled:d1', { kind: 'scheduled', ref: { type: 'duty', id: 'd1', projectId: 'p1' } }),
];

const snapshot = (over: Partial<HomeSnapshot>): HomeSnapshot => ({
  items: {},
  busy: false,
  inboxLoaded: true,
  inboxFailed: false,
  answerError: '',
  since: NOW - 86_400_000,
  done: undefined,
  projects: undefined,
  cards: undefined,
  ...over,
});

test('with the server’s cards: their order, only what this phone can show, and those named as shown', () => {
  const today = todayOf(
    snapshot({
      items: {
        i1: item('i1'),
        i2: item('i2', { state: 'closed' }),
      },
      done: new Map([['c1', TASKS]]),
      cards: [...CARDS, card('waiting:i2', { ref: { type: 'inbox', id: 'i2' } })],
    }),
    [{ conversationId: 'c1', title: 'Release', createdAt: 1 }],
    NOW,
  );
  expect(today.needs.map((i) => i.itemId)).toEqual(['i1']);
  expect(today.working.map((row) => row.task.taskId)).toEqual(['t-run']);
  expect(today.since).toEqual([
    {
      kind: 'task',
      key: 'finished:t-done',
      conversationId: 'c1',
      title: 'Tag the release',
      outcome: 'Tagged v1.2.0.',
      ownWords: true,
      tone: 'ok',
      costUsd: 0.5,
    },
    {
      kind: 'task',
      key: 'finished:t-far',
      conversationId: 'c9',
      title: undefined,
      outcome: 'It did not finish.',
      ownWords: false,
      tone: 'bad',
      costUsd: undefined,
    },
    { kind: 'note', key: 'note:n1', text: 'example/site #12 was merged.' },
  ]);
  expect(today.next).toEqual([]);
  expect(today.shown).toEqual(['waiting:i1', 'finished:t-done', 'finished:t-far', 'note:n1']);
});

test('a scheduled card shows its duty once the project is read', () => {
  const today = todayOf(
    snapshot({
      projects: [
        {
          projectId: 'p1',
          repo: 'example/site',
          defaultBranch: 'main',
          duties: [
            {
              dutyId: 'd1',
              name: 'Nightly checks',
              state: 'active',
              activatedAt: NOW - 1000,
              trigger: { kind: 'schedule', everyMinutes: 60 },
            },
          ],
        },
      ] as unknown as HomeSnapshot['projects'],
      cards: [CARDS[5] as HomeCard],
    }),
    [],
    NOW,
  );
  expect(today.next).toEqual([
    { dutyId: 'd1', name: 'Nightly checks', repo: 'example/site', at: NOW },
  ]);
  expect(today.shown).toEqual(['scheduled:d1']);
});

test('on a server without Home cards: decisions before suggestions, what ended since the last visit', () => {
  const today = todayOf(
    snapshot({
      items: {
        s1: item('s1', { kind: 'suggestion', updatedAt: 9 }),
        i1: item('i1', { updatedAt: 2 }),
      },
      done: new Map([['c1', TASKS]]),
    }),
    [],
    NOW,
  );
  expect(today.needs.map((i) => i.itemId)).toEqual(['i1', 's1']);
  expect(today.since.map((row) => row.key)).toEqual(['t-done']);
  // Nothing to tell the server: it keeps no cards.
  expect(today.shown).toEqual([]);
});

test('the greeting follows the phone’s clock', () => {
  const at = (hour: number) => new Date(2026, 9, 23, hour).getTime();
  expect(partOfDay(at(8))).toBe('morning');
  expect(partOfDay(at(14))).toBe('afternoon');
  expect(partOfDay(at(20))).toBe('evening');
  expect(partOfDay(at(2))).toBe('evening');
});

let api: ReturnType<typeof useSession>;
let seen: Array<{ cardIds: string[] }> = [];

/** Home, signed in to a server with the routes given (and nothing else). */
async function home(routes: Record<string, () => Response>) {
  seen = [];
  fetchMock().mockImplementation(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    if (path === '/v1/home/seen') {
      seen.push(JSON.parse(String(init.body)));
      return Response.json({ seen: [], visitedAt: NOW });
    }
    const route = routes[path];
    if (route) return route();
    if (path === '/v1/conversations') return Response.json({ conversations: [] });
    return new Response('{}', { status: 404 });
  });
  function Gate() {
    api = useSession();
    return api.session.status === 'in' ? <Home /> : <Text>out</Text>;
  }
  await render(
    <SessionProvider>
      <Gate />
    </SessionProvider>,
  );
  await screen.findByText('out');
  await act(async () => {
    await api.signIn('maka.example.com', 'invite-token');
  });
}

const busyServer = {
  '/v1/conversations': () =>
    Response.json({ conversations: [{ conversationId: 'c1', title: 'Release', createdAt: 1 }] }),
  '/v1/conversations/c1/tasks': () => Response.json({ tasks: TASKS }),
  '/v1/inbox/items': () => Response.json({ items: [item('i1')] }),
  '/v1/home': () => Response.json({ cards: CARDS }),
};

test('Home reads as a day: date and greeting, needs you, working now, since you were last here', async () => {
  await home(busyServer);
  await screen.findByText('Tag the release');
  await screen.findByText('Update the changelog');
  const headers = screen
    .getAllByRole('header')
    .map((node) => node.props.testID as string | undefined)
    .filter((id) => id !== undefined);
  expect(headers).toEqual(['home-today-title', 'home-waiting-1', 'home-working', 'home-since']);
  expect(screen.getByTestId('home-date')).toBeTruthy();
  // Working now: the live line and when it began; the subtask is not a row of its own.
  expect(screen.getByText('Reading the release notes')).toBeTruthy();
  expect(screen.queryByText('A subtask')).toBeNull();
  // Since you were last here: a result, an ending in the app's words, a note in the server's.
  expect(screen.getByText('Tagged v1.2.0.')).toBeTruthy();
  expect(screen.getByLabelText('Cost: $0.50')).toBeTruthy();
  expect(screen.getByText('It did not finish.')).toBeTruthy();
  expect(screen.getByText('example/site #12 was merged.')).toBeTruthy();
  // The attention colour is only where something needs the person.
  const needs = screen.getByLabelText('Decisions waiting');
  const hidden = { includeHiddenElements: true };
  const inNeeds = within(needs).getAllByTestId('mark-attention', hidden);
  expect(inNeeds.length).toBeGreaterThan(0);
  expect(screen.getAllByTestId('mark-attention', hidden)).toHaveLength(inNeeds.length);
  // No hero pitch, no dashes, no ideas on a busy day, no recent-conversation tiles.
  expect(screen.queryByText('Make room for your next idea.')).toBeNull();
  expect(screen.queryByText(/^[–—-]$/u)).toBeNull();
  expect(screen.queryByTestId('button-home.idea.1')).toBeNull();
  expect(screen.queryByText('Pick up where you left off')).toBeNull();
});

test('leaving Home tells the server the cards it showed, once; an inactive blip does not', async () => {
  let onState: ((state: AppStateStatus) => void) | undefined;
  const before = jest.mocked(AppState.addEventListener).getMockImplementation();
  const listen = jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
    onState = handler as (state: AppStateStatus) => void;
    return { remove: () => {} } as ReturnType<typeof AppState.addEventListener>;
  });
  try {
    await home(busyServer);
    await screen.findByText('Tag the release');
    // Not on screen: going to the background is not leaving Home.
    await act(async () => onState?.('background'));
    expect(seen).toEqual([]);

    let blur: undefined | (() => void);
    await act(async () => {
      blur = mockFocus.effect?.() ?? undefined;
    });
    await act(async () => onState?.('inactive'));
    expect(seen).toEqual([]);

    await act(async () => onState?.('background'));
    await act(async () => blur?.());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    // The unread item and the unlisted duty were never on the screen.
    expect(seen).toEqual([
      { cardIds: ['waiting:i1', 'finished:t-done', 'finished:t-far', 'note:n1'] },
    ]);
  } finally {
    // React Native's own test mock of AppState stays a mock; it gets its behaviour back.
    if (before) listen.mockImplementation(before);
    else listen.mockRestore();
  }
});

test('coming back to Home reads it again, so leaving again is a new visit', async () => {
  await home(busyServer);
  await screen.findByText('Tag the release');
  let blur: undefined | (() => void);
  await act(async () => {
    blur = mockFocus.effect?.() ?? undefined;
  });
  await act(async () => blur?.());
  await act(async () => {
    blur = mockFocus.effect?.() ?? undefined;
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  await act(async () => blur?.());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(seen).toHaveLength(2);
});

test('while something works and Home is on screen, Home is read again', async () => {
  const timers: Array<{ run: () => void; ms: number | undefined }> = [];
  const every = jest.spyOn(globalThis, 'setInterval').mockImplementation(((
    run: () => void,
    ms?: number,
  ) => {
    timers.push({ run, ms });
    return 0 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval);
  try {
    let reads = 0;
    await home({
      ...busyServer,
      '/v1/conversations/c1/tasks': () => {
        reads += 1;
        return Response.json({ tasks: TASKS });
      },
    });
    await screen.findByText('Update the changelog');
    // Not on screen yet: nothing is scheduled.
    expect(timers.filter((t) => t.ms === WORKING_REFRESH_MS)).toEqual([]);
    await act(async () => {
      mockFocus.effect?.();
    });
    const tick = timers.find((t) => t.ms === WORKING_REFRESH_MS);
    expect(tick).toBeDefined();
    const before = reads;
    await act(async () => tick?.run());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(reads).toBeGreaterThan(before);
  } finally {
    every.mockRestore();
  }
});

test('a first visit is calm: a greeting, one line and three ideas that fill the composer', async () => {
  await home({ '/v1/inbox/items': () => Response.json({ items: [] }) });
  expect(
    await screen.findByText('What needs you, what is running and what is done will gather here.'),
  ).toBeTruthy();
  expect(['Good morning.', 'Good afternoon.', 'Good evening.']).toContain(
    screen.getByTestId('home-today-title').props.children,
  );
  const ideas = ['home.idea.1', 'home.idea.2', 'home.idea.3'].map((id) =>
    screen.getByTestId(`button-${id}`),
  );
  expect(ideas).toHaveLength(3);
  // Nothing waits and nothing has run: no empty sections.
  expect(screen.queryByTestId(/^home-waiting/u)).toBeNull();
  expect(screen.queryByTestId('home-working')).toBeNull();
  expect(screen.queryByTestId('home-since')).toBeNull();
  await fireEvent.press(ideas[1] as never);
  expect(screen.getByTestId('field-What would you like to get done?').props.value).toBe(
    'Review my latest open pull request',
  );
});
