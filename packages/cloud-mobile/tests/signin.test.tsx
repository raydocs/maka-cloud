import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import SignIn from '@/app/sign-in';
import { SessionProvider, useSession } from '@/lib/session';

const fetchMock = () => (globalThis as unknown as { __fetch: jest.Mock }).__fetch;
const secure = () => (globalThis as unknown as { __secure: Map<string, string> }).__secure;

let api: ReturnType<typeof useSession>;
function Probe() {
  api = useSession();
  return <Text testID="status">{api.session.status}</Text>;
}

const WAYS = { apple: true, google: true, email: true };

/** A server that answers by path, and remembers what it was asked. */
function serve(
  routes: Record<
    string,
    (body: Record<string, unknown> | undefined, auth: string | undefined) => Response
  >,
) {
  const calls: Array<{
    path: string;
    body: Record<string, unknown> | undefined;
    auth: string | undefined;
  }> = [];
  fetchMock().mockImplementation(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
    calls.push({ path, body, auth });
    const route = routes[`${init.method ?? 'GET'} ${path}`];
    return route ? route(body, auth) : new Response('{}', { status: 404 });
  });
  return calls;
}

const mount = () =>
  render(
    <SessionProvider>
      <Probe />
      <SignIn />
    </SessionProvider>,
  );

async function chooseServer() {
  await screen.findByText('out');
  await fireEvent.changeText(screen.getByTestId('field-Server address'), 'maka.example.com');
  await fireEvent.press(screen.getByTestId('button-Continue'));
}

const conversations = () => Response.json({ conversations: [] });

test('the first screen offers email, not an invite-token box, and the old box is one tap away', async () => {
  serve({ 'GET /v1/auth/options': () => Response.json(WAYS) });
  await mount();
  await chooseServer();
  await screen.findByText('Sign in');
  expect(screen.getByTestId('field-Email')).toBeTruthy();
  expect(screen.getByTestId('button-Email me a code')).toBeTruthy();
  expect(screen.queryByTestId('field-Invite token')).toBeNull();
  // The build carries no Apple or Google sheet yet, so those buttons are not offered.
  expect(screen.queryByTestId('button-Continue with Apple')).toBeNull();
  expect(screen.queryByTestId('button-Continue with Google')).toBeNull();
  await fireEvent.press(screen.getByTestId('button-I have an invite token'));
  expect(screen.getByTestId('field-Invite token')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('button-Other ways to sign in'));
  expect(screen.getByTestId('field-Email')).toBeTruthy();
});

test('the server address and the way to change it wait behind "Advanced"', async () => {
  serve({ 'GET /v1/auth/options': () => Response.json(WAYS) });
  await mount();
  await chooseServer();
  await screen.findByTestId('field-Email');
  expect(screen.queryByText('maka.example.com')).toBeNull();
  expect(screen.queryByTestId('button-Use another server')).toBeNull();
  const advanced = screen.getByRole('button', { name: 'Advanced' });
  expect(advanced.props.accessibilityState).toEqual({ expanded: false });
  await fireEvent.press(advanced);
  expect(screen.getByText('maka.example.com')).toBeTruthy();
  expect(screen.getByTestId('button-Use another server')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Advanced' }).props.accessibilityState).toEqual({
    expanded: true,
  });
});

test('a disabled main button is a faint outline, not a filled slab', async () => {
  serve({ 'GET /v1/auth/options': () => Response.json(WAYS) });
  await mount();
  await chooseServer();
  const button = await screen.findByTestId('button-Email me a code');
  expect(button.props.accessibilityState).toMatchObject({ disabled: true });
  const style = Object.assign({}, ...[button.props.style].flat(Number.POSITIVE_INFINITY));
  expect(style.backgroundColor).toBe('transparent');
  expect(style.opacity).toBe(1);
});

test('email: a known address signs in with the code, and only the session token is kept, in the secure store', async () => {
  const calls = serve({
    'GET /v1/auth/options': () => Response.json(WAYS),
    'POST /v1/auth/email': () =>
      Response.json({ challengeId: 'c1', deviceSecret: 'device-secret', expiresAt: 9 }),
    'POST /v1/auth/email/verify': () =>
      Response.json({ status: 'signed_in', token: 'mks_abc.def', sessionId: 's1' }),
    'GET /v1/conversations': conversations,
  });
  await mount();
  await chooseServer();
  await screen.findByTestId('field-Email');
  await fireEvent.changeText(screen.getByTestId('field-Email'), 'ada@example.com');
  await fireEvent.press(screen.getByTestId('button-Email me a code'));
  await screen.findByText('Check your email');
  expect(screen.getByText(/ada@example\.com/u)).toBeTruthy();
  await fireEvent.changeText(screen.getByTestId('field-Code'), '123 456');
  await fireEvent.press(screen.getByTestId('button-Sign in'));
  await waitFor(() => expect(screen.getByTestId('status').props.children).toBe('in'));
  expect(calls.find((c) => c.path === '/v1/auth/email/verify')?.body).toEqual({
    challengeId: 'c1',
    deviceSecret: 'device-secret',
    code: '123456',
    device: 'iPhone app',
  });
  expect(calls.find((c) => c.path === '/v1/conversations')?.auth).toBe('Bearer mks_abc.def');
  expect(JSON.parse(secure().get('maka.account') as string)).toEqual({
    server: 'https://maka.example.com',
    token: 'mks_abc.def',
  });
  expect(JSON.stringify([...secure().values()])).not.toContain('device-secret');
});

test('email: a new person gives the invite code once and is then signed in', async () => {
  const calls = serve({
    'GET /v1/auth/options': () => Response.json(WAYS),
    'POST /v1/auth/email': () =>
      Response.json({ challengeId: 'c1', deviceSecret: 's', expiresAt: 9 }),
    'POST /v1/auth/email/verify': () =>
      Response.json({ status: 'needs_invite', pendingToken: 'pnd_secret', expiresAt: 9 }),
    'POST /v1/auth/claim': () =>
      Response.json({ status: 'signed_in', token: 'mks_new.tok', sessionId: 's2' }),
    'GET /v1/conversations': conversations,
  });
  await mount();
  await chooseServer();
  await screen.findByTestId('field-Email');
  await fireEvent.changeText(screen.getByTestId('field-Email'), 'new@example.com');
  await fireEvent.press(screen.getByTestId('button-Email me a code'));
  await screen.findByTestId('field-Code');
  await fireEvent.changeText(screen.getByTestId('field-Code'), '654321');
  await fireEvent.press(screen.getByTestId('button-Sign in'));
  await screen.findByText('Enter your invite code');
  expect(secure().has('maka.account')).toBe(false);
  await fireEvent.changeText(screen.getByTestId('field-Invite code'), 'inv-token');
  await fireEvent.press(screen.getByTestId('button-Continue'));
  await waitFor(() => expect(screen.getByTestId('status').props.children).toBe('in'));
  expect(calls.find((c) => c.path === '/v1/auth/claim')?.body).toEqual({
    pendingToken: 'pnd_secret',
    inviteToken: 'inv-token',
    device: 'iPhone app',
  });
  expect(JSON.stringify([...secure().values()])).not.toContain('pnd_secret');
});

test('a wrong code says so on the same screen, and nothing is saved', async () => {
  serve({
    'GET /v1/auth/options': () => Response.json(WAYS),
    'POST /v1/auth/email': () =>
      Response.json({ challengeId: 'c1', deviceSecret: 's', expiresAt: 9 }),
    'POST /v1/auth/email/verify': () => Response.json({ error: 'sign_in_failed' }, { status: 401 }),
  });
  await mount();
  await chooseServer();
  await screen.findByTestId('field-Email');
  await fireEvent.changeText(screen.getByTestId('field-Email'), 'ada@example.com');
  await fireEvent.press(screen.getByTestId('button-Email me a code'));
  await screen.findByTestId('field-Code');
  await fireEvent.changeText(screen.getByTestId('field-Code'), '000000');
  await fireEvent.press(screen.getByTestId('button-Sign in'));
  await screen.findByText(/That code is not right, or it has expired/u);
  expect(screen.getByTestId('status').props.children).toBe('out');
  expect(secure().has('maka.account')).toBe(false);
});

test('an invite token still signs in, and a server with no sign-in set up says to use it', async () => {
  const calls = serve({
    'GET /v1/auth/options': () => Response.json({ apple: false, google: false, email: false }),
    'GET /v1/conversations': conversations,
  });
  await mount();
  await chooseServer();
  await screen.findByText(/no sign-in set up yet/u);
  await fireEvent.press(screen.getByTestId('button-I have an invite token'));
  await fireEvent.changeText(screen.getByTestId('field-Invite token'), 'inv-token');
  await fireEvent.press(screen.getByTestId('button-Enter your workspace'));
  await waitFor(() => expect(screen.getByTestId('status').props.children).toBe('in'));
  expect(calls.find((c) => c.path === '/v1/conversations')?.auth).toBe('Bearer inv-token');
});

test('a server address that is not allowed never reaches the network', async () => {
  const calls = serve({});
  await mount();
  await screen.findByText('out');
  await fireEvent.changeText(screen.getByTestId('field-Server address'), 'http://maka.example.com');
  await fireEvent.press(screen.getByTestId('button-Continue'));
  await screen.findByText(/Use an https:\/\/ address/u);
  expect(calls).toEqual([]);
});

test('signing out ends a device session on the server first; an invite token has none to end', async () => {
  const calls = serve({
    'GET /v1/conversations': conversations,
    'POST /v1/auth/sign-out': () => new Response(null, { status: 204 }),
  });
  await mount();
  await screen.findByText('out');
  await act(async () => {
    await api.signIn('maka.example.com', 'mks_abc.def');
  });
  await act(async () => {
    await api.signOut();
  });
  expect(calls.map((c) => c.path)).toEqual(['/v1/conversations', '/v1/auth/sign-out']);
  expect(calls[1]?.auth).toBe('Bearer mks_abc.def');
  expect(secure().has('maka.account')).toBe(false);

  calls.length = 0;
  await act(async () => {
    await api.signIn('maka.example.com', 'inv-token');
  });
  await act(async () => {
    await api.signOut();
  });
  expect(calls.map((c) => c.path)).toEqual(['/v1/conversations']);
});

test('a server that cannot be reached when signing out still lets the device forget its token', async () => {
  serve({ 'GET /v1/conversations': conversations });
  fetchMock().mockImplementation(async (url: string) => {
    if (new URL(url).pathname === '/v1/auth/sign-out')
      throw new TypeError('Network request failed');
    return conversations();
  });
  await mount();
  await screen.findByText('out');
  await act(async () => {
    await api.signIn('maka.example.com', 'mks_abc.def');
  });
  await act(async () => {
    await api.signOut();
  });
  expect(api.session.status).toBe('out');
  expect(secure().has('maka.account')).toBe(false);
});

test('a sign-in left behind by choosing another server cannot replace the one that followed', async () => {
  let release: (response: Response) => void = () => {};
  const calls: Array<{ host: string; path: string; auth: string | undefined }> = [];
  fetchMock().mockImplementation(async (url: string, init: RequestInit = {}) => {
    const { host, pathname } = new URL(url);
    const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
    calls.push({ host, path: pathname, auth });
    const route = `${init.method ?? 'GET'} ${pathname}`;
    if (route === 'GET /v1/auth/options') return Response.json(WAYS);
    if (route === 'POST /v1/auth/email')
      return Response.json({ challengeId: 'c1', deviceSecret: 's', expiresAt: 9 });
    if (route === 'POST /v1/auth/email/verify')
      return new Promise<Response>((resolve) => (release = resolve));
    if (route === 'POST /v1/auth/sign-out') return Response.json({});
    if (route === 'GET /v1/conversations') return conversations();
    return new Response('{}', { status: 404 });
  });
  await mount();
  await chooseServer(); // server A
  await screen.findByTestId('field-Email');
  await fireEvent.changeText(screen.getByTestId('field-Email'), 'ada@example.com');
  await fireEvent.press(screen.getByTestId('button-Email me a code'));
  await screen.findByText('Check your email');
  await fireEvent.changeText(screen.getByTestId('field-Code'), '123456');
  await fireEvent.press(screen.getByTestId('button-Sign in')); // the answer is still out
  await waitFor(() => expect(calls.some((c) => c.path === '/v1/auth/email/verify')).toBe(true));
  await fireEvent.press(screen.getByTestId('button-Advanced'));
  await fireEvent.press(screen.getByTestId('button-Use another server'));
  await fireEvent.changeText(screen.getByTestId('field-Server address'), 'other.example.com');
  await fireEvent.press(screen.getByTestId('button-Continue'));
  await screen.findByTestId('button-I have an invite token');
  await fireEvent.press(screen.getByTestId('button-I have an invite token'));
  await fireEvent.changeText(screen.getByTestId('field-Invite token'), 'inv_b');
  await fireEvent.press(screen.getByTestId('button-Enter your workspace'));
  await waitFor(() => expect(screen.getByTestId('status').props.children).toBe('in'));
  // Server A answers late, with a session for the phone.
  await act(async () => {
    release(Response.json({ status: 'signed_in', token: 'mks_a.late', sessionId: 's' }));
  });
  await waitFor(() =>
    expect(
      calls.some((c) => c.path === '/v1/auth/sign-out' && c.auth === 'Bearer mks_a.late'),
    ).toBe(true),
  );
  expect(JSON.parse(secure().get('maka.account') as string)).toEqual({
    server: 'https://other.example.com',
    token: 'inv_b',
  });
});
