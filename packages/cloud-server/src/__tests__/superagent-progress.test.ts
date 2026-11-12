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

test('GET ?ask= and POST instruct use the injected watchdog hooks', async (t) => {
  const snapshot = { at: 4, workers: [{ workerId: 'wrk_2', look: 'stuck' }] };
  const asked: string[] = [];
  const instructed: string[] = [];
  const h = await startHarness(t, {
    progress: {
      snapshot: () => snapshot,
      ask: (_owner, text) => {
        asked.push(text);
        return { text: 'wrk_2 is stuck\nids: wrk_2', citations: ['wrk_2'], source: 'fallback' };
      },
      instruct: (_owner, text) => {
        instructed.push(text);
        return {
          text: 'nudged wrk_2\nids: wrk_2',
          citations: ['wrk_2'],
          source: 'fallback',
          action: { kind: 'nudge', ok: true, workerId: 'wrk_2' },
        };
      },
    },
  });
  const get = await h.api('/v1/superagent/progress?ask=why+is+worker+wrk_2+stuck');
  assert.equal(get.status, 200);
  const got = (await get.json()) as { watchdog?: { citations: string[] } };
  assert.deepEqual(got.watchdog?.citations, ['wrk_2']);
  assert.deepEqual(asked, ['why is worker wrk_2 stuck']);

  const post = await h.api('/v1/superagent/progress', {
    method: 'POST',
    body: JSON.stringify({ instruct: 'nudge wrk_2' }),
  });
  assert.equal(post.status, 200);
  const posted = (await post.json()) as { watchdog?: { action?: { kind: string } } };
  assert.equal(posted.watchdog?.action?.kind, 'nudge');
  assert.deepEqual(instructed, ['nudge wrk_2']);
});
