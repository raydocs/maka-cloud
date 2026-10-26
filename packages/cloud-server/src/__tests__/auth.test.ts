import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import type { Mailer } from '../challenges.js';
import { clientAddress, proxyList } from '../auth-routes.js';
import { newConversation, postJson, startHarness } from './harness.js';
import { AUD, type Signer, signer, token } from './oidc-fixtures.js';

const LOOPBACK = ['127.0.0.1', '::1'];

interface Rig {
  h: Awaited<ReturnType<typeof startHarness>>;
  key: Signer;
  mail: Array<{ to: string; subject: string; text: string }>;
  codeOf(): string;
  /** An ID token for `sub`, signed by the fake provider, with the nonce the server just gave out. */
  idToken(provider: 'apple' | 'google', sub: string, nonce: string): string;
  nonce(): Promise<string>;
  call(
    method: string,
    path: string,
    body?: unknown,
    bearer?: string | null,
    headers?: Record<string, string>,
  ): Promise<Response>;
  google(sub: string, device?: string): Promise<Response>;
  /** Moves the clock of nonces, codes and rate limits on. */
  advance(ms: number): void;
}

async function rig(
  t: TestContext,
  limits: { perAddress?: number; guessesPerAddress?: number; total?: number } = {},
  trustedProxies: readonly string[] = [],
): Promise<Rig> {
  const key = signer('k1');
  let skew = 0;
  const mail: Rig['mail'] = [];
  const mailer: Mailer = {
    async send(message) {
      mail.push(message);
    },
  };
  const h = await startHarness(t, {
    auth: {
      apple: { audiences: [AUD] },
      google: { audiences: [AUD] },
      mailer,
      jwks: async () => ({ keys: [key.jwk] }),
      now: () => Date.now() + skew,
      ...(trustedProxies.length > 0 ? { trustedProxies } : {}),
      limits: { perAddress: 1_000, guessesPerAddress: 1_000, total: 10_000, ...limits },
    },
  });
  const call: Rig['call'] = (method, path, body, bearer = null, headers = {}) =>
    h.api(path, {
      method,
      token: bearer,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const nonce = async () =>
    ((await (await call('POST', '/v1/auth/nonce')).json()) as { nonce: string }).nonce;
  const idToken: Rig['idToken'] = (provider, sub, n) => {
    const now = Date.now() / 1000;
    return token(key, {
      iss: provider === 'apple' ? 'https://appleid.apple.com' : 'https://accounts.google.com',
      sub,
      nonce: n,
      exp: now + 600,
      iat: now - 5,
      email: `${sub}@example.com`,
    });
  };
  return {
    h,
    key,
    mail,
    advance: (ms) => {
      skew += ms;
    },
    codeOf: () => /\b(\d{6})\b/.exec(mail[mail.length - 1]?.text ?? '')?.[1] ?? '',
    idToken,
    nonce,
    call,
    google: async (sub, device = 'phone') => {
      const n = await nonce();
      return call('POST', '/v1/auth/session', {
        provider: 'google',
        idToken: idToken('google', sub, n),
        nonce: n,
        device,
      });
    },
  };
}

interface SignedIn {
  status: 'signed_in';
  token: string;
  sessionId: string;
}
interface NeedsInvite {
  status: 'needs_invite';
  pendingToken: string;
}

async function signUp(r: Rig, sub = 'g-ada', inviteToken = r.h.token): Promise<SignedIn> {
  const first = (await (await r.google(sub)).json()) as NeedsInvite;
  assert.equal(first.status, 'needs_invite');
  const claimed = await r.call('POST', '/v1/auth/claim', {
    pendingToken: first.pendingToken,
    inviteToken,
    device: 'phone',
  });
  assert.equal(claimed.status, 200);
  return (await claimed.json()) as SignedIn;
}

test('with no sign-in configured, /v1/auth answers like any unknown path', async (t) => {
  const h = await startHarness(t);
  const res = await h.api('/v1/auth/options', { token: null });
  assert.equal(res.status, 401);
});

test('the options say which ways in are on, without a token', async (t) => {
  const r = await rig(t);
  const res = await r.call('GET', '/v1/auth/options');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { apple: true, google: true, email: true });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('a new identity gets nothing until it brings an invite, then it is that invite', async (t) => {
  const r = await rig(t);
  const first = (await (await r.google('g-ada')).json()) as NeedsInvite;
  assert.equal(first.status, 'needs_invite');
  // the pending token reads nothing
  for (const path of ['/v1/conversations', '/v1/auth/sessions', '/v1/inbox/items']) {
    assert.equal((await r.call('GET', path, undefined, first.pendingToken)).status, 401, path);
  }
  const claimed = await r.call('POST', '/v1/auth/claim', {
    pendingToken: first.pendingToken,
    inviteToken: r.h.token,
    device: 'Ada’s phone',
  });
  assert.equal(claimed.status, 200);
  const session = (await claimed.json()) as SignedIn;
  assert.equal(session.status, 'signed_in');
  // the session is the invite: it sees what the invite made, and can add to it
  const conversationId = await newConversation(r.h);
  const posted = await postJson(
    r.h,
    `/v1/conversations/${conversationId}/messages`,
    { text: 'hi' },
    session.token,
  );
  assert.equal(posted.status, 202);
  const mine = (await (
    await r.call('GET', '/v1/conversations', undefined, session.token)
  ).json()) as {
    conversations: Array<{ conversationId: string }>;
  };
  assert.deepEqual(
    mine.conversations.map((c) => c.conversationId),
    [conversationId],
  );
  // a pending token is single use
  const again = await r.call('POST', '/v1/auth/claim', {
    pendingToken: first.pendingToken,
    inviteToken: r.h.token,
  });
  assert.equal(again.status, 401);
});

test('/v1/me names the account, the same for every session of it and for its invite', async (t) => {
  const r = await rig(t);
  const first = await signUp(r);
  const again = (await (await r.google('g-ada', 'laptop')).json()) as SignedIn;
  const other = await signUp(r, 'g-bob', r.h.server.invites.create('bob').token);
  const owner = async (bearer: string) => {
    const res = await r.call('GET', '/v1/me', undefined, bearer);
    assert.equal(res.status, 200);
    return ((await res.json()) as { ownerId: string }).ownerId;
  };
  const ada = await owner(first.token);
  assert.match(ada, /^inv_/u);
  assert.equal(await owner(again.token), ada);
  assert.equal(await owner(r.h.token), ada);
  assert.notEqual(await owner(other.token), ada);
  assert.equal((await r.call('POST', '/v1/me', {}, first.token)).status, 405);
  assert.equal((await r.call('GET', '/v1/me', undefined, null)).status, 401);
});

test('the same identity signs in again on another device, to the same invite', async (t) => {
  const r = await rig(t);
  const phone = await signUp(r);
  const next = (await (await r.google('g-ada', 'laptop')).json()) as SignedIn;
  assert.equal(next.status, 'signed_in');
  assert.notEqual(next.token, phone.token);
  const list = (await (await r.call('GET', '/v1/auth/sessions', undefined, next.token)).json()) as {
    sessions: Array<{ deviceLabel: string; current: boolean }>;
    identities: Array<{ provider: string; email?: string }>;
  };
  assert.deepEqual(list.sessions.map((s) => [s.deviceLabel, s.current]).sort(), [
    ['laptop', true],
    ['phone', false],
  ]);
  assert.deepEqual(list.identities, [{ provider: 'google', email: 'g-ada@example.com' }]);
  assert.equal(JSON.stringify(list).includes(phone.token), false);
});

test('an invite that is wrong, revoked or already in use is refused the same way, and a pending sign-in gives up after five tries', async (t) => {
  const r = await rig(t);
  await signUp(r, 'g-ada'); // takes the harness invite
  const other = r.h.server.invites.create('other');
  const gone = r.h.server.invites.create('gone');
  r.h.server.invites.revoke(gone.inviteId);
  const bodies: string[] = [];
  const pending = (await (await r.google('g-bob')).json()) as NeedsInvite;
  for (const inviteToken of ['mki_nope.nope', r.h.token, gone.token, 'x'.repeat(40)]) {
    const res = await r.call('POST', '/v1/auth/claim', {
      pendingToken: pending.pendingToken,
      inviteToken,
    });
    assert.equal(res.status, 403, inviteToken);
    bodies.push(await res.text());
  }
  assert.equal(new Set(bodies).size, 1, 'one answer for every reason');
  // a fifth try ends this sign-in, even with a good invite
  assert.equal(
    (
      await r.call('POST', '/v1/auth/claim', {
        pendingToken: pending.pendingToken,
        inviteToken: 'bad',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await r.call('POST', '/v1/auth/claim', {
        pendingToken: pending.pendingToken,
        inviteToken: other.token,
      })
    ).status,
    401,
  );
  // a new sign-in with the good invite works
  const fresh = (await (await r.google('g-bob')).json()) as NeedsInvite;
  assert.equal(
    (
      await r.call('POST', '/v1/auth/claim', {
        pendingToken: fresh.pendingToken,
        inviteToken: other.token,
      })
    ).status,
    200,
  );
});

test('a provider token that is replayed, forged or for a nonce we never gave is the same refusal', async (t) => {
  const r = await rig(t);
  const n = await r.nonce();
  const good = r.idToken('google', 'g-ada', n);
  const body = { provider: 'google', idToken: good, nonce: n };
  assert.equal((await r.call('POST', '/v1/auth/session', body)).status, 200);
  const replay = await r.call('POST', '/v1/auth/session', body);
  const unknown = await r.call('POST', '/v1/auth/session', { ...body, nonce: 'never-issued' });
  const n2 = await r.nonce();
  const forged = await r.call('POST', '/v1/auth/session', {
    provider: 'google',
    idToken: r.idToken('google', 'g-eve', 'other-nonce'),
    nonce: n2,
  });
  const apple = await r.call('POST', '/v1/auth/session', {
    provider: 'google',
    idToken: r.idToken('apple', 'g-ada', await r.nonce()),
    nonce: await r.nonce(),
  });
  for (const res of [replay, unknown, forged, apple]) assert.equal(res.status, 401);
  assert.equal(
    new Set(await Promise.all([replay, unknown, forged].map((x) => x.clone().text()))).size,
    1,
  );
});

test('a provider that is not configured is not found', async (t) => {
  const key = signer('k1');
  const h = await startHarness(t, {
    auth: { google: { audiences: [AUD] }, jwks: async () => ({ keys: [key.jwk] }) },
  });
  const res = await h.api('/v1/auth/session', {
    method: 'POST',
    token: null,
    body: JSON.stringify({ provider: 'apple', idToken: 'x', nonce: 'y' }),
  });
  assert.equal(res.status, 404);
  const options = (await (await h.api('/v1/auth/options', { token: null })).json()) as Record<
    string,
    boolean
  >;
  assert.deepEqual(options, { apple: false, google: true, email: false });
  assert.equal(
    (
      await h.api('/v1/auth/email', {
        method: 'POST',
        token: null,
        body: JSON.stringify({ address: 'a@b.co' }),
      })
    ).status,
    404,
  );
});

test('email: the code from the mail, with the device secret, signs in; another device cannot use it', async (t) => {
  const r = await rig(t);
  const asked = await r.call('POST', '/v1/auth/email', { address: ' Ada@Example.com ' });
  assert.equal(asked.status, 200);
  const challenge = (await asked.json()) as { challengeId: string; deviceSecret: string };
  assert.equal(r.mail[0]?.to, 'ada@example.com');
  assert.equal(JSON.stringify(challenge).includes(r.codeOf()), false);
  const verify = (secret: string, code = r.codeOf()) =>
    r.call('POST', '/v1/auth/email/verify', {
      challengeId: challenge.challengeId,
      deviceSecret: secret,
      code,
      device: 'phone',
    });
  assert.equal((await verify('not-my-secret')).status, 401);
  const ok = await verify(challenge.deviceSecret);
  assert.equal(ok.status, 200);
  const pending = (await ok.json()) as NeedsInvite;
  assert.equal(pending.status, 'needs_invite');
  assert.equal((await verify(challenge.deviceSecret)).status, 401, 'used once');
  const claimed = await r.call('POST', '/v1/auth/claim', {
    pendingToken: pending.pendingToken,
    inviteToken: r.h.token,
  });
  assert.equal(claimed.status, 200);
  // the next time, the address signs in without an invite
  r.advance(31_000);
  const again = (await (
    await r.call('POST', '/v1/auth/email', { address: 'ada@example.com' })
  ).json()) as {
    challengeId: string;
    deviceSecret: string;
  };
  const back = await r.call('POST', '/v1/auth/email/verify', {
    challengeId: again.challengeId,
    deviceSecret: again.deviceSecret,
    code: r.codeOf(),
  });
  assert.equal(((await back.json()) as SignedIn).status, 'signed_in');
});

test('email: a bad address is a 400, a second mail too soon is a 429, and the answer does not depend on an account', async (t) => {
  const r = await rig(t);
  await signUp(r, 'g-ada');
  assert.equal((await r.call('POST', '/v1/auth/email', { address: 'nope' })).status, 400);
  const a = await r.call('POST', '/v1/auth/email', { address: 'new@example.com' });
  const b = await r.call('POST', '/v1/auth/email', { address: 'g-ada@example.com' });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(
    Object.keys((await a.json()) as object).sort(),
    Object.keys((await b.json()) as object).sort(),
  );
  assert.equal(
    (await r.call('POST', '/v1/auth/email', { address: 'new@example.com' })).status,
    429,
  );
});

test('a signed-in device links a second provider after proving it, and either one then signs in to the same invite', async (t) => {
  const r = await rig(t);
  const ada = await signUp(r, 'g-ada');
  const n = await r.nonce();
  const link = await r.call(
    'POST',
    '/v1/auth/link',
    { provider: 'apple', idToken: r.idToken('apple', 'a-ada', n), nonce: n },
    ada.token,
  );
  assert.equal(link.status, 200);
  assert.equal(((await link.json()) as { status: string }).status, 'linked');
  const n2 = await r.nonce();
  const viaApple = (await (
    await r.call('POST', '/v1/auth/session', {
      provider: 'apple',
      idToken: r.idToken('apple', 'a-ada', n2),
      nonce: n2,
      device: 'tablet',
    })
  ).json()) as SignedIn;
  assert.equal(viaApple.status, 'signed_in');
  const list = (await (
    await r.call('GET', '/v1/auth/sessions', undefined, viaApple.token)
  ).json()) as {
    sessions: unknown[];
    identities: unknown[];
  };
  assert.equal(list.sessions.length, 2);
  assert.equal(list.identities.length, 2);
  // linking needs the proof, a bad token links nothing
  const n3 = await r.nonce();
  const bad = await r.call(
    'POST',
    '/v1/auth/link',
    { provider: 'apple', idToken: r.idToken('apple', 'a-eve', 'wrong'), nonce: n3 },
    ada.token,
  );
  assert.equal(bad.status, 401);
  // and without a session there is no linking at all
  assert.equal(
    (await r.call('POST', '/v1/auth/link', { provider: 'apple', idToken: 'x', nonce: n3 })).status,
    401,
  );
});

test('an identity that belongs to another account cannot be linked, and the invite holder can add the first one', async (t) => {
  const r = await rig(t);
  const ada = await signUp(r, 'g-ada');
  const bobInvite = r.h.server.invites.create('bob');
  const bob = await signUp(r, 'g-bob', bobInvite.token);
  const n = await r.nonce();
  const taken = await r.call(
    'POST',
    '/v1/auth/link',
    { provider: 'google', idToken: r.idToken('google', 'g-bob', n), nonce: n },
    ada.token,
  );
  assert.equal(taken.status, 409);
  assert.ok(bob.token);
  // someone who has only an invite token (no account yet) can link their first identity
  const carol = r.h.server.invites.create('carol');
  const n2 = await r.nonce();
  const first = await r.call(
    'POST',
    '/v1/auth/link',
    { provider: 'google', idToken: r.idToken('google', 'g-carol', n2), nonce: n2 },
    carol.token,
  );
  assert.equal(first.status, 200);
  const signedIn = (await (await r.google('g-carol')).json()) as SignedIn;
  assert.equal(signedIn.status, 'signed_in');
  const sees = await r.call('GET', '/v1/conversations', undefined, signedIn.token);
  assert.equal(sees.status, 200);
});

test('one device can sign another out, never another account’s, and signing out ends the device’s own session', async (t) => {
  const r = await rig(t);
  const phone = await signUp(r, 'g-ada');
  const laptop = (await (await r.google('g-ada', 'laptop')).json()) as SignedIn;
  const bobInvite = r.h.server.invites.create('bob');
  const bob = await signUp(r, 'g-bob', bobInvite.token);
  // bob cannot touch ada's devices
  assert.equal(
    (await r.call('DELETE', `/v1/auth/sessions/${phone.sessionId}`, undefined, bob.token)).status,
    404,
  );
  assert.equal((await r.call('GET', '/v1/conversations', undefined, phone.token)).status, 200);
  // ada signs her phone out from the laptop
  assert.equal(
    (await r.call('DELETE', `/v1/auth/sessions/${phone.sessionId}`, undefined, laptop.token))
      .status,
    204,
  );
  assert.equal((await r.call('GET', '/v1/conversations', undefined, phone.token)).status, 401);
  assert.equal(
    (await r.call('DELETE', `/v1/auth/sessions/${phone.sessionId}`, undefined, laptop.token))
      .status,
    404,
  );
  // the laptop signs itself out
  assert.equal((await r.call('POST', '/v1/auth/sign-out', {}, laptop.token)).status, 204);
  assert.equal((await r.call('GET', '/v1/conversations', undefined, laptop.token)).status, 401);
  // an invite token is not a device
  assert.equal((await r.call('POST', '/v1/auth/sign-out', {}, bobInvite.token)).status, 400);
});

test('an account whose invite was revoked cannot sign in, and its person can come back on a new invite', async (t) => {
  const r = await rig(t);
  const ada = await signUp(r, 'g-ada');
  r.h.server.invites.revoke(r.h.inviteId);
  assert.equal((await r.call('GET', '/v1/conversations', undefined, ada.token)).status, 401);
  // no way in with the old account: asked for an invite, like anyone new
  const again = (await (await r.google('g-ada')).json()) as NeedsInvite | SignedIn;
  assert.equal(again.status, 'needs_invite');
  const fresh = r.h.server.invites.create('ada again');
  const claimed = await r.call('POST', '/v1/auth/claim', {
    pendingToken: (again as NeedsInvite).pendingToken,
    inviteToken: fresh.token,
  });
  assert.equal(claimed.status, 200);
  const back = (await claimed.json()) as SignedIn;
  assert.equal((await r.call('GET', '/v1/conversations', undefined, back.token)).status, 200);
  // the old session stays dead, and the person signs in normally from now on
  assert.equal((await r.call('GET', '/v1/conversations', undefined, ada.token)).status, 401);
  assert.equal(((await (await r.google('g-ada')).json()) as SignedIn).status, 'signed_in');
});

test('an identity of a live account is never released by someone else’s claim', async (t) => {
  const r = await rig(t);
  await signUp(r, 'g-ada');
  const other = r.h.server.invites.create('other');
  const pending = (await (await r.google('g-ada', 'laptop')).json()) as SignedIn;
  assert.equal(pending.status, 'signed_in', 'ada still signs in');
  const bob = (await (await r.google('g-bob')).json()) as NeedsInvite;
  // bob claims a new invite: ada's identity and account are untouched
  assert.equal(
    (
      await r.call('POST', '/v1/auth/claim', {
        pendingToken: bob.pendingToken,
        inviteToken: other.token,
      })
    ).status,
    200,
  );
  assert.equal(((await (await r.google('g-ada')).json()) as SignedIn).status, 'signed_in');
});

test('behind a proxy each forwarded client has its own limits, and the header of a public caller is ignored', async (t) => {
  const r = await rig(t, { perAddress: 2, guessesPerAddress: 2 }, LOOPBACK);
  const wrong = (client: string) =>
    r.call(
      'POST',
      '/v1/auth/email/verify',
      { challengeId: 'x', deviceSecret: 'y', code: '000000' },
      null,
      { 'x-forwarded-for': `203.0.113.99, ${client}` },
    );
  assert.equal((await wrong('198.51.100.1')).status, 401);
  assert.equal((await wrong('198.51.100.1')).status, 401);
  assert.equal((await wrong('198.51.100.1')).status, 429, 'one client used its tries');
  assert.equal((await wrong('198.51.100.2')).status, 401, 'another client is not held up');
  // a client cannot pick its own bucket by forging earlier entries
  assert.equal((await wrong('198.51.100.1')).status, 429);
  // from a peer that is not the configured proxy the header means nothing, so it cannot pick a bucket
  const other = await rig(t, { perAddress: 2, guessesPerAddress: 2 }, ['192.0.2.7', '10.9.0.0/16']);
  const call = (client: string) =>
    other.call(
      'POST',
      '/v1/auth/email/verify',
      { challengeId: 'x', deviceSecret: 'y', code: '0' },
      null,
      {
        'x-forwarded-for': client,
      },
    );
  await call('198.51.100.1');
  await call('198.51.100.2');
  assert.equal((await call('198.51.100.3')).status, 429);
});

test('which address a request counts as', () => {
  const proxy = proxyList(['127.0.0.1', '::1', '172.29.80.0/24', '2001:db8::/32']);
  assert.equal(clientAddress('127.0.0.1', '198.51.100.7', proxy), '198.51.100.7');
  assert.equal(clientAddress('::1', '198.51.100.7', proxy), '198.51.100.7');
  assert.equal(clientAddress('::ffff:127.0.0.1', '198.51.100.7', proxy), '198.51.100.7');
  assert.equal(clientAddress('172.29.80.2', 'evil, 198.51.100.7', proxy), '198.51.100.7');
  assert.equal(clientAddress('2001:db8::5', '198.51.100.7', proxy), '198.51.100.7');
  assert.equal(clientAddress('127.0.0.1', undefined, proxy), '127.0.0.1');
  assert.equal(clientAddress('127.0.0.1', 'not an address', proxy), '127.0.0.1');
  assert.equal(clientAddress('127.0.0.1', '198.51.100.7, ', proxy), '127.0.0.1');
  // a peer that is not a configured proxy is its own client, whatever it forwards: a public one,
  // and a private one on the same network (a neighbour container, another process on the LAN)
  assert.equal(clientAddress('8.8.8.8', '198.51.100.7', proxy), '8.8.8.8');
  assert.equal(clientAddress('172.29.81.2', '198.51.100.7', proxy), '172.29.81.2');
  assert.equal(clientAddress('10.0.0.2', '198.51.100.7', proxy), '10.0.0.2');
  assert.equal(clientAddress('::ffff:172.29.81.2', '198.51.100.7', proxy), '::ffff:172.29.81.2');
  // no proxy configured: the header means nothing
  assert.equal(clientAddress('127.0.0.1', '198.51.100.7', undefined), '127.0.0.1');
});

test('a proxy list is read strictly', () => {
  for (const bad of [
    '',
    'proxy.example.com',
    '10.0.0.0/33',
    '::1/129',
    '10.0.0.1/',
    '1.2.3.4/8/9',
    '10.0.0.1/x',
  ]) {
    assert.throws(() => proxyList([bad]), /not an IP address or range/u, bad);
  }
  assert.equal(proxyList(['192.0.2.7'])('192.0.2.7'), true);
  assert.equal(proxyList(['192.0.2.7'])('192.0.2.8'), false);
  assert.equal(proxyList([])('127.0.0.1'), false);
});

test('a malformed session id is an id nobody has', async (t) => {
  const r = await rig(t);
  const ada = await signUp(r, 'g-ada');
  assert.equal((await r.call('DELETE', '/v1/auth/sessions/%zz', undefined, ada.token)).status, 404);
});

test('sign-in routes are rate limited per address, and the routes that try a secret more tightly', async (t) => {
  const r = await rig(t, { perAddress: 5, guessesPerAddress: 2 });
  assert.equal((await r.call('GET', '/v1/auth/options')).status, 200);
  const statuses: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    statuses.push(
      (
        await r.call('POST', '/v1/auth/email/verify', {
          challengeId: 'x',
          deviceSecret: 'y',
          code: '000000',
        })
      ).status,
    );
  }
  assert.deepEqual(statuses, [401, 401, 429]);
  assert.ok(
    (await r.call('POST', '/v1/auth/claim', { pendingToken: 'p', inviteToken: 'i' })).headers.get(
      'retry-after',
    ),
  );
  const total = await rig(t, { total: 2 });
  await total.call('GET', '/v1/auth/options');
  await total.call('GET', '/v1/auth/options');
  assert.equal((await total.call('GET', '/v1/auth/options')).status, 429);
});

test('sign-in bodies are strict', async (t) => {
  const r = await rig(t);
  const n = await r.nonce();
  for (const body of [
    {},
    { provider: 'github', idToken: 'x', nonce: n },
    { provider: 'google', idToken: 'x', nonce: n, extra: 1 },
    { provider: 'google', idToken: 'x'.repeat(9000), nonce: n },
  ]) {
    assert.equal(
      (await r.call('POST', '/v1/auth/session', body)).status,
      400,
      JSON.stringify(body).slice(0, 60),
    );
  }
  assert.equal((await r.call('POST', '/v1/auth/session', 'nope' as unknown)).status, 400);
  assert.equal((await r.call('GET', '/v1/auth/session')).status, 405);
});

test('a new account reads Chinese unless its sign-up asked for English, and a language chosen first is kept', async (t) => {
  const r = await rig(t);
  const language = async (bearer: string) =>
    (
      (await (await r.call('GET', '/v1/settings', undefined, bearer)).json()) as {
        language: string;
      }
    ).language;
  const claim = async (sub: string, inviteToken: string, headers: Record<string, string> = {}) => {
    const pending = (await (await r.google(sub)).json()) as NeedsInvite;
    const claimed = await r.call(
      'POST',
      '/v1/auth/claim',
      { pendingToken: pending.pendingToken, inviteToken },
      null,
      headers,
    );
    assert.equal(claimed.status, 200);
    return (await claimed.json()) as SignedIn;
  };
  const ada = await claim('g-ada', r.h.token, { 'accept-language': 'zh-CN,en;q=0.8' });
  assert.equal(await language(ada.token), 'zh-Hans');
  const bob = await claim('g-bob', r.h.server.invites.create('bob').token, {
    'accept-language': 'en-GB,en;q=0.9',
  });
  assert.equal(await language(bob.token), 'en');
  const chosen = r.h.server.invites.create('chosen');
  const set = await r.call('PATCH', '/v1/settings', { language: 'zh-Hans' }, chosen.token);
  assert.equal(set.status, 200);
  const cleo = await claim('g-cleo', chosen.token, { 'accept-language': 'en-US' });
  assert.equal(await language(cleo.token), 'zh-Hans', 'the choice made before sign-up wins');
});

test('the sign-in mail is in Chinese by default, in English when asked, and in the account’s language once it has one', async (t) => {
  const r = await rig(t);
  assert.equal(
    (await r.call('POST', '/v1/auth/email', { address: 'ada@example.com' })).status,
    200,
  );
  const zh = r.mail.at(-1);
  assert.equal(zh?.subject, '你的登录验证码');
  assert.equal(
    zh?.text,
    `你的登录验证码是 ${r.codeOf()}。它只能用一次，10 分钟内有效，请在发起请求的应用或网页中输入。如果不是你本人操作，请忽略这封邮件。`,
  );
  const en = await r.call('POST', '/v1/auth/email', { address: 'bob@example.com' }, null, {
    'accept-language': 'en-US,en;q=0.9',
  });
  assert.equal(en.status, 200);
  const challenge = (await en.json()) as { challengeId: string; deviceSecret: string };
  assert.equal(r.mail.at(-1)?.subject, 'Your sign-in code');
  assert.equal(
    r.mail.at(-1)?.text,
    `Your sign-in code is ${r.codeOf()}. It works once, for ten minutes, in the app or page that asked for it. If you did not ask, ignore this mail.`,
  );
  // Bob signs up from an English device: his account reads English, so his next code is English
  // even when asked for from a device set to Chinese.
  const verified = (await (
    await r.call('POST', '/v1/auth/email/verify', {
      challengeId: challenge.challengeId,
      deviceSecret: challenge.deviceSecret,
      code: r.codeOf(),
    })
  ).json()) as NeedsInvite;
  const claimed = await r.call(
    'POST',
    '/v1/auth/claim',
    { pendingToken: verified.pendingToken, inviteToken: r.h.token },
    null,
    { 'accept-language': 'en' },
  );
  assert.equal(claimed.status, 200);
  r.advance(31_000);
  await r.call('POST', '/v1/auth/email', { address: 'bob@example.com' }, null, {
    'accept-language': 'zh-CN',
  });
  assert.equal(r.mail.at(-1)?.subject, 'Your sign-in code');
});

test('an account whose language was never set gets the default in its mail, whatever the browser asks', async (t) => {
  const r = await rig(t);
  const asked = await r.call('POST', '/v1/auth/email', { address: 'dan@example.com' });
  const challenge = (await asked.json()) as { challengeId: string; deviceSecret: string };
  const verified = (await (
    await r.call('POST', '/v1/auth/email/verify', {
      challengeId: challenge.challengeId,
      deviceSecret: challenge.deviceSecret,
      code: r.codeOf(),
    })
  ).json()) as NeedsInvite;
  assert.equal(
    (
      await r.call('POST', '/v1/auth/claim', {
        pendingToken: verified.pendingToken,
        inviteToken: r.h.token,
      })
    ).status,
    200,
  );
  // As an account from before languages were kept: its invite has none stored.
  const raw = new DatabaseSync(r.h.options.invitesPath);
  raw.prepare('UPDATE invites SET language = NULL WHERE invite_id = ?').run(r.h.inviteId);
  raw.close();
  r.advance(31_000);
  await r.call('POST', '/v1/auth/email', { address: 'dan@example.com' }, null, {
    'accept-language': 'en-US',
  });
  assert.equal(r.mail.at(-1)?.subject, '你的登录验证码');
});

test('a sign-up from Taiwan, Hong Kong or Macau reads Traditional Chinese, by claim or by a first linked identity', async (t) => {
  const r = await rig(t);
  const language = async (bearer: string) =>
    (
      (await (await r.call('GET', '/v1/settings', undefined, bearer)).json()) as {
        language: string;
      }
    ).language;
  const claim = async (sub: string, inviteToken: string, acceptLanguage: string) => {
    const pending = (await (await r.google(sub)).json()) as NeedsInvite;
    const claimed = await r.call(
      'POST',
      '/v1/auth/claim',
      { pendingToken: pending.pendingToken, inviteToken },
      null,
      { 'accept-language': acceptLanguage },
    );
    assert.equal(claimed.status, 200);
    return (await claimed.json()) as SignedIn;
  };
  const cases: Array<[string, string]> = [
    ['zh-TW,zh;q=0.9,en;q=0.8', 'zh-Hant'],
    ['zh-HK', 'zh-Hant'],
    ['zh-MO', 'zh-Hant'],
    ['zh-Hant', 'zh-Hant'],
    ['zh-SG', 'zh-Hans'],
    ['zh', 'zh-Hans'],
  ];
  for (const [index, [header, expected]] of cases.entries()) {
    const invite = index === 0 ? r.h.token : r.h.server.invites.create(`p${index}`).token;
    const signedIn = await claim(`g-${index}`, invite, header);
    assert.equal(await language(signedIn.token), expected, header);
  }
  // A person who has only an invite token links their first identity from a Taiwan browser.
  const dora = r.h.server.invites.create('dora');
  const n = await r.nonce();
  const linked = await r.call(
    'POST',
    '/v1/auth/link',
    { provider: 'google', idToken: r.idToken('google', 'g-dora', n), nonce: n },
    dora.token,
    { 'accept-language': 'zh-TW' },
  );
  assert.equal(linked.status, 200);
  assert.equal(await language(dora.token), 'zh-Hant');
  // A choice made before sign-up wins over a Traditional Chinese browser.
  const chosen = r.h.server.invites.create('chosen');
  assert.equal(
    (await r.call('PATCH', '/v1/settings', { language: 'en' }, chosen.token)).status,
    200,
  );
  const eve = await claim('g-eve', chosen.token, 'zh-TW');
  assert.equal(await language(eve.token), 'en');
});

test('the sign-in mail is in Traditional Chinese for a Traditional Chinese request, and for an account that reads it', async (t) => {
  const r = await rig(t);
  const asked = await r.call('POST', '/v1/auth/email', { address: 'fay@example.com' }, null, {
    'accept-language': 'zh-HK,en;q=0.5',
  });
  assert.equal(asked.status, 200);
  assert.equal(r.mail.at(-1)?.subject, '你的登入驗證碼');
  assert.equal(
    r.mail.at(-1)?.text,
    `你的登入驗證碼是 ${r.codeOf()}。此驗證碼只能使用一次，10 分鐘內有效，請在提出要求的應用程式或網頁中輸入。如果不是你本人操作，請忽略這封信。`,
  );
  const challenge = (await asked.json()) as { challengeId: string; deviceSecret: string };
  const verified = (await (
    await r.call('POST', '/v1/auth/email/verify', {
      challengeId: challenge.challengeId,
      deviceSecret: challenge.deviceSecret,
      code: r.codeOf(),
    })
  ).json()) as NeedsInvite;
  const claimed = await r.call(
    'POST',
    '/v1/auth/claim',
    { pendingToken: verified.pendingToken, inviteToken: r.h.token },
    null,
    { 'accept-language': 'zh-TW' },
  );
  assert.equal(claimed.status, 200);
  // Her account reads Traditional Chinese, so her next code is too, whatever the browser asks.
  for (const header of ['en-US', 'zh-CN']) {
    r.advance(31_000);
    await r.call('POST', '/v1/auth/email', { address: 'fay@example.com' }, null, {
      'accept-language': header,
    });
    assert.equal(r.mail.at(-1)?.subject, '你的登入驗證碼', header);
  }
});
