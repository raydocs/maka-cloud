import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import type { GrantsService, InboxAnswerResult, InboxService, PublicGrant } from '../inbox.js';
import { newConversation, startHarness } from './harness.js';

interface Calls {
  list: unknown[];
  answer: unknown[];
  mute: unknown[];
  settings: unknown[];
  digest: string[];
}

function fakeService(overrides: Partial<InboxService> = {}) {
  const calls: Calls = { list: [], answer: [], mute: [], settings: [], digest: [] };
  const byOwner = new Map<string, { mutedKinds: string[] }>();
  const service: InboxService = {
    list: async (query) => {
      calls.list.push(query);
      return { items: [{ itemId: 'itm_1', version: 1 }], next: null };
    },
    answer: async (request) => {
      calls.answer.push(request);
      return { ok: true, duplicate: false, item: { state: 'closed' } };
    },
    setMute: (owner, kind, muted) => {
      calls.mute.push([owner, kind, muted]);
      if (kind !== 'finished' && kind !== 'decision') return { ok: false };
      const settings = { mutedKinds: muted ? [kind] : [] };
      byOwner.set(owner, settings);
      return { ok: true, settings };
    },
    settings: (owner) => byOwner.get(owner) ?? { mutedKinds: [] },
    updateSettings: (owner, patch) => {
      calls.settings.push([owner, patch]);
      const ok = (patch as { quietHours?: unknown }).quietHours !== undefined;
      if (ok) byOwner.set(owner, patch as { mutedKinds: string[] });
      return ok ? { ok: true, settings: patch } : { ok: false };
    },
    digest: async (owner) => {
      calls.digest.push(owner);
      return { digestId: `dig_${owner}` };
    },
    stop: async () => undefined,
    ...overrides,
  };
  return { service, calls };
}

const ANSWER = { answerId: 'ans_1', optionId: 'fix', preconditionHash: 'h1' };

async function setup(
  t: Parameters<typeof startHarness>[0],
  overrides: Partial<InboxService> = {},
  http = {},
) {
  const fake = fakeService(overrides);
  const h = await startHarness(t, { supervisor: () => fake.service, http });
  return { h, ...fake };
}

const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });

test('every inbox route needs a valid invite, including with a revoked or malformed token', async (t) => {
  const { h, calls } = await setup(t);
  const routes: Array<[string, string, unknown?]> = [
    ['GET', '/v1/inbox/items'],
    ['POST', '/v1/inbox/items/itm_1/answer', ANSWER],
    ['PUT', '/v1/inbox/mutes/finished'],
    ['DELETE', '/v1/inbox/mutes/finished'],
    ['GET', '/v1/inbox/settings'],
    ['PUT', '/v1/inbox/settings', { stallAfterMinutes: 45 }],
    ['POST', '/v1/inbox/digest'],
    ['GET', '/v1/inbox/grants'],
    ['DELETE', '/v1/inbox/grants/grant_1'],
    ['POST', '/v1/inbox/grants/revoke', {}],
  ];
  const revoked = h.server.invites.create('gone');
  h.server.invites.revoke(revoked.inviteId);
  for (const [method, path, body] of routes) {
    for (const token of [null, 'not-a-token', revoked.token]) {
      const res = await h.api(path, {
        method,
        token,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(res.status, 401, `${method} ${path} with ${token}`);
      assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    }
  }
  assert.deepEqual(calls, { list: [], answer: [], mute: [], settings: [], digest: [] });
});

test('the list passes its filters on, with bounds, and shows where the next page starts', async (t) => {
  const { h, calls } = await setup(t, {
    list: async (query) => {
      calls.list.push(query);
      return { items: [{ itemId: 'a' }], next: 7 };
    },
  });
  const res = await h.api('/v1/inbox/items?state=all&after=3&limit=1000');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { items: [{ itemId: 'a' }], next: 7 });
  await h.api('/v1/inbox/items');
  const conversationId = await newConversation(h);
  await h.api('/v1/inbox/items?limit=0');
  // The caller's own conversations scope the list.
  assert.deepEqual(calls.list, [
    { state: 'all', after: 3, limit: 200, conversations: [] },
    { state: 'open', after: 0, limit: 50, conversations: [] },
    { state: 'open', after: 0, limit: 1, conversations: [conversationId] },
  ]);
  for (const query of ['state=bogus', 'after=-1', 'limit=x', 'after=1.5']) {
    assert.equal((await h.api(`/v1/inbox/items?${query}`)).status, 400, query);
  }
  assert.equal(calls.list.length, 3);
});

test('an answer is passed on as sent and the status says whether delivery is still going', async (t) => {
  const outcomes: InboxAnswerResult[] = [
    { ok: true, duplicate: false, item: { state: 'closed' } },
    { ok: true, duplicate: false, item: { state: 'answering' } },
    { ok: true, duplicate: true, item: { state: 'closed' } },
  ];
  const { h, calls } = await setup(t, {
    answer: async (request) => (calls.answer.push(request), outcomes.shift() as InboxAnswerResult),
  });
  const first = await h.api('/v1/inbox/items/itm_1/answer', json({ ...ANSWER, text: 'go ahead' }));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { duplicate: false, item: { state: 'closed' } });
  const second = await h.api('/v1/inbox/items/itm%5F2/answer', json(ANSWER));
  assert.equal(second.status, 202);
  const third = await h.api('/v1/inbox/items/itm_1/answer', json(ANSWER));
  assert.equal(third.status, 200);
  assert.equal(((await third.json()) as { duplicate: boolean }).duplicate, true);
  const scope = { caller: h.inviteId, conversations: [] };
  assert.deepEqual(calls.answer, [
    { itemId: 'itm_1', ...ANSWER, text: 'go ahead', ...scope },
    { itemId: 'itm_2', ...ANSWER, ...scope },
    { itemId: 'itm_1', ...ANSWER, ...scope },
  ]);
});

test('each way an answer can be refused has its own status, and a stale answer carries the refreshed item', async (t) => {
  const reasons: Record<string, number> = {
    not_found: 404,
    invalid_request: 400,
    invalid_option: 400,
    text_not_allowed: 400,
    text_too_long: 400,
    stale: 409,
    closed: 409,
    already_answered: 409,
    question_open: 409,
    unavailable: 503,
    stopped: 503,
  };
  let reason = '';
  const { h } = await setup(t, {
    answer: async () => ({ ok: false, reason, item: { itemId: 'itm_1', version: 2 } }),
  });
  for (const [name, status] of Object.entries(reasons)) {
    reason = name;
    const res = await h.api('/v1/inbox/items/itm_1/answer', json(ANSWER));
    assert.equal(res.status, status, name);
    assert.deepEqual(await res.json(), { error: name, item: { itemId: 'itm_1', version: 2 } });
  }
});

test('a refusal the server does not know is an internal error, never a success', async (t) => {
  const { h } = await setup(t, { answer: async () => ({ ok: false, reason: 'surprise' }) });
  const res = await h.api('/v1/inbox/items/itm_1/answer', json(ANSWER));
  assert.equal(res.status, 500);
});

test('an answer body with missing, extra or oversized fields never reaches the supervisor', async (t) => {
  const { h, calls } = await setup(t);
  const bodies: unknown[] = [
    {},
    { ...ANSWER, answerId: '' },
    { ...ANSWER, answerId: 'x'.repeat(65) },
    { ...ANSWER, preconditionHash: undefined },
    { ...ANSWER, extra: 1 },
    { ...ANSWER, optionId: 7 },
    { ...ANSWER, text: 'x'.repeat(4001) },
    [],
    'text',
  ];
  for (const body of bodies) {
    const res = await h.api('/v1/inbox/items/itm_1/answer', json(body));
    assert.equal(res.status, 400, JSON.stringify(body)?.slice(0, 60));
  }
  assert.equal(
    (await h.api('/v1/inbox/items/itm_1/answer', { method: 'POST', body: '{nope' })).status,
    400,
  );
  assert.equal((await h.api('/v1/inbox/items/itm_1/answer', { method: 'POST' })).status, 400);
  assert.equal(
    (await h.api('/v1/inbox/items/itm_1/answer', json({ ...ANSWER, text: 'x'.repeat(70_000) })))
      .status,
    413,
  );
  assert.deepEqual(calls.answer, []);
});

test('the mutes, the settings and the digest are each invite’s own, and one invite never sees or changes another’s', async (t) => {
  const { h, calls } = await setup(t);
  const other = h.server.invites.create('other');
  const mine = await (await h.api('/v1/inbox/mutes/finished', { method: 'PUT' })).json();
  assert.deepEqual(mine, { settings: { mutedKinds: ['finished'] } });
  // The other invite sees nothing of it, and its own digest is its own.
  const theirs = await h.api('/v1/inbox/settings', { token: other.token });
  assert.deepEqual(await theirs.json(), { settings: { mutedKinds: [] } });
  const back = await h.api('/v1/inbox/settings');
  assert.deepEqual(await back.json(), { settings: { mutedKinds: ['finished'] } });
  const put = await h.api('/v1/inbox/settings', {
    method: 'PUT',
    token: other.token,
    body: JSON.stringify({ quietHours: { start: '22:00', end: '07:00' } }),
  });
  assert.equal(put.status, 200);
  assert.deepEqual(await (await h.api('/v1/inbox/settings')).json(), {
    settings: { mutedKinds: ['finished'] },
  });
  const unmute = await h.api('/v1/inbox/mutes/finished', { method: 'DELETE' });
  assert.deepEqual(await unmute.json(), { settings: { mutedKinds: [] } });
  await h.api('/v1/inbox/digest', { method: 'POST' });
  await h.api('/v1/inbox/digest', { method: 'POST', token: other.token });
  const owners = calls.mute.map((call) => (call as unknown[])[0]);
  assert.equal(new Set(owners).size, 1, 'every mute named the caller as its owner');
  assert.equal(calls.digest.length, 2);
  assert.notEqual(calls.digest[0], calls.digest[1], 'each digest is for the caller');
  assert.deepEqual(
    (calls.settings[0] as unknown[])[0],
    calls.digest[1],
    'the settings write was the other invite’s',
  );
});

test('settings replies expose only owner choices and mute and quiet-hour defaults', async (t) => {
  const visible = {
    mutedKinds: ['budget', 'finished'],
    quietHours: { start: '22:00', end: '07:00' },
    timeZone: 'Europe/Paris',
  };
  const settings = {
    ...visible,
    maxInterruptsPerHour: 6,
    verifierDailyCapUsd: 5,
    stallAfterMinutes: 30,
    queuedStallAfterMinutes: 10,
    digestAt: '08:00',
    futureOperatorSetting: 'private',
  };
  const { h } = await setup(t, {
    settings: () => settings,
    updateSettings: () => ({ ok: true, settings }),
    setMute: () => ({ ok: true, settings }),
  });
  const other = h.server.invites.create('other');
  for (const token of [h.token, other.token]) {
    for (const [method, path, body] of [
      ['GET', '/v1/inbox/settings'],
      ['PUT', '/v1/inbox/settings', { quietHours: visible.quietHours }],
      ['PUT', '/v1/inbox/mutes/finished'],
      ['DELETE', '/v1/inbox/mutes/finished'],
    ] as const) {
      await t.test(
        `${method} ${path} for ${token === h.token ? 'first' : 'other'} invite`,
        async () => {
          const res = await h.api(path, {
            method,
            token,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          assert.equal(res.status, 200);
          assert.deepEqual(await res.json(), { settings: visible });
        },
      );
    }
  }
});

test('the owner routes refuse what they cannot take: an unknown kind, settings the service rejects, a wrong method', async (t) => {
  const { h } = await setup(t);
  assert.equal((await h.api('/v1/inbox/mutes/nonsense', { method: 'PUT' })).status, 404);
  assert.equal((await h.api('/v1/inbox/mutes/finished', { method: 'GET' })).status, 405);
  const bad = await h.api('/v1/inbox/settings', {
    method: 'PUT',
    body: JSON.stringify({ stallAfterMinutes: 45 }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await h.api('/v1/inbox/settings', { method: 'POST' })).status, 405);
  assert.equal((await h.api('/v1/inbox/digest', { method: 'GET' })).status, 405);
});

test('a digest is shown scrubbed like an item', async (t) => {
  const { h } = await setup(t, {
    digest: async () => ({
      digestId: 'dig_1',
      summary: 'Fixed it with ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      items: [{ itemId: 'itm_1', ask: 'Use token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789?' }],
    }),
  });
  const body = JSON.stringify(await (await h.api('/v1/inbox/digest', { method: 'POST' })).json());
  assert.ok(!body.includes('ghp_AbCdEfGhIjKlMnOpQrStUvWxYz'), body);
});

test('answers are rate limited per invite before the body is read, and a refused call reaches nothing', async (t) => {
  const { h, calls } = await setup(t, {}, { controlPerMinute: 2 });
  const first = await h.api('/v1/inbox/items/itm_1/answer', json(ANSWER));
  const second = await h.api('/v1/inbox/items/itm_1/answer', json(ANSWER));
  // Not even a valid body: the limit comes first.
  const third = await h.api('/v1/inbox/items/itm_1/answer', json({}));
  assert.deepEqual([first.status, second.status, third.status], [200, 200, 429]);
  assert.ok(Number(third.headers.get('retry-after')) >= 1);
  assert.equal(calls.answer.length, 2);
  // Reads are not limited.
  assert.equal((await h.api('/v1/inbox/items')).status, 200);
  // Another invite has a bucket of its own.
  const other = h.server.invites.create('other');
  const res = await h.api('/v1/inbox/items/itm_1/answer', { ...json(ANSWER), token: other.token });
  assert.equal(res.status, 200);
});

test('a service that throws is an internal error without its message, and the server keeps serving', async (t) => {
  const { h } = await setup(t, {
    list: async () => {
      throw new Error('secret detail');
    },
  });
  const res = await h.api('/v1/inbox/items');
  assert.equal(res.status, 500);
  assert.equal(await res.text(), JSON.stringify({ error: 'internal_error' }));
  assert.equal((await h.api('/v1/conversations')).status, 200);
});

test('an unknown path under /v1/inbox is 404 for an invited client', async (t) => {
  const { h } = await setup(t);
  assert.equal((await h.api('/v1/inbox/nope')).status, 404);
  assert.equal((await h.api('/v1/inbox/items/itm_1')).status, 404);
});

test('a device signed out while its answer was arriving does not get the answer through', async (t) => {
  const { h, calls } = await setup(t);
  const accounts = h.server.accounts;
  const accountId = accounts.createAccount(h.inviteId) ?? assert.fail('no account');
  const session = accounts.issueSession(accountId, 'phone') ?? assert.fail('no session');
  const body = JSON.stringify(ANSWER);
  const { port } = new URL(h.server.url);
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      {
        port: Number(port),
        host: '127.0.0.1',
        method: 'POST',
        path: '/v1/inbox/items/itm_1/answer',
        headers: {
          authorization: `Bearer ${session.token}`,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    // The head and half the body are in; the device is signed out; the rest arrives.
    req.write(body.slice(0, 10));
    setTimeout(() => {
      accounts.revokeSession(accountId, session.sessionId);
      req.end(body.slice(10));
    }, 50);
  });
  assert.equal(status, 401);
  assert.deepEqual(calls.answer, []);
});

function fakeGrants() {
  const calls: unknown[][] = [];
  const grant = (grantId: string, repository: string): PublicGrant => ({
    grantId,
    tool: 'open_pull_request',
    repository,
    scope: 'repository',
    createdAt: 1,
    expiresAt: 2,
    uses: 0,
    lastUsedAt: null,
  });
  const mine = new Map([['inv_x', [grant('grant_1', 'acme/widgets')]]]);
  const service: GrantsService = {
    list: (owner) => (calls.push(['list', owner]), mine.get(owner) ?? []),
    revoke: (owner, grantId) => (
      calls.push(['revoke', owner, grantId]),
      (mine.get(owner) ?? []).some((entry) => entry.grantId === grantId)
    ),
    revokeAll: (owner, filter) => (calls.push(['revokeAll', owner, filter]), 2),
  };
  return { service, calls, mine };
}

test('the grants routes show and revoke the caller’s own approvals only, and answer 404 where nothing keeps them', async (t) => {
  const none = await setup(t);
  assert.equal((await none.h.api('/v1/inbox/grants')).status, 404);
  assert.equal((await none.h.api('/v1/inbox/grants/grant_1', { method: 'DELETE' })).status, 404);

  const { service, calls, mine } = fakeGrants();
  const { h } = await setup(t, { grants: service });
  const me = h.server.invites.create('me');
  mine.set(me.inviteId, [
    { ...mine.get('inv_x')?.[0], grantId: 'grant_me', repository: 'acme/widgets' } as PublicGrant,
  ]);
  const other = h.server.invites.create('other');
  const asMe = { token: me.token };
  const asOther = { token: other.token };

  const listed = await h.api('/v1/inbox/grants', asMe);
  assert.equal(listed.status, 200);
  assert.deepEqual(
    ((await listed.json()) as { grants: Array<{ grantId: string }> }).grants.map((g) => g.grantId),
    ['grant_me'],
  );
  assert.deepEqual(
    ((await (await h.api('/v1/inbox/grants', asOther)).json()) as { grants: unknown[] }).grants,
    [],
  );

  // Another owner's grant, an unknown one and a second revoke all answer 404.
  for (const [opts, id] of [
    [asOther, 'grant_me'],
    [asMe, 'grant_nope'],
  ] as const) {
    assert.equal(
      (await h.api(`/v1/inbox/grants/${id}`, { ...opts, method: 'DELETE' })).status,
      404,
    );
  }
  const revoked = await h.api('/v1/inbox/grants/grant_me', { ...asMe, method: 'DELETE' });
  assert.equal(revoked.status, 200);
  assert.deepEqual(await revoked.json(), { revoked: true });

  const bulk = await h.api('/v1/inbox/grants/revoke', {
    ...asMe,
    ...json({ repository: 'acme/widgets' }),
  });
  assert.deepEqual(await bulk.json(), { revoked: 2 });
  assert.deepEqual(calls.at(-1), ['revokeAll', me.inviteId, { repository: 'acme/widgets' }]);

  // A body with anything else in it is refused, and the wrong method too.
  assert.equal(
    (await h.api('/v1/inbox/grants/revoke', { ...asMe, ...json({ owner: 'inv_x' }) })).status,
    400,
  );
  // An id that is not valid percent-encoding is no grant, not a server error.
  assert.equal((await h.api('/v1/inbox/grants/%E0', { ...asMe, method: 'DELETE' })).status, 404);
  assert.equal((await h.api('/v1/inbox/grants', { ...asMe, method: 'POST' })).status, 405);
  assert.equal((await h.api('/v1/inbox/grants/grant_me', asMe)).status, 405);
});
