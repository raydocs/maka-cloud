import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConversationHandler } from '../cloud-server.js';
import type { DutyService } from '../duties.js';
import { eventually, startHarness } from './harness.js';

type Call = { name: string; args: unknown[] };

function fakeDuties(overrides: Partial<DutyService> = {}) {
  const calls: Call[] = [];
  const project = (owner: string) => ({
    projectId: 'prj_1',
    owner,
    installationId: 99,
    repo: 'a/b',
    duties: [{ dutyId: 'dty_1', state: 'proposed' }],
  });
  const service: DutyService = {
    webhook: (headers, body) => {
      calls.push({
        name: 'webhook',
        args: [headers['x-github-event'], Buffer.from(body).toString()],
      });
      return { status: 202, body: { accepted: true } };
    },
    listProjects: (owner) => {
      calls.push({ name: 'list', args: [owner] });
      return owner === 'mine' ? [project(owner)] : [];
    },
    project: (owner, projectId) => {
      calls.push({ name: 'project', args: [owner, projectId] });
      return owner === 'mine' && projectId === 'prj_1' ? project(owner) : undefined;
    },
    addProject: (owner, input) => {
      calls.push({ name: 'add', args: [owner, input] });
      return { ok: true, project: project(owner) };
    },
    removeProject: (owner, projectId) => {
      calls.push({ name: 'remove', args: [owner, projectId] });
      return owner === 'mine' && projectId === 'prj_1';
    },
    setDutyState: (owner, dutyId, state) => {
      calls.push({ name: 'state', args: [owner, dutyId, state] });
      return 'ok';
    },
    propose: async (owner, projectId) => {
      calls.push({ name: 'propose', args: [owner, projectId] });
      return { ok: true, proposal: { proposalId: 'prp_1' } };
    },
    ...overrides,
  };
  return { service, calls };
}

async function setup(t: Parameters<typeof startHarness>[0], overrides: Partial<DutyService> = {}) {
  const fake = fakeDuties(overrides);
  const h = await startHarness(t, { duties: fake.service });
  // The fake knows one owner by the name "mine": bind the harness invite to it.
  const wrapped = fakeDuties({
    ...overrides,
    listProjects: (owner) => fake.service.listProjects(owner === h.inviteId ? 'mine' : owner),
    project: (owner, id) => fake.service.project(owner === h.inviteId ? 'mine' : owner, id),
    removeProject: (owner, id) =>
      fake.service.removeProject(owner === h.inviteId ? 'mine' : owner, id),
  });
  return { h, ...fake, wrapped };
}

const webhook = (h: Awaited<ReturnType<typeof startHarness>>, body = '{}') =>
  fetch(`${h.server.url}/github/webhook`, {
    method: 'POST',
    body,
    headers: { 'x-github-event': 'push', 'content-type': 'application/json' },
  });

test('the webhook needs no invite: it is handed to the engine with the raw body and headers', async (t) => {
  const { h, calls } = await setup(t);
  const res = await webhook(h, '{"a": 1}');
  assert.equal(res.status, 202);
  assert.deepEqual(calls, [{ name: 'webhook', args: ['push', '{"a": 1}'] }]);
});

test('the engine decides the answer to a rejected webhook; nothing else is done with it', async (t) => {
  const { h } = await setup(t, {
    webhook: () => ({ status: 401, body: { error: 'bad_signature' } }),
  });
  const res = await webhook(h);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'bad_signature' });
});

test('the webhook route answers like any unknown path when no engine runs', async (t) => {
  const h = await startHarness(t);
  const res = await webhook(h);
  assert.equal(res.status, 401, 'falls through to invite authentication');
});

test('the webhook accepts POST only and caps the body', async (t) => {
  const { h, calls } = await setup(t);
  const get = await fetch(`${h.server.url}/github/webhook`);
  assert.equal(get.status, 405);
  const big = await webhook(h, 'x'.repeat(1_048_577));
  assert.equal(big.status, 413);
  assert.equal(calls.length, 0, 'an oversized body never reaches the engine');
});

test('the webhook has a shared rate limit that does not touch invite routes', async (t) => {
  const fake = fakeDuties();
  const h = await startHarness(t, { duties: fake.service });
  let limited = 0;
  for (let i = 0; i < 700; i += 1) {
    const res = await webhook(h);
    if (res.status === 429) {
      limited += 1;
      assert.ok(Number(res.headers.get('retry-after')) >= 1);
    }
  }
  assert.ok(limited > 0, 'a flood is limited');
  const projects = await h.api('/v1/projects');
  assert.equal(projects.status, 200, 'invite routes have their own bucket');
});

test('every project route needs a valid invite', async (t) => {
  const { h, calls } = await setup(t);
  const revoked = h.server.invites.create('gone');
  h.server.invites.revoke(revoked.inviteId);
  const routes: Array<[string, string, unknown?]> = [
    ['GET', '/v1/projects'],
    ['POST', '/v1/projects', { repo: 'a/b' }],
    ['GET', '/v1/projects/prj_1'],
    ['DELETE', '/v1/projects/prj_1'],
    ['POST', '/v1/projects/prj_1/proposal'],
    ['PATCH', '/v1/projects/prj_1/duties/dty_1', { state: 'active' }],
  ];
  for (const [method, path, body] of routes) {
    for (const token of [null, 'not-a-token', revoked.token]) {
      const res = await h.api(path, {
        method,
        token,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  }
  assert.deepEqual(calls, []);
});

test('projects are shown without the owner or the installation', async (t) => {
  const { h, calls } = await setup(t);
  // The harness invite is not "mine": the fake lists nothing for it, which is the isolation case.
  const none = await h.api('/v1/projects');
  assert.deepEqual(await none.json(), { projects: [] });
  const added = await h.api('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ repo: 'a/b' }),
  });
  assert.equal(added.status, 201);
  const body = (await added.json()) as { project: Record<string, unknown> };
  assert.equal(body.project.projectId, 'prj_1');
  assert.equal('owner' in body.project, false);
  assert.equal('installationId' in body.project, false);
  assert.deepEqual(calls.find((call) => call.name === 'add')?.args, [h.inviteId, { repo: 'a/b' }]);
});

test("another invite's project answers 404 for read, delete, proposal and duty changes", async (t) => {
  const { h, calls } = await setup(t);
  for (const [method, path, body] of [
    ['GET', '/v1/projects/prj_1'],
    ['DELETE', '/v1/projects/prj_1'],
    ['PATCH', '/v1/projects/prj_1/duties/dty_1', { state: 'active' }],
  ] as const) {
    const res = await h.api(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  assert.equal(
    calls.some((call) => call.name === 'state'),
    false,
    'a duty of a project the caller does not own is never touched',
  );
});

test('the duty in the path must belong to the project in the path', async (t) => {
  const fake = fakeDuties();
  const h = await startHarness(t, {
    duties: {
      ...fake.service,
      project: (owner, id) =>
        id === 'prj_1'
          ? fake.service.project('mine', id) && { duties: [{ dutyId: 'dty_1' }] }
          : undefined,
    },
  });
  const other = await h.api('/v1/projects/prj_1/duties/dty_9', {
    method: 'PATCH',
    body: JSON.stringify({ state: 'active' }),
  });
  assert.equal(other.status, 404);
  const ok = await h.api('/v1/projects/prj_1/duties/dty_1', {
    method: 'PATCH',
    body: JSON.stringify({ state: 'active' }),
  });
  assert.equal(ok.status, 200);
});

test('a duty patch is strict, and an unapproved duty cannot be switched on', async (t) => {
  const { h } = await setup(t, { setDutyState: () => 'not_approved' });
  const bad = await h.api('/v1/projects/prj_1/duties/dty_1', {
    method: 'PATCH',
    body: JSON.stringify({ state: 'active', authority: 'merge-when-green' }),
  });
  assert.equal(bad.status, 400);
});

test('a duty is refused with 409 when it is not approved or the invite has all its enabled duties', async (t) => {
  for (const refusal of ['not_approved', 'duty_limit'] as const) {
    const fake = fakeDuties({ setDutyState: () => refusal });
    const h = await startHarness(t, {
      duties: { ...fake.service, project: () => ({ duties: [{ dutyId: 'dty_1' }] }) },
    });
    const response = await h.api('/v1/projects/prj_1/duties/dty_1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'active' }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: refusal });
  }
});

test('starting a conversation for a duty carries the taint and the run limits to the handler', async (t) => {
  const seen: Array<{ external?: boolean; run?: unknown; text: string }> = [];
  const handler: ConversationHandler = {
    onUserMessage: (message) => {
      seen.push(message);
    },
  };
  const h = await startHarness(t, { handler });
  const meta = {
    external: true,
    run: { dutyId: 'dty_1', authority: 'open-pr' as const, budgetUsd: 2 },
  };
  const first = h.server.startConversation({
    owner: h.inviteId,
    key: 'run_1',
    text: 'CI failed on main',
    meta,
  });
  assert.ok(first.ok);
  await eventually(() => seen.length === 1, 'delivery');
  assert.deepEqual(seen[0]?.run, meta.run);
  assert.equal(seen[0]?.external, true);
  // The same key starts nothing new.
  const again = h.server.startConversation({
    owner: h.inviteId,
    key: 'run_1',
    text: 'CI failed on main',
    meta,
  });
  assert.ok(again.ok && again.duplicate);
  assert.equal(again.ok && first.ok && again.conversationId, first.ok && first.conversationId);
  const list = (await (await h.api('/v1/conversations')).json()) as { conversations: unknown[] };
  assert.equal(list.conversations.length, 1);
});

test('a public post cannot carry meta, and an ordinary post carries none', async (t) => {
  const seen: Array<Record<string, unknown>> = [];
  const handler: ConversationHandler = {
    onUserMessage: (message) => void seen.push({ ...message }),
  };
  const h = await startHarness(t, { handler });
  const created = (await (
    await h.api('/v1/conversations', { method: 'POST', body: '{}' })
  ).json()) as { conversationId: string };
  const path = `/v1/conversations/${created.conversationId}/messages`;
  const forged = await h.api(path, {
    method: 'POST',
    body: JSON.stringify({
      text: 'hi',
      run: { dutyId: 'x', authority: 'merge-when-green', budgetUsd: 1000 },
    }),
  });
  assert.equal(forged.status, 400, 'a client cannot choose run limits');
  const plain = await h.api(path, { method: 'POST', body: JSON.stringify({ text: 'hi' }) });
  assert.equal(plain.status, 202);
  await eventually(() => seen.length === 1, 'delivery');
  assert.equal('external' in (seen[0] ?? {}), false);
  assert.equal('run' in (seen[0] ?? {}), false);
});

test('meta survives a restart before the handler acknowledges the message', async (t) => {
  const first: ConversationHandler = { onUserMessage: () => new Promise<void>(() => undefined) };
  const h = await startHarness(t, { handler: first });
  const meta = {
    external: true,
    run: { dutyId: 'dty_1', authority: 'read-only' as const, budgetUsd: 1 },
  };
  assert.ok(h.server.startConversation({ owner: h.inviteId, key: 'k', text: 'go', meta }).ok);
  const seen: Array<Record<string, unknown>> = [];
  await h.restart({ handler: { onUserMessage: (message) => void seen.push({ ...message }) } });
  await eventually(() => seen.length === 1, 'redelivery');
  assert.equal(seen[0]?.external, true);
  assert.deepEqual(seen[0]?.run, meta.run);
});

test('startConversation refuses an inactive owner, a bad key, bad meta and an empty text', async (t) => {
  const h = await startHarness(t);
  const meta = { external: false };
  const gone = h.server.invites.create('gone');
  h.server.invites.revoke(gone.inviteId);
  assert.deepEqual(
    h.server.startConversation({ owner: gone.inviteId, key: 'k', text: 'x', meta }),
    {
      ok: false,
      reason: 'owner_inactive',
    },
  );
  for (const bad of [
    { key: 'has space', text: 'x', meta },
    { key: 'k', text: '', meta },
    {
      key: 'k',
      text: 'x',
      meta: { external: true, run: { dutyId: 'd', authority: 'root', budgetUsd: 1 } },
    },
    {
      key: 'k',
      text: 'x',
      meta: { external: true, run: { dutyId: 'd', authority: 'open-pr', budgetUsd: -1 } },
    },
  ]) {
    const result = h.server.startConversation({ owner: h.inviteId, ...bad } as never);
    assert.deepEqual(result, { ok: false, reason: 'invalid' });
  }
  const list = (await (await h.api('/v1/conversations')).json()) as { conversations: unknown[] };
  assert.equal(list.conversations.length, 0);
});

test('two owners with the same start key get two conversations', async (t) => {
  const h = await startHarness(t);
  const other = h.server.invites.create('other');
  const a = h.server.startConversation({
    owner: h.inviteId,
    key: 'same',
    text: 'x',
    meta: { external: false },
  });
  const b = h.server.startConversation({
    owner: other.inviteId,
    key: 'same',
    text: 'x',
    meta: { external: false },
  });
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.ok && a.conversationId, b.ok && b.conversationId);
});

test('createConversation makes one empty conversation per key and owner, and delivers nothing', async (t) => {
  let delivered = 0;
  const h = await startHarness(t, { handler: { onUserMessage: () => void (delivered += 1) } });
  const first = h.server.createConversation({
    owner: h.inviteId,
    key: 'proposal:1',
    title: 'Set up',
  });
  const again = h.server.createConversation({ owner: h.inviteId, key: 'proposal:1' });
  assert.ok(first.ok && again.ok);
  assert.equal(first.ok && first.conversationId, again.ok && again.conversationId);
  const gone = h.server.invites.create('gone');
  h.server.invites.revoke(gone.inviteId);
  assert.deepEqual(h.server.createConversation({ owner: gone.inviteId, key: 'k' }), {
    ok: false,
    reason: 'owner_inactive',
  });
  assert.deepEqual(h.server.createConversation({ owner: h.inviteId, key: 'bad key' }), {
    ok: false,
    reason: 'invalid',
  });
  assert.equal(delivered, 0);
});

test('a proposal the engine cannot offer answers 503, and a failed inspection 502', async (t) => {
  const h = await startHarness(t, {
    duties: fakeDuties({
      propose: async (_owner, projectId) =>
        projectId === 'prj_down'
          ? { ok: false, reason: 'unavailable' }
          : { ok: false, reason: 'inspect_failed' },
    }).service,
  });
  assert.equal((await h.api('/v1/projects/prj_down/proposal', { method: 'POST' })).status, 503);
  assert.equal((await h.api('/v1/projects/prj_x/proposal', { method: 'POST' })).status, 502);
});

test('startedConversation finds the conversation a key made for its owner, and nothing for anyone else', async (t) => {
  const h = await startHarness(t, { handler: { onUserMessage: () => undefined } });
  const meta = {
    external: false,
    run: { dutyId: 'dty_1', authority: 'read-only' as const, budgetUsd: 1 },
  };
  assert.equal(h.server.startedConversation({ owner: h.inviteId, key: 'run_9' }), undefined);
  const started = h.server.startConversation({
    owner: h.inviteId,
    key: 'run_9',
    text: 'go',
    meta,
  });
  assert.ok(started.ok);
  assert.deepEqual(h.server.startedConversation({ owner: h.inviteId, key: 'run_9' }), {
    conversationId: started.ok ? started.conversationId : '',
  });
  assert.equal(
    h.server.startedConversation({ owner: 'inv_somebody_else', key: 'run_9' }),
    undefined,
  );
  assert.equal(h.server.startedConversation({ owner: h.inviteId, key: 'run_10' }), undefined);
});

test('a conversation made for a key but never posted to is not a started one, until its first message is stored', async (t) => {
  const h = await startHarness(t, { handler: { onUserMessage: () => undefined } });
  const meta = {
    external: false,
    run: { dutyId: 'dty_1', authority: 'read-only' as const, budgetUsd: 1 },
  };
  // A start is two commits: the conversation, then its first message. A crash between them
  // leaves the first alone, which is what an empty conversation under the key looks like.
  const made = h.server.createConversation({ owner: h.inviteId, key: 'run_7', title: 'a run' });
  assert.ok(made.ok);
  assert.equal(h.server.startedConversation({ owner: h.inviteId, key: 'run_7' }), undefined);

  // The retry finds that conversation, posts the message once, and now the start is real.
  const started = h.server.startConversation({
    owner: h.inviteId,
    key: 'run_7',
    text: 'go',
    meta,
  });
  assert.ok(started.ok);
  assert.equal(started.ok && started.conversationId, made.ok && made.conversationId);
  assert.deepEqual(h.server.startedConversation({ owner: h.inviteId, key: 'run_7' }), {
    conversationId: made.ok ? made.conversationId : '',
  });
});
