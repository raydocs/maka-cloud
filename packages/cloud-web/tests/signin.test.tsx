import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CloudClient } from '@maka-cloud/client';
import { App } from '../src/App';
import { DevicesPanel } from '../src/Devices';
import { browserLabel } from '../src/SignIn';
import { ThemeProvider } from '../src/theme';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});
beforeEach(() => localStorage.clear());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const WAYS = { apple: true, google: true, email: true };

interface Call {
  route: string;
  body: Record<string, unknown> | undefined;
  auth: string | undefined;
  /** The request asked to be signed in by the session cookie. */
  cookie: boolean;
}

/**
 * The browser's cookie for this site, as the server sets it. The page can neither read nor write
 * it: only `session` answers set it and a sign-out clears it, as the real server does.
 */
const jar: { session?: string } = {};
beforeEach(() => {
  delete jar.session;
});

/** A sign-in answer that puts session `id` into the cookie and carries no token. */
const session = (id: string) => () => {
  jar.session = id;
  return json({ status: 'signed_in', sessionId: id });
};

/** A server that answers by route and remembers what it was asked. */
function serve(routes: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = {
      route: `${init.method ?? 'GET'} ${path}`,
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      auth: headers.Authorization,
      cookie: headers['X-Maka-Cookie'] === '1',
    };
    calls.push(call);
    const signedIn = call.cookie && jar.session !== undefined;
    if (call.route === 'GET /v1/me')
      return signedIn ? json({ ownerId: 'inv_1' }) : json({ error: 'unauthorized' }, 401);
    if (call.route === 'POST /v1/auth/sign-out' && signedIn) delete jar.session;
    const handler = routes[call.route];
    // The workspace's own routes answer a cookie request only while the cookie signs in.
    if (call.cookie && !call.route.includes('/v1/auth/') && !signedIn)
      return json({ error: 'unauthorized' }, 401);
    return handler ? handler(call) : json({}, 404);
  });
  return calls;
}

const mount = () =>
  render(
    <ThemeProvider>
      <App />
    </ThemeProvider>,
  );

const conversations = () => json({ conversations: [] });

test('the first screen offers an emailed code, not an invite-token box, and the box is one click away', async () => {
  serve({ 'GET /v1/auth/options': () => json(WAYS) });
  mount();
  await screen.findByLabelText('Email');
  expect(screen.getByRole('button', { name: 'Email me a code' })).toBeTruthy();
  expect(screen.queryByLabelText('Invite token')).toBeNull();
  // Apple's and Google's sheets are not on the web page yet.
  expect(screen.queryByRole('button', { name: 'Continue with Apple' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'I have an invite token' }));
  expect(screen.getByLabelText('Invite token')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Other ways to sign in' }));
  expect(await screen.findByLabelText('Email')).toBeTruthy();
});

test('an invite token still opens the workspace, and a wrong one is said under the box', async () => {
  serve({
    'GET /v1/auth/options': () => json(WAYS),
    'GET /v1/conversations': (call) =>
      call.auth === 'Bearer inv_good' ? conversations() : json({ error: 'unauthorized' }, 401),
  });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'I have an invite token' }));
  fireEvent.change(screen.getByLabelText('Invite token'), { target: { value: 'inv_bad' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enter your workspace' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Invite token'), { target: { value: 'inv_good' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enter your workspace' }));
  await screen.findByLabelText('What would you like to get done?');
});

test('email: a known address signs in with the code, and the session lives only in the cookie', async () => {
  const calls = serve({
    'GET /v1/auth/options': () => json(WAYS),
    'POST /v1/auth/email': () =>
      json({ challengeId: 'c1', deviceSecret: 'device-secret', expiresAt: 9 }),
    'POST /v1/auth/email/verify': session('s1'),
    'GET /v1/conversations': conversations,
  });
  mount();
  fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'ada@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
  await screen.findByText('Check your email');
  fireEvent.change(screen.getByLabelText('Code'), { target: { value: '123 456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByLabelText('What would you like to get done?');
  const verify = calls.find((c) => c.route === 'POST /v1/auth/email/verify');
  expect(verify?.body).toMatchObject({
    challengeId: 'c1',
    deviceSecret: 'device-secret',
    code: '123456',
  });
  expect(typeof verify?.body?.device).toBe('string');
  // every request asks for the cookie, and none carries a token the page could hold
  expect(calls.every((c) => c.cookie)).toBe(true);
  expect(calls.some((c) => c.auth !== undefined)).toBe(false);
  expect(calls.some((c) => c.route === 'GET /v1/conversations')).toBe(true);
});

test('email: a new person gives the invite code once and is then signed in', async () => {
  const calls = serve({
    'GET /v1/auth/options': () => json(WAYS),
    'POST /v1/auth/email': () => json({ challengeId: 'c1', deviceSecret: 's', expiresAt: 9 }),
    'POST /v1/auth/email/verify': () => json({ status: 'needs_invite', pendingToken: 'pnd_1' }),
    'POST /v1/auth/claim': session('s2'),
    'GET /v1/conversations': conversations,
  });
  mount();
  fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'new@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
  await screen.findByText('Check your email');
  fireEvent.change(screen.getByLabelText('Code'), { target: { value: '654321' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByText('Enter your invite code');
  fireEvent.change(screen.getByLabelText('Invite code'), { target: { value: 'inv_beta' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByLabelText('What would you like to get done?');
  expect(calls.find((c) => c.route === 'POST /v1/auth/claim')?.body).toMatchObject({
    pendingToken: 'pnd_1',
    inviteToken: 'inv_beta',
  });
});

test('a session that cannot be opened is ended on the server and the person stays on the sign-in screen', async () => {
  const calls = serve({
    'GET /v1/auth/options': () => json(WAYS),
    'POST /v1/auth/email': () => json({ challengeId: 'c1', deviceSecret: 's', expiresAt: 9 }),
    'POST /v1/auth/email/verify': session('s3'),
    'GET /v1/conversations': () => json({ error: 'unavailable' }, 503),
    'POST /v1/auth/sign-out': () => json({}),
  });
  mount();
  fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'ada@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
  await screen.findByText('Check your email');
  fireEvent.change(screen.getByLabelText('Code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() =>
    expect(calls.some((c) => c.route === 'POST /v1/auth/sign-out' && c.cookie && !c.auth)).toBe(
      true,
    ),
  );
  expect(jar.session).toBeUndefined();
  await screen.findByLabelText('Email');
  expect(screen.queryByLabelText('What would you like to get done?')).toBeNull();
});

test('signing out of a signed-in device ends its session on the server and shows the sign-in screen', async () => {
  const calls = serve({
    'GET /v1/auth/options': () => json(WAYS),
    'POST /v1/auth/email': () => json({ challengeId: 'c1', deviceSecret: 's', expiresAt: 9 }),
    'POST /v1/auth/email/verify': session('s1'),
    'GET /v1/conversations': conversations,
    'GET /v1/auth/sessions': () =>
      json({
        sessions: [
          {
            sessionId: 's1',
            deviceLabel: 'Chrome on Mac',
            createdAt: 1,
            lastSeenAt: Date.now(),
            current: true,
          },
          {
            sessionId: 's9',
            deviceLabel: 'iPhone app',
            createdAt: 1,
            lastSeenAt: Date.now() - 3 * 3600_000,
            current: false,
          },
        ],
        identities: [{ provider: 'email', email: 'ada@example.com' }],
      }),
    'POST /v1/auth/sign-out': () => json({}),
  });
  mount();
  fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'ada@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
  await screen.findByText('Check your email');
  fireEvent.change(screen.getByLabelText('Code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByLabelText('What would you like to get done?');
  fireEvent.click(screen.getByRole('button', { name: 'Me' }));
  const panel = await screen.findByRole('region', { name: 'Signed-in devices' });
  expect(within(panel).getByText(/Chrome on Mac · this device/u)).toBeTruthy();
  expect(within(panel).getByText('iPhone app')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await screen.findByLabelText('Email');
  expect(calls.some((c) => c.route === 'POST /v1/auth/sign-out' && c.cookie && !c.auth)).toBe(true);
  expect(jar.session).toBeUndefined();
});

test('the devices of an account: another one is signed out; an unsupported server shows nothing', async () => {
  let sessions = [
    {
      sessionId: 's1',
      deviceLabel: 'Chrome on Mac',
      createdAt: 1,
      lastSeenAt: 10 * 60_000,
      current: true,
    },
    { sessionId: 's2', deviceLabel: 'iPhone app', createdAt: 1, lastSeenAt: 0, current: false },
  ];
  const calls: string[] = [];
  const client = new CloudClient('mks_abc.def', async (input, init) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/v1/auth/sessions' && !init?.method)
      return json({ sessions, identities: [{ provider: 'google', email: 'a@b.c' }] });
    if (path === '/v1/auth/sessions/s2' && init?.method === 'DELETE') {
      sessions = sessions.filter((s) => s.sessionId !== 's2');
      return json({});
    }
    return json({}, 404);
  });
  const { unmount } = render(<DevicesPanel client={client} now={() => 10 * 60_000} />);
  await screen.findByText(/Chrome on Mac · this device/u);
  expect(screen.getByText('Active now')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Sign out iPhone app' }));
  await waitFor(() => expect(screen.queryByText('iPhone app')).toBeNull());
  expect(calls).toContain('DELETE /v1/auth/sessions/s2');
  unmount();

  const bare = new CloudClient('inv', async () => json({ error: 'not_found' }, 404));
  bare.unsupported.add('devices');
  const { container } = render(<DevicesPanel client={bare} />);
  await act(async () => {});
  expect(container.textContent).toBe('');
});

test('the device label names the browser and the system', () => {
  expect(
    browserLabel(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    ),
  ).toBe('Chrome on Mac');
  expect(
    browserLabel(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    ),
  ).toBe('Safari on iPhone');
  expect(
    browserLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/131.0'),
  ).toBe('Firefox on Windows');
  expect(browserLabel('')).toBe('Browser');
});

test('leaving the code step forgets what was typed in it', async () => {
  serve({
    'GET /v1/auth/options': () => json(WAYS),
    'POST /v1/auth/email': () => json({ challengeId: 'c1', deviceSecret: 's', expiresAt: 9 }),
  });
  mount();
  fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'ada@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
  await screen.findByText('Check your email');
  fireEvent.change(screen.getByLabelText('Code'), { target: { value: '111111' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use another way' }));
  fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'ada@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
  await screen.findByText('Check your email');
  expect((screen.getByLabelText('Code') as HTMLInputElement).value).toBe('');
});

test('signing out does not wait for a server that never answers', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    serve({
      'GET /v1/auth/options': () => json(WAYS),
      'POST /v1/auth/email': () => json({ challengeId: 'c1', deviceSecret: 's', expiresAt: 9 }),
      'POST /v1/auth/email/verify': session('s1'),
      'GET /v1/conversations': conversations,
      'POST /v1/auth/sign-out': () => new Promise<Response>(() => {}),
    });
    mount();
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'ada@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    await screen.findByText('Check your email');
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByLabelText('What would you like to get done?');
    fireEvent.click(screen.getByRole('button', { name: 'Me' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    await screen.findByLabelText('Email');
  } finally {
    vi.useRealTimers();
  }
});

test('a reload, or a tap on a notification, opens the workspace from the cookie without signing in again', async () => {
  jar.session = 's1';
  const calls = serve({
    'GET /v1/auth/options': () => json(WAYS),
    'GET /v1/conversations': conversations,
  });
  mount();
  await screen.findByLabelText('What would you like to get done?');
  expect(calls.some((c) => c.route.startsWith('POST /v1/auth/'))).toBe(false);
  expect(calls.every((c) => c.cookie && !c.auth)).toBe(true);
});

test('a cookie that no longer signs in, or no answer, leads to the sign-in screen', async () => {
  serve({ 'GET /v1/auth/options': () => json(WAYS) });
  mount();
  await screen.findByLabelText('Email');
  cleanup();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/v1/auth/options')) return json(WAYS);
    throw new TypeError('offline');
  });
  mount();
  await screen.findByLabelText('Email');
  expect(screen.queryByLabelText('What would you like to get done?')).toBeNull();
});

test('the token the server gives a phone is refused on the web, so no session ever sits in the page', async () => {
  const calls = serve({
    'GET /v1/auth/options': () => json(WAYS),
    'POST /v1/auth/email': () => json({ challengeId: 'c1', deviceSecret: 's', expiresAt: 9 }),
    'POST /v1/auth/email/verify': () =>
      json({ status: 'signed_in', token: 'mks_abc.def', sessionId: 's1' }),
    'GET /v1/conversations': conversations,
  });
  mount();
  fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'ada@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
  await screen.findByText('Check your email');
  fireEvent.change(screen.getByLabelText('Code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByLabelText('Email');
  expect(screen.queryByLabelText('What would you like to get done?')).toBeNull();
  expect(calls.some((c) => c.auth !== undefined)).toBe(false);
});
