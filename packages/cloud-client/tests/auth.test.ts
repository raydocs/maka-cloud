import { expect, test } from 'vitest';
import {
  activeWords,
  AuthFlow,
  type AuthPlatform,
  type AuthState,
  CloudClient,
  identityWords,
  SignInCancelled,
  Unsupported,
} from '../src/index';

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

const until = async (check: () => boolean, what = 'the condition') => {
  for (let i = 0; i < 400 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
};

type Reply = { status?: number; body: unknown };
type Route = (call: Call) => Reply | Promise<Reply>;

/** A server that is a function of the call. Nothing leaves the process. */
function scripted(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const auths: string[] = [];
  const fetcher = (async (url, init) => {
    const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (authorization) auths.push(authorization);
    const call: Call = {
      method: init?.method ?? 'GET',
      path: String(url).replace('https://maka.test', ''),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    const reply = route ? await route(call) : { status: 404, body: { error: 'not_found' } };
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { calls, auths, fetcher };
}

const ALL = { apple: true, google: true, email: true };
const options: Route = () => ({ body: ALL });

function flow(
  routes: Record<string, Route>,
  platform: Partial<AuthPlatform> = {},
  onSignedIn: (token: string) => void | Promise<void> = () => {},
) {
  const server = scripted({ 'GET /v1/auth/options': options, ...routes });
  const states: AuthState[] = [];
  const auth = new AuthFlow({
    baseUrl: 'https://maka.test',
    fetcher: server.fetcher,
    platform: { credential: async () => 'id-token', deviceLabel: 'Ada’s phone', ...platform },
    onSignedIn,
  });
  auth.subscribe(() => states.push(auth.getSnapshot()));
  return { auth, states, ...server };
}

const step = (auth: AuthFlow) => auth.getSnapshot().step;
const errorOf = (auth: AuthFlow) => {
  const state = auth.getSnapshot();
  return 'error' in state ? state.error : '';
};

test('the first screen is the ways the server offers, read before anything is asked', async () => {
  const { auth, calls } = flow({});
  expect(step(auth)).toBe('loading');
  await auth.start();
  expect(auth.getSnapshot()).toEqual({ step: 'choose', ways: ALL, error: '' });
  expect(calls).toEqual([{ method: 'GET', path: '/v1/auth/options', body: undefined }]);
});

test('a server with nothing on, or no connection, says so and can be tried again', async () => {
  const { auth } = flow({
    'GET /v1/auth/options': () => ({ status: 404, body: { error: 'not_found' } }),
  });
  await auth.start();
  expect(auth.getSnapshot()).toEqual({
    step: 'failed',
    message: 'This address does not look like a Maka server.',
  });
  const down = new AuthFlow({
    fetcher: (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch,
    platform: { credential: async () => '', deviceLabel: 'x' },
    onSignedIn: () => {},
  });
  await down.start();
  expect(down.getSnapshot()).toEqual({
    step: 'failed',
    message: 'Could not reach the server. Check your connection and try again.',
  });
});

test('Apple: the server’s nonce goes to the provider unchanged and comes back with its token', async () => {
  const asked: Array<[string, string]> = [];
  const saved: string[] = [];
  const { auth, calls } = flow(
    {
      'POST /v1/auth/nonce': () => ({ body: { nonce: 'n-1' } }),
      'POST /v1/auth/session': () => ({
        body: { status: 'signed_in', token: 'mks_a.b', sessionId: 's1' },
      }),
    },
    {
      credential: async (provider, nonce) => {
        asked.push([provider, nonce]);
        return 'apple-id-token';
      },
    },
    (token) => void saved.push(token),
  );
  await auth.start();
  await auth.signInWith('apple');
  expect(asked).toEqual([['apple', 'n-1']]);
  expect(calls.at(-1)).toEqual({
    method: 'POST',
    path: '/v1/auth/session',
    body: { provider: 'apple', idToken: 'apple-id-token', nonce: 'n-1', device: 'Ada’s phone' },
  });
  expect(saved).toEqual(['mks_a.b']);
  expect(step(auth)).toBe('signedIn');
});

test('closing the provider’s sheet is not an error, and nothing is sent to the server after it', async () => {
  const { auth, calls } = flow(
    { 'POST /v1/auth/nonce': () => ({ body: { nonce: 'n' } }) },
    {
      credential: async () => {
        throw new SignInCancelled();
      },
    },
  );
  await auth.start();
  await auth.signInWith('google');
  expect(auth.getSnapshot()).toEqual({ step: 'choose', ways: ALL, error: '' });
  expect(calls.map((c) => c.path)).toEqual(['/v1/auth/options', '/v1/auth/nonce']);
});

test('a way the server did not offer is not tried', async () => {
  const { auth, calls } = flow({
    'GET /v1/auth/options': () => ({ body: { apple: false, google: true, email: false } }),
  });
  await auth.start();
  await auth.signInWith('apple');
  await auth.sendEmail('ada@example.com');
  expect(calls).toHaveLength(1);
});

test('a refused provider token is one plain sentence and the person is back at the choice', async () => {
  const { auth } = flow({
    'POST /v1/auth/nonce': () => ({ body: { nonce: 'n' } }),
    'POST /v1/auth/session': () => ({ status: 401, body: { error: 'sign_in_failed' } }),
  });
  await auth.start();
  await auth.signInWith('google');
  expect(auth.getSnapshot()).toEqual({
    step: 'choose',
    ways: ALL,
    error: 'We could not sign you in. Try again.',
  });
});

test('a new person is asked for the invite code once, and its secrets never show in the state', async () => {
  const saved: string[] = [];
  const { auth, states, calls } = flow(
    {
      'POST /v1/auth/nonce': () => ({ body: { nonce: 'n' } }),
      'POST /v1/auth/session': () => ({
        body: { status: 'needs_invite', pendingToken: 'pnd_secret', expiresAt: 1 },
      }),
      'POST /v1/auth/claim': () => ({
        body: { status: 'signed_in', token: 'mks_x.y', sessionId: 's' },
      }),
    },
    {},
    (token) => void saved.push(token),
  );
  await auth.start();
  await auth.signInWith('apple');
  expect(auth.getSnapshot()).toEqual({ step: 'needsInvite', error: '' });
  await auth.claim('  inv_token ');
  expect(calls.at(-1)).toEqual({
    method: 'POST',
    path: '/v1/auth/claim',
    body: { pendingToken: 'pnd_secret', inviteToken: 'inv_token', device: 'Ada’s phone' },
  });
  expect(saved).toEqual(['mks_x.y']);
  expect(step(auth)).toBe('signedIn');
  expect(JSON.stringify(states)).not.toContain('pnd_secret');
  expect(JSON.stringify(states)).not.toContain('mks_x.y');
});

test('a wrong invite code is tried again in place; a sign-in that ran out starts over', async () => {
  let answers = [
    { status: 403, body: { error: 'invite_unavailable' } },
    { status: 401, body: { error: 'sign_in_failed' } },
  ];
  const { auth } = flow({
    'POST /v1/auth/nonce': () => ({ body: { nonce: 'n' } }),
    'POST /v1/auth/session': () => ({
      body: { status: 'needs_invite', pendingToken: 'pnd_1', expiresAt: 1 },
    }),
    'POST /v1/auth/claim': () => answers.shift() ?? { status: 500, body: {} },
  });
  await auth.start();
  await auth.signInWith('google');
  await auth.claim('wrong');
  expect(auth.getSnapshot()).toEqual({
    step: 'needsInvite',
    error: 'That invite code did not work. Check it, or ask for a new one.',
  });
  await auth.claim('again');
  expect(auth.getSnapshot()).toEqual({
    step: 'choose',
    ways: ALL,
    error: 'That sign-in ran out. Start again.',
  });
  answers = [];
  await auth.claim('late');
  expect(step(auth)).toBe('choose');
});

test('email: the code goes with the challenge and the device secret of the request, and a known person is signed in', async () => {
  const saved: string[] = [];
  const { auth, calls, states } = flow(
    {
      'POST /v1/auth/email': () => ({
        body: { challengeId: 'c1', deviceSecret: 'device-secret', expiresAt: 5 },
      }),
      'POST /v1/auth/email/verify': () => ({
        body: { status: 'signed_in', token: 'mks_e.f', sessionId: 's' },
      }),
    },
    {},
    (token) => void saved.push(token),
  );
  await auth.start();
  await auth.sendEmail(' ada@example.com ');
  expect(calls.at(-1)?.body).toEqual({ address: 'ada@example.com' });
  expect(auth.getSnapshot()).toEqual({ step: 'emailSent', address: 'ada@example.com', error: '' });
  await auth.verifyEmail('123 456');
  expect(calls.at(-1)).toEqual({
    method: 'POST',
    path: '/v1/auth/email/verify',
    body: {
      challengeId: 'c1',
      deviceSecret: 'device-secret',
      code: '123456',
      device: 'Ada’s phone',
    },
  });
  expect(saved).toEqual(['mks_e.f']);
  expect(JSON.stringify(states)).not.toContain('device-secret');
});

test('email: a bad address, a request too soon and a wrong code each say so and keep the screen', async () => {
  const requests: Reply[] = [
    { status: 400, body: { error: 'invalid_request' } },
    { body: { challengeId: 'c1', deviceSecret: 's', expiresAt: 1 } },
    { status: 429, body: { error: 'quota_exceeded' } },
  ];
  const { auth } = flow({
    'POST /v1/auth/email': () => requests.shift() ?? { status: 500, body: {} },
    'POST /v1/auth/email/verify': () => ({ status: 401, body: { error: 'sign_in_failed' } }),
  });
  await auth.start();
  await auth.sendEmail('nope');
  expect(auth.getSnapshot()).toMatchObject({
    step: 'choose',
    error: 'Enter a valid email address.',
  });
  await auth.sendEmail('ada@example.com');
  await auth.verifyEmail('000000');
  expect(auth.getSnapshot()).toEqual({
    step: 'emailSent',
    address: 'ada@example.com',
    error: 'That code is not right, or it has expired. Check it, or ask for a new code.',
  });
  await auth.sendEmail('ada@example.com');
  expect(auth.getSnapshot()).toEqual({
    step: 'emailSent',
    address: 'ada@example.com',
    error: 'Wait a few seconds before asking for another code.',
  });
});

test('going back forgets the step: a late answer is dropped and an old code cannot be redeemed', async () => {
  let release: (reply: Reply) => void = () => {};
  const { auth, calls } = flow({
    'POST /v1/auth/email': () => ({ body: { challengeId: 'c1', deviceSecret: 's', expiresAt: 1 } }),
    'POST /v1/auth/email/verify': () => new Promise<Reply>((resolve) => (release = resolve)),
  });
  await auth.start();
  await auth.sendEmail('ada@example.com');
  const verifying = auth.verifyEmail('123456');
  expect(step(auth)).toBe('working');
  auth.back(); // ignored while working
  expect(step(auth)).toBe('working');
  release({ status: 401, body: { error: 'sign_in_failed' } });
  await verifying;
  expect(step(auth)).toBe('emailSent');
  auth.back();
  expect(auth.getSnapshot()).toEqual({ step: 'choose', ways: ALL, error: '' });
  const before = calls.length;
  await auth.verifyEmail('123456');
  expect(calls).toHaveLength(before);
});

test('a workspace that cannot be opened is said in words and the person stays on the choice', async () => {
  const { auth } = flow(
    {
      'POST /v1/auth/nonce': () => ({ body: { nonce: 'n' } }),
      'POST /v1/auth/session': () => ({
        body: { status: 'signed_in', token: 'mks_a.b', sessionId: 's' },
      }),
    },
    {},
    () => {
      throw new Error(
        'This device could not save your sign-in, so you are not signed in. Unlock the device and try again.',
      );
    },
  );
  await auth.start();
  await auth.signInWith('apple');
  expect(auth.getSnapshot()).toEqual({
    step: 'choose',
    ways: ALL,
    error:
      'This device could not save your sign-in, so you are not signed in. Unlock the device and try again.',
  });
});

test('a second tap while a request is out is ignored', async () => {
  let nonces = 0;
  const { auth } = flow({
    'POST /v1/auth/nonce': async () => {
      nonces += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { body: { nonce: 'n' } };
    },
    'POST /v1/auth/session': () => ({
      body: { status: 'signed_in', token: 'mks_a.b', sessionId: 's' },
    }),
  });
  await auth.start();
  await Promise.all([
    auth.signInWith('apple'),
    auth.signInWith('apple'),
    auth.signInWith('google'),
  ]);
  expect(nonces).toBe(1);
  expect(errorOf(auth)).toBe('');
});

test('when a device was last active, and how an account signs in, in words', () => {
  const now = 100 * 24 * 3_600_000;
  const ago = (ms: number) => activeWords(now - ms, now);
  expect(ago(0)).toBe('Active now');
  expect(ago(119_000)).toBe('Active now');
  expect(ago(5 * 60_000)).toBe('Active 5 minutes ago');
  expect(ago(3_600_000)).toBe('Active 1 hour ago');
  expect(ago(23 * 3_600_000)).toBe('Active 23 hours ago');
  expect(ago(24 * 3_600_000)).toBe('Active 1 day ago');
  expect(ago(40 * 24 * 3_600_000)).toBe('Active 40 days ago');
  expect(activeWords(now + 5_000, now)).toBe('Active now');
  expect(identityWords([])).toBe('');
  expect(identityWords([{ provider: 'apple' }])).toBe('Apple');
  expect(identityWords([{ provider: 'apple' }, { provider: 'email', email: 'a@b.co' }])).toBe(
    'Apple and email a@b.co',
  );
  expect(
    identityWords([{ provider: 'apple' }, { provider: 'google' }, { provider: 'email' }]),
  ).toBe('Apple, Google and email');
});

test('the devices of an account: listed, one signed out, this one ended; a server without them is unsupported', async () => {
  const calls: string[] = [];
  const fetcher = (async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
    if (String(url) === '/v1/auth/sessions') return Response.json({ sessions: [], identities: [] });
    if (String(url).startsWith('/v1/auth/sessions/')) return new Response(null, { status: 204 });
    if (String(url) === '/v1/auth/sign-out') return new Response(null, { status: 204 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  const client = new CloudClient('mks_a.b', { fetcher });
  expect(await client.devices()).toEqual({ sessions: [], identities: [] });
  await client.signOutDevice('s/2');
  await client.endSession();
  expect(calls).toEqual([
    'GET /v1/auth/sessions',
    'DELETE /v1/auth/sessions/s%2F2',
    'POST /v1/auth/sign-out',
  ]);
  const old = new CloudClient('mks_a.b', {
    fetcher: (async () => new Response('{}', { status: 404 })) as typeof fetch,
  });
  await expect(old.devices()).rejects.toThrow(Unsupported);
  expect(old.unsupported.has('devices')).toBe(true);
});

test('a session the device did not take is ended on the server: a late answer, or a device that cannot save it', async () => {
  let release: (reply: Reply) => void = () => {};
  const saved: string[] = [];
  const late = flow(
    {
      'POST /v1/auth/nonce': () => ({ body: { nonce: 'n' } }),
      'POST /v1/auth/session': () => new Promise<Reply>((resolve) => (release = resolve)),
      'POST /v1/auth/sign-out': () => ({ body: {} }),
    },
    {},
    (token) => void saved.push(token),
  );
  await late.auth.start();
  const signing = late.auth.signInWith('apple');
  await until(() => step(late.auth) === 'working');
  await until(() => late.calls.some((c) => c.path === '/v1/auth/session'));
  void late.auth.start(); // the person leaves; the request is still out
  release({ body: { status: 'signed_in', token: 'mks_late.tok', sessionId: 's' } });
  await signing;
  await until(() => late.calls.some((c) => c.path === '/v1/auth/sign-out'));
  expect(saved).toEqual([]);
  expect(late.auths.at(-1)).toBe('Bearer mks_late.tok');

  const failed = flow(
    {
      'POST /v1/auth/nonce': () => ({ body: { nonce: 'n' } }),
      'POST /v1/auth/session': () => ({
        body: { status: 'signed_in', token: 'mks_x.y', sessionId: 's' },
      }),
      'POST /v1/auth/sign-out': () => ({ body: {} }),
    },
    {},
    () => {
      throw new Error('This device could not save your sign-in.');
    },
  );
  await failed.auth.start();
  await failed.auth.signInWith('google');
  await until(() => failed.calls.some((c) => c.path === '/v1/auth/sign-out'));
  expect(failed.auths.at(-1)).toBe('Bearer mks_x.y');
});

test('an answer that is not what a Maka server sends is a plain error and nothing is handed on', async () => {
  for (const body of [
    {},
    { status: 'signed_in' },
    { status: 'signed_in', token: 'plain-token' },
    { status: 'needs_invite' },
    { status: 'other' },
  ]) {
    const saved: string[] = [];
    const { auth, calls } = flow(
      {
        'POST /v1/auth/nonce': () => ({ body: { nonce: 'n' } }),
        'POST /v1/auth/session': () => ({ body }),
      },
      {},
      (token) => void saved.push(token),
    );
    await auth.start();
    await auth.signInWith('google');
    expect(saved).toEqual([]);
    expect(auth.getSnapshot()).toMatchObject({ step: 'choose' });
    expect(errorOf(auth)).not.toBe('');
    expect(calls.some((c) => c.path === '/v1/auth/sign-out')).toBe(false);
  }
});

test('a code abandoned before its answer arrives leaves nothing in the flow', async () => {
  let release: (reply: Reply) => void = () => {};
  const { auth, calls } = flow({
    'POST /v1/auth/email': () => new Promise<Reply>((resolve) => (release = resolve)),
    'POST /v1/auth/email/verify': () => ({ status: 401, body: { error: 'sign_in_failed' } }),
  });
  await auth.start();
  const asking = auth.sendEmail('ada@example.com');
  await until(() => calls.some((c) => c.path === '/v1/auth/email'));
  void auth.start(); // the person leaves
  release({ body: { challengeId: 'c1', deviceSecret: 'device-secret', expiresAt: 1 } });
  await asking;
  await until(() => step(auth) === 'choose');
  await auth.verifyEmail('123456');
  expect(calls.some((c) => c.path === '/v1/auth/email/verify')).toBe(false);
});

test('a flow that was closed never signs the device in, and the session it was issued is ended', async () => {
  let release: (reply: Reply) => void = () => {};
  const saved: string[] = [];
  const { auth, calls, auths } = flow(
    {
      'POST /v1/auth/email': () => ({
        body: { challengeId: 'c1', deviceSecret: 'device-secret', expiresAt: 1 },
      }),
      'POST /v1/auth/email/verify': () => new Promise<Reply>((resolve) => (release = resolve)),
      'POST /v1/auth/sign-out': () => ({ body: {} }),
    },
    {},
    (token) => void saved.push(token),
  );
  await auth.start();
  await auth.sendEmail('ada@example.com');
  const verifying = auth.verifyEmail('123456');
  await until(() => calls.some((c) => c.path === '/v1/auth/email/verify'));
  auth.close(); // another server was chosen; the code is still being checked
  release({ body: { status: 'signed_in', token: 'mks_closed.tok', sessionId: 's' } });
  await verifying;
  await until(() => calls.some((c) => c.path === '/v1/auth/sign-out'));
  expect(saved).toEqual([]);
  expect(auths.at(-1)).toBe('Bearer mks_closed.tok');
  expect(step(auth)).not.toBe('signedIn');
});
