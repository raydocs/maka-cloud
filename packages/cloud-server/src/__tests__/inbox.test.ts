import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InboxAnswerResult, InboxService } from '../inbox.js';
import { newConversation, startHarness } from './harness.js';

interface Calls {
  list: unknown[];
  answer: unknown[];
  mute: unknown[];
  settings: unknown[];
  digest: number;
}

function fakeService(overrides: Partial<InboxService> = {}) {
  const calls: Calls = { list: [], answer: [], mute: [], settings: [], digest: 0 };
  const service: InboxService = {
    list: async (query) => {
      calls.list.push(query);
      return { items: [{ itemId: 'itm_1', version: 1 }], next: null };
    },
    answer: async (request) => {
      calls.answer.push(request);
      return { ok: true, duplicate: false, item: { state: 'closed' } };
    },
    setMute: (kind, muted) => {
      calls.mute.push([kind, muted]);
      return kind === 'finished' || kind === 'decision'
        ? { ok: true, settings: { mutedKinds: muted ? [kind] : [] } }
        : { ok: false };
    },
    settings: () => ({ stallAfterMinutes: 30 }),
    updateSettings: (patch) => {
      calls.settings.push(patch);
      const ok = (patch as { stallAfterMinutes?: unknown }).stallAfterMinutes === 45;
      return ok ? { ok: true, settings: patch } : { ok: false };
    },
    digest: async () => {
      calls.digest += 1;
      return { digestId: 'dig_1' };
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
  assert.deepEqual(calls, { list: [], answer: [], mute: [], settings: [], digest: 0 });
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

test('the mutes, the settings and the digest are shared by every owner, so no invite reaches them', async (t) => {
  const { h, calls } = await setup(t);
  const routes: Array<[string, string, unknown?]> = [
    ['PUT', '/v1/inbox/mutes/finished'],
    ['DELETE', '/v1/inbox/mutes/finished'],
    ['GET', '/v1/inbox/settings'],
    ['PUT', '/v1/inbox/settings', { stallAfterMinutes: 45 }],
    ['POST', '/v1/inbox/digest'],
  ];
  for (const [method, path, body] of routes) {
    const res = await h.api(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  }
  assert.deepEqual(calls, { list: [], answer: [], mute: [], settings: [], digest: 0 });
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
