import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startHarness } from './harness.js';

test('GET /v1/superagent/progress is 404 until the host injects a snapshot', async (t) => {
  const h = await startHarness(t);
  assert.equal((await h.api('/v1/superagent/progress')).status, 404);
  assert.equal((await h.api('/v1/superagent/progress', { token: null })).status, 401);
});

test('GET /v1/superagent/progress serves JSON and SSE for the invite', async (t) => {
  const snapshot = {
    at: 9,
    workers: [
      {
        workerId: 'wrk_1',
        tenantId: 'inv_test',
        phase: 'edit',
        k: 2,
        n: 9,
        percent: 18,
        look: 'running',
        lastActivity: 'model step',
      },
    ],
  };
  const h = await startHarness(t, {
    progress: { snapshot: (owner) => ({ ...snapshot, owner }) },
  });
  const json = await h.api('/v1/superagent/progress');
  assert.equal(json.status, 200);
  const body = (await json.json()) as { owner: string; workers: Array<{ phase: string }> };
  assert.equal(body.owner, h.inviteId);
  assert.equal(body.workers[0]?.phase, 'edit');

  const sse = await h.api('/v1/superagent/progress?stream=1', {
    headers: { accept: 'text/event-stream' },
  });
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get('content-type') ?? '', /text\/event-stream/);
  const text = await sse.text();
  assert.match(text, /event: progress/);
  assert.match(text, /wrk_1/);
});
