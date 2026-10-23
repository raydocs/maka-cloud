import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App, NotificationsPanel, Settings, Shell } from '../src/App';
import { LanguageProvider, type Language } from '../src/i18n';
import { Home } from '../src/Home';
import { CloudClient, type Conversation } from '@maka-cloud/client';
import { readMode, ThemeProvider, useMode } from '../src/theme';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});
beforeEach(() => localStorage.clear());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function ModeProbe() {
  const { mode, setMode } = useMode();
  return (
    <>
      <span data-testid="mode">{mode}</span>
      <button type="button" onClick={() => setMode('dark')}>
        go dark
      </button>
    </>
  );
}

test('light is the default, a choice is kept in this browser and sets the page scheme', async () => {
  const { unmount } = render(
    <ThemeProvider>
      <ModeProbe />
    </ThemeProvider>,
  );
  expect(screen.getByTestId('mode').textContent).toBe('light');
  await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('light'));
  fireEvent.click(screen.getByText('go dark'));
  expect(screen.getByTestId('mode').textContent).toBe('dark');
  await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
  expect(localStorage.getItem('maka.theme')).toBe('dark');
  unmount();
  expect(readMode()).toBe('dark');
});

test('with no stored choice the device decides, and a change of its setting is followed', async () => {
  let dark = true;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query === '(prefers-color-scheme: dark)' && dark;
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  expect(readMode()).toBe('dark');
  render(
    <ThemeProvider>
      <ModeProbe />
    </ThemeProvider>,
  );
  expect(screen.getByTestId('mode').textContent).toBe('dark');
  await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
  dark = false;
  act(() => {
    for (const listener of listeners) listener();
  });
  expect(screen.getByTestId('mode').textContent).toBe('light');
  // A stored choice wins over the device.
  fireEvent.click(screen.getByText('go dark'));
  expect(screen.getByTestId('mode').textContent).toBe('dark');
});

test('a browser that refuses storage still gets light and can still switch', async () => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  });
  expect(readMode()).toBe('light');
  render(
    <ThemeProvider>
      <ModeProbe />
    </ThemeProvider>,
  );
  fireEvent.click(screen.getByText('go dark'));
  expect(screen.getByTestId('mode').textContent).toBe('dark');
});

test('a stored value that is not a known mode is light', () => {
  localStorage.setItem('maka.theme', 'neon');
  expect(readMode()).toBe('light');
});

test('the navigation marks the open section and moves between them', () => {
  const seen: string[] = [];
  render(
    <Shell view="chat" onView={(view) => seen.push(view)}>
      <p>content</p>
    </Shell>,
  );
  const nav = screen.getByRole('navigation', { name: 'Sections' });
  const names = within(nav)
    .getAllByRole('button')
    .map((button) => button.textContent);
  expect(names).toEqual(['Search', 'Home', 'Chat', 'Projects', 'Me']);
  expect(within(nav).getByRole('button', { name: 'Chat' }).getAttribute('aria-current')).toBe(
    'page',
  );
  expect(within(nav).getByRole('button', { name: 'Home' }).getAttribute('aria-current')).toBeNull();
  fireEvent.click(within(nav).getByRole('button', { name: 'Me' }));
  expect(seen).toEqual(['settings']);
});

const conversations: Conversation[] = Array.from({ length: 7 }, (_, i) => ({
  conversationId: `cnv_${i}`,
  title: `Plan ${i}`,
  createdAt: i,
}));

test('Home lists the five latest conversations, newest first, and opens the one tapped', () => {
  const opened: string[] = [];
  render(
    <Home
      client={new CloudClient('fake', async () => json({}))}
      conversations={conversations}
      onStarted={() => {}}
      onOpen={(id) => opened.push(id)}
    />,
  );
  const list = screen.getByRole('region', { name: 'Recent conversations' });
  expect(
    within(list)
      .getAllByRole('button')
      .map((b) => b.textContent),
  ).toEqual(['Plan 6', 'Plan 5', 'Plan 4', 'Plan 3', 'Plan 2']);
  fireEvent.click(within(list).getByRole('button', { name: 'Plan 4' }));
  expect(opened).toEqual(['cnv_4']);
});

test('Home with no conversations shows no recent list, and the start sentence is sent once', async () => {
  const calls: string[] = [];
  const started: Conversation[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return String(input).endsWith('/messages')
      ? json({ messageId: 'm1' })
      : json({ conversationId: 'cnv_new' });
  };
  render(
    <Home
      client={new CloudClient('fake', fetcher)}
      conversations={[]}
      onStarted={(c) => started.push(c)}
      onOpen={() => {}}
    />,
  );
  expect(screen.queryByRole('region', { name: 'Recent conversations' })).toBeNull();
  const start = screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement;
  expect(start.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('What would you like to get done?'), {
    target: { value: 'Fix the greeting' },
  });
  fireEvent.click(start);
  fireEvent.click(start);
  await waitFor(() => expect(started).toHaveLength(1));
  expect(calls.filter((c) => c.startsWith('POST') && c.endsWith('/messages'))).toHaveLength(1);
  expect(started[0]?.conversationId).toBe('cnv_new');
});

test('Settings holds appearance, memory, notifications and the way out', () => {
  let left = 0;
  render(
    <ThemeProvider>
      <Settings
        client={new CloudClient('fake', async () => json({}))}
        onDisconnect={() => (left += 1)}
      />
    </ThemeProvider>,
  );
  expect(screen.getByRole('heading', { name: 'Me' })).toBeTruthy();
  const choice = screen.getByRole('group', { name: 'Color mode' });
  const pressed = (name: string) =>
    within(choice).getByRole('button', { name }).getAttribute('aria-pressed');
  expect(pressed('System')).toBe('true');
  fireEvent.click(within(choice).getByRole('button', { name: 'Dark' }));
  expect(pressed('Dark')).toBe('true');
  expect(pressed('System')).toBe('false');
  expect(localStorage.getItem('maka.theme')).toBe('dark');
  // Back to System forgets the choice, so the device decides again.
  fireEvent.click(within(choice).getByRole('button', { name: 'System' }));
  expect(pressed('System')).toBe('true');
  expect(localStorage.getItem('maka.theme')).toBeNull();
  expect(screen.getByText('Memory')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Enable notifications' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
  expect(left).toBe(1);
});

test('notifications: a browser without push gets a plain hint, a server without push says so', async () => {
  const { unmount } = render(
    <NotificationsPanel client={new CloudClient('fake', async () => json({}))} />,
  );
  // jsdom has no service worker or push manager, as an old browser would not.
  fireEvent.click(screen.getByRole('button', { name: 'Enable notifications' }));
  await waitFor(() => expect(screen.getByText(/Notifications could not be enabled/u)).toBeTruthy());
  expect(screen.queryByText('Background notifications enabled')).toBeNull();
  unmount();

  const client = new CloudClient('fake', async () => json({}));
  client.unsupported.add('push');
  render(<NotificationsPanel client={client} />);
  expect(screen.getByText('Background notifications are unavailable on this server.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Enable notifications' })).toBeNull();
});

function signedIn(conversationList: Conversation[]) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/v1/conversations')) return json({ conversations: conversationList });
    return json({}, 404);
  });
}

test('someone with conversations lands in the latest one; a first visit lands on Home', async () => {
  signedIn([
    { conversationId: 'cnv_a', title: 'Older', createdAt: 1 },
    { conversationId: 'cnv_b', title: 'Latest', createdAt: 2 },
  ]);
  const { unmount } = render(
    <ThemeProvider>
      <App initialToken="token" />
    </ThemeProvider>,
  );
  const chat = await screen.findByRole('region', { name: 'Conversation' });
  expect(within(chat).getByRole('heading', { level: 1 }).textContent).toBe('Latest');
  // The switcher names the other conversations instead of repeating the open one's title.
  const picker = screen.getByRole('combobox', { name: 'Switch conversation' }) as HTMLSelectElement;
  expect([...picker.options].map((o) => o.textContent)).toEqual(['Switch conversation', 'Older']);
  fireEvent.change(picker, { target: { value: 'cnv_a' } });
  const switched = await screen.findByRole('region', { name: 'Conversation' });
  await waitFor(() =>
    expect(within(switched).getByRole('heading', { level: 1 }).textContent).toBe('Older'),
  );
  unmount();

  signedIn([]);
  render(
    <ThemeProvider>
      <App initialToken="token" />
    </ThemeProvider>,
  );
  expect(await screen.findByLabelText('What would you like to get done?')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Conversation' })).toBeNull();
});

test('task-only links resolve conversation 21 and report an unavailable task in all languages', async () => {
  const conversations = Array.from({ length: 21 }, (_, i) => ({
    conversationId: `cnv_${i}`,
    title: `Chat ${i}`,
    createdAt: i,
  }));
  const task = {
    taskId: 'deep',
    title: 'Deep task',
    state: 'succeeded',
    createdAt: 0,
    progress: [],
    cancelRequested: false,
    pauseRequested: false,
  };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/v1/conversations')) return json({ conversations });
    if (url.endsWith('/v1/tasks/deep/conversation')) return json({ conversationId: 'cnv_0', task });
    return json({}, 404);
  });
  window.history.replaceState(null, '', '/?task=deep');
  const { unmount } = render(<App initialToken="token" />);
  expect(await screen.findByRole('article', { name: 'Task: Deep task' })).toBeTruthy();
  unmount();
  for (const [language, note] of [
    ['en', "Couldn't find that task."],
    ['zh-Hans', '找不到该任务。'],
    ['zh-Hant', '找不到該任務。'],
  ]) {
    localStorage.setItem('maka.language', language);
    window.history.replaceState(null, '', '/?task=missing');
    const mounted = render(
      <LanguageProvider language={language as Language}>
        <App initialToken="token" />
      </LanguageProvider>,
    );
    expect(await screen.findByText(note)).toBeTruthy();
    mounted.unmount();
  }
  window.history.replaceState(null, '', '/');
});

test('app acknowledges worker links after accepting their same-origin destination', async () => {
  const listeners = new Map<string, EventListener>();
  vi.stubGlobal('navigator', {
    ...navigator,
    serviceWorker: {
      addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    },
  });
  render(<App />);
  const postMessage = vi.fn(() => {
    expect(window.location.search).not.toBe('?task=one');
  });
  const port = {
    postMessage,
    onmessage: undefined as ((event: MessageEvent) => void) | undefined,
    close: vi.fn(),
  };
  act(() =>
    listeners.get('message')?.({
      origin: window.location.origin,
      data: { type: 'maka.open', path: '/?task=one', id: 1 },
      ports: [port],
    } as unknown as Event),
  );
  expect(postMessage).toHaveBeenCalledWith({ type: 'maka.open.ack', id: 1 });
  expect(window.location.search).not.toBe('?task=one');
  act(() => port.onmessage?.({ data: { type: 'maka.open.go', id: 2 } } as MessageEvent));
  expect(window.location.search).not.toBe('?task=one');
  act(() => port.onmessage?.({ data: { type: 'maka.open.go', id: 1 } } as MessageEvent));
  expect(window.location.search).toBe('?task=one');
  postMessage.mockClear();
  act(() =>
    listeners.get('message')?.({
      origin: window.location.origin,
      data: { type: 'maka.open', path: 'https://evil.example/' },
      ports: [{ postMessage }],
    } as unknown as Event),
  );
  expect(postMessage).not.toHaveBeenCalled();
  window.history.replaceState(null, '', '/');
});

test.each([
  [401, 'Your invite is no longer valid. Please reconnect.'],
  [429, 'Too many requests. Try again in a moment.'],
  [500, 'Could not complete the request (500). Try again.'],
  [0, 'Could not complete the request. Check your connection and try again.'],
])('task link preserves the error for status %s', async (status, note) => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/v1/conversations')) return json({ conversations: [] });
    if (url.endsWith('/v1/tasks/broken/conversation')) {
      if (!status) throw new TypeError('offline');
      return json({}, status);
    }
    return json({}, 404);
  });
  window.history.replaceState(null, '', '/?task=broken');
  render(
    <LanguageProvider language="en">
      <App initialToken="token" />
    </LanguageProvider>,
  );
  expect(await screen.findByText(note)).toBeTruthy();
  expect(screen.queryByText("Couldn't find that task.")).toBeNull();
  window.history.replaceState(null, '', '/');
});

test('a failed readiness report does not turn successfully enabled notifications off', async () => {
  const subscription = {
    toJSON: () => ({
      endpoint: 'https://push.example/device',
      keys: { p256dh: 'key', auth: 'auth' },
    }),
  };
  vi.stubGlobal('Notification', { requestPermission: async () => 'granted' });
  vi.stubGlobal('PushManager', class {});
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: async () => {},
      ready: Promise.resolve({ pushManager: { getSubscription: async () => subscription } }),
    },
  });
  try {
    const client = new CloudClient('token', (async (url) => {
      if (String(url).endsWith('/v1/push/key')) return json({ publicKey: 'AQ' });
      if (String(url).endsWith('/v1/home/setup')) return json({ error: 'unavailable' }, 503);
      return json({});
    }) as typeof fetch);
    render(<NotificationsPanel client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Enable notifications' }));
    expect(await screen.findByText('Background notifications enabled')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  } finally {
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
  }
});

test('the first-message setup action focuses the visible chat composer', async () => {
  signedIn([]);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/v1/conversations')) return json({ conversations: [] });
    if (url.endsWith('/v1/home'))
      return json({
        cards: [],
        readiness: { completed: [], cards: [{ id: 'conversation', action: 'chat' }] },
      });
    return json({}, 404);
  });
  render(
    <ThemeProvider>
      <App initialToken="token" />
    </ThemeProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Send your first message' }));
  await waitFor(() => expect(document.activeElement?.closest('.chat-dock')).toBeTruthy());
  expect(document.activeElement?.tagName).toBe('TEXTAREA');
});

test.each(['en', 'zh-Hans', 'zh-Hant'])(
  'signed-in app load restores an existing push subscription in %s',
  async (language) => {
    localStorage.setItem('maka.language', language);
    const subscription = {
      endpoint: 'https://push.example/one',
      keys: { p256dh: 'key', auth: 'auth' },
    };
    const postMessage = vi.fn();
    vi.stubGlobal('PushManager', class {});
    const requestPermission = vi.fn();
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission });
    vi.stubGlobal('navigator', {
      serviceWorker: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        getRegistration: async () => ({
          active: { postMessage },
          pushManager: { getSubscription: async () => ({ toJSON: () => subscription }) },
        }),
      },
    });
    const register = vi.fn();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/conversations')) return json({ conversations: [] });
      if (url.endsWith('/v1/me')) return json({ accountTag: 'restored-tag' });
      if (url.endsWith('/v1/push/subscriptions') && init?.method === 'POST') {
        register(JSON.parse(init.body as string));
        return json({ accountTag: 'restored-tag' });
      }
      return json({}, 404);
    });
    render(
      <ThemeProvider>
        <App initialToken="token" />
      </ThemeProvider>,
    );
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        type: 'maka.subscription',
        accountTag: 'restored-tag',
      }),
    );
    expect(register).toHaveBeenCalledExactlyOnceWith(subscription);
    expect(requestPermission).not.toHaveBeenCalled();
  },
);
