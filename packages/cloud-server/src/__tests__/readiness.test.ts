import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountReadiness } from '../readiness.js';
import { toPublicView } from '../public-view.js';
import type { TaskView } from '@maka-cloud/orchestrator';
import { newConversation, postJson, startHarness } from './harness.js';

const facts = {
  language: false,
  project: false,
  model: false,
  notifications: false,
  conversation: false,
};

test('setup has a stable order; later expires and completion wins', () => {
  assert.deepEqual(
    accountReadiness(facts, new Map(), 10).cards.map((c) => c.id),
    Object.keys(facts),
  );
  const later = new Map([
    ['language', 20],
    ['model', 20],
  ]);
  const result = accountReadiness({ ...facts, model: true }, later, 19);
  assert.deepEqual(result.completed, ['model']);
  assert.deepEqual(
    result.cards.map((c) => c.id),
    ['project', 'notifications', 'conversation'],
  );
  assert.equal(accountReadiness(facts, later, 20).cards.length, 5);
});

test('Home readiness uses stored facts, persists later, isolates owners and never gates chat', async (t) => {
  const h = await startHarness(t, { modelAvailable: () => true });
  const readiness = async (token = h.token) => {
    const res = await h.api('/v1/home', { token });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      cards: unknown[];
      readiness: { completed: string[]; cards: { id: string; action: string }[] };
    };
    assert.ok(Array.isArray(body.cards));
    return body.readiness;
  };
  assert.deepEqual((await readiness()).completed, ['model']);
  assert.equal((await postJson(h, '/v1/home/setup', { dismiss: 'language' })).status, 200);
  assert.equal((await postJson(h, '/v1/home/setup', { notificationsAllowed: true })).status, 200);
  h.server.invites.setLanguage(h.inviteId, 'zh-Hant');
  const conversationId = await newConversation(h);
  assert.equal(
    (await postJson(h, `/v1/conversations/${conversationId}/messages`, { text: 'hello' })).status,
    202,
  );
  assert.deepEqual((await readiness()).completed, [
    'language',
    'model',
    'notifications',
    'conversation',
  ]);
  await h.restart();
  assert.deepEqual(
    (await readiness()).cards.map((c) => c.id),
    ['project'],
  );
  const other = h.server.invites.create('other');
  assert.deepEqual((await readiness(other.token)).completed, ['model']);
  assert.equal((await postJson(h, '/v1/home/setup', { dismiss: 'bad' })).status, 400);
  assert.equal(
    (await postJson(h, '/v1/home/setup', { notificationsAllowed: true, dismiss: 'model' })).status,
    400,
  );
  assert.equal((await postJson(h, '/v1/home/setup', { dismiss: 'project' }, null)).status, 401);
});

test('usage and a refused message expose the same typed reason, while duplicates remain idempotent', async (t) => {
  let blocked = false;
  const reason = {
    scope: 'day' as const,
    usedUsd: 5,
    limitUsd: 5,
    resetsAt: Date.UTC(2026, 9, 24),
    nextStep: 'wait' as const,
  };
  const h = await startHarness(t, {
    quota: { usage: () => ({ limits: [reason], ...(blocked ? { refusal: reason } : {}) }) },
  });
  const id = await newConversation(h);
  const path = `/v1/conversations/${id}/messages`;
  const message = { text: 'hello', clientMessageId: 'quota-retry-1' };
  assert.equal((await postJson(h, path, message)).status, 202);
  blocked = true;
  assert.equal((await postJson(h, path, message)).status, 202);
  const refusal = await postJson(h, path, { text: 'new message' });
  assert.equal(refusal.status, 429);
  assert.deepEqual(await refusal.json(), { error: 'budget_exceeded', quota: reason });
  assert.deepEqual(await (await h.api('/v1/usage')).json(), { limits: [reason], refusal: reason });
  assert.equal((await h.api('/v1/usage', { token: null })).status, 401);
});

test('task budget exhaustion is a typed non-resetting refusal', () => {
  const view = toPublicView({
    taskId: 'task',
    costUsd: 1.25,
    budgetUsd: 1,
    budgetExceeded: true,
  } as TaskView);
  assert.deepEqual(view.quota, {
    scope: 'task',
    usedUsd: 1.25,
    limitUsd: 1,
    resetsAt: null,
    nextStep: 'ask_owner',
  });
});

test('Home removes project and model cards only when those facts become available', async (t) => {
  let model = false;
  let connected = false;
  const h = await startHarness(t, {
    modelAvailable: () => model,
    duties: {
      listProjects: () => (connected ? [{}] : []),
    } as unknown as import('../duties.js').DutyService,
  });
  const ids = async () => {
    const body = (await (await h.api('/v1/home')).json()) as {
      readiness: { cards: { id: string }[] };
    };
    return body.readiness.cards.map((card) => card.id);
  };
  assert.ok((await ids()).includes('model'));
  assert.ok((await ids()).includes('project'));
  model = true;
  connected = true;
  assert.ok(!(await ids()).includes('model'));
  assert.ok(!(await ids()).includes('project'));
});
