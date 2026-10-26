import { expect, test } from 'vitest';
import { AuthFlow, CloudClient, openCookieWorkspace } from '../src/index';

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
}

/** A server that answers by path and records what each request carried. */
function server(routes: Record<string, () => { status?: number; body?: unknown }>) {
  const seen: Seen[] = [];
  const fetcher = (async (url, init) => {
    const method = init?.method ?? 'GET';
    const path = String(url);
    seen.push({ method, path, headers: { ...(init?.headers as Record<string, string>) } });
    const route = routes[`${method} ${path}`];
    const reply = route ? route() : { status: 404, body: { error: 'not_found' } };
    return reply.status === 204
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { seen, fetcher };
}

test('a cookie client proves itself with the cookie header and never sends a bearer token', async () => {
  const { seen, fetcher } = server({
    'GET /v1/conversations': () => ({ body: { conversations: [] } }),
  });
  const client = new CloudClient('', { fetcher, cookie: { owner: 'inv_1' } });
  await client.listConversations();
  expect(seen[0]?.headers['X-Maka-Cookie']).toBe('1');
  expect(seen[0]?.headers.Authorization).toBeUndefined();
  // what the browser keeps is keyed by the account, the same for every session of it
  expect(client.outboxScope().token).toBe(
    new CloudClient('', { fetcher, cookie: { owner: 'inv_1' } }).outboxScope().token,
  );
  expect(client.outboxScope().token).not.toBe(
    new CloudClient('', { fetcher, cookie: { owner: 'inv_2' } }).outboxScope().token,
  );
});

test('a token client is unchanged: a bearer token and no cookie header', async () => {
  const { seen, fetcher } = server({
    'GET /v1/conversations': () => ({ body: { conversations: [] } }),
  });
  await new CloudClient('mks_a.b', fetcher).listConversations();
  expect(seen[0]?.headers.Authorization).toBe('Bearer mks_a.b');
  expect(seen[0]?.headers['X-Maka-Cookie']).toBeUndefined();
});

test('the cookie opens the workspace it signs in to, and no cookie (401) is no workspace', async () => {
  const signedIn = server({
    'GET /v1/me': () => ({ body: { ownerId: 'inv_1', accountTag: 'tag' } }),
    'GET /v1/conversations': () => ({
      body: { conversations: [{ conversationId: 'c1', title: 'One', createdAt: 1 }] },
    }),
  });
  const workspace = await openCookieWorkspace({ fetcher: signedIn.fetcher, onRevoked: () => {} });
  expect(workspace?.chosen).toBe('c1');
  expect(signedIn.seen.every((s) => s.headers['X-Maka-Cookie'] === '1')).toBe(true);
  expect(signedIn.seen.some((s) => s.headers.Authorization !== undefined)).toBe(false);

  const none = server({ 'GET /v1/me': () => ({ status: 401, body: { error: 'unauthorized' } }) });
  expect(await openCookieWorkspace({ fetcher: none.fetcher, onRevoked: () => {} })).toBeUndefined();
  expect(none.seen).toHaveLength(1);

  const broken = server({ 'GET /v1/me': () => ({ status: 500, body: {} }) });
  await expect(
    openCookieWorkspace({ fetcher: broken.fetcher, onRevoked: () => {} }),
  ).rejects.toThrow();
});

const platform = { credential: async () => 'id-token', deviceLabel: 'Chrome on Mac' };

test('in cookie mode the flow asks for the cookie, takes an answer without a token, and hands on none', async () => {
  const { seen, fetcher } = server({
    'GET /v1/auth/options': () => ({ body: { apple: false, google: false, email: true } }),
    'POST /v1/auth/email': () => ({ body: { challengeId: 'c', deviceSecret: 's', expiresAt: 9 } }),
    'POST /v1/auth/email/verify': () => ({ body: { status: 'signed_in', sessionId: 'ses_1' } }),
  });
  const tokens: string[] = [];
  const auth = new AuthFlow({
    fetcher,
    platform,
    cookie: true,
    onSignedIn: (t) => void tokens.push(t),
  });
  await auth.start();
  await auth.sendEmail('ada@example.com');
  await auth.verifyEmail('123456');
  expect(auth.getSnapshot().step).toBe('signedIn');
  expect(tokens).toEqual(['']);
  expect(seen.every((s) => s.headers['X-Maka-Cookie'] === '1')).toBe(true);
});

test('in cookie mode a token in the body is refused, so a session never lands in the page', async () => {
  const { seen, fetcher } = server({
    'GET /v1/auth/options': () => ({ body: { apple: false, google: false, email: true } }),
    'POST /v1/auth/email': () => ({ body: { challengeId: 'c', deviceSecret: 's', expiresAt: 9 } }),
    'POST /v1/auth/email/verify': () => ({
      body: { status: 'signed_in', token: 'mks_x.y', sessionId: 'ses_1' },
    }),
  });
  const tokens: string[] = [];
  const auth = new AuthFlow({
    fetcher,
    platform,
    cookie: true,
    onSignedIn: (t) => void tokens.push(t),
  });
  await auth.start();
  await auth.sendEmail('ada@example.com');
  await auth.verifyEmail('123456');
  expect(tokens).toEqual([]);
  expect(auth.getSnapshot().step).toBe('choose');
  expect(seen.some((s) => s.path === '/v1/auth/sign-out')).toBe(false);
});

test('a cookie session the page could not open is ended with the cookie, not a token', async () => {
  const { seen, fetcher } = server({
    'GET /v1/auth/options': () => ({ body: { apple: false, google: false, email: true } }),
    'POST /v1/auth/email': () => ({ body: { challengeId: 'c', deviceSecret: 's', expiresAt: 9 } }),
    'POST /v1/auth/email/verify': () => ({ body: { status: 'signed_in', sessionId: 'ses_1' } }),
    'POST /v1/auth/sign-out': () => ({ status: 204 }),
  });
  const auth = new AuthFlow({
    fetcher,
    platform,
    cookie: true,
    onSignedIn: () => {
      throw new Error('could not open');
    },
  });
  await auth.start();
  await auth.sendEmail('ada@example.com');
  await auth.verifyEmail('123456');
  for (let i = 0; i < 50 && !seen.some((s) => s.path === '/v1/auth/sign-out'); i += 1)
    await new Promise((r) => setTimeout(r, 5));
  const out = seen.find((s) => s.path === '/v1/auth/sign-out');
  expect(out?.headers['X-Maka-Cookie']).toBe('1');
  expect(out?.headers.Authorization).toBeUndefined();
});
