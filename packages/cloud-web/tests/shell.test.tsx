import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App, NotificationsPanel, Settings, Shell } from '../src/App';
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
  expect(names).toEqual(['Home', 'Chat', 'Projects', 'Settings']);
  expect(within(nav).getByRole('button', { name: 'Chat' }).getAttribute('aria-current')).toBe(
    'page',
  );
  expect(within(nav).getByRole('button', { name: 'Home' }).getAttribute('aria-current')).toBeNull();
  fireEvent.click(within(nav).getByRole('button', { name: 'Settings' }));
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
  expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
  const choice = screen.getByRole('group', { name: 'Color mode' });
  expect(within(choice).getByRole('button', { name: 'Light' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  fireEvent.click(within(choice).getByRole('button', { name: 'Dark' }));
  expect(within(choice).getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
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
