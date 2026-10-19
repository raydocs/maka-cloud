import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { ModelCharge, ModelGateway } from '../config.js';
import { calls, text, tool } from './fake-model.js';
import { makeHarness } from './harness.js';

/**
 * A stand-in for the model gateway: every request reserves `reserveUsd` in the charge it was
 * opened with, is refused with a 402 when that fails, and otherwise goes to the fake model and
 * settles at `settleUsd` once its response has been read.
 */
function fakeGateway(modelUrl: () => string, reserveUsd: number, settleUsd: number) {
  const log = { opened: 0, closed: 0, reserved: [] as number[], settled: [] as number[] };
  const gateway: ModelGateway = {
    open(charge: ModelCharge) {
      log.opened += 1;
      let closed = false;
      return {
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          if (closed) throw new Error('closed');
          const key = randomUUID();
          const reserved = charge.reserve(key, reserveUsd);
          if (!reserved.ok) {
            return new Response(
              JSON.stringify({
                type: 'error',
                error: { type: 'billing_error', message: reserved.reason },
              }),
              { status: 402, headers: { 'content-type': 'application/json' } },
            );
          }
          log.reserved.push(reserveUsd);
          const url = new URL(String(input instanceof Request ? input.url : input));
          const target = new URL(url.pathname, modelUrl());
          const upstream = await fetch(target, init);
          const body = await upstream.text();
          charge.settle(key, settleUsd);
          log.settled.push(settleUsd);
          return new Response(body, { status: upstream.status, headers: upstream.headers });
        }) as typeof fetch,
        close: () => {
          closed = true;
          log.closed += 1;
        },
      };
    },
  };
  return { gateway, log };
}

const plan = text('1. Do the work.');

test('through the gateway a request the run cannot cover is not sent, and the user is asked for what it needs', async (t) => {
  let url = '';
  const { gateway, log } = fakeGateway(() => url, 6, 0);
  const h = await makeHarness(t, {
    conductor: { access: { apiKey: 'gateway', gateway } },
  });
  url = h.model.url;
  h.model.script('conductor', text('never sent'));
  await h.send('cnv_1', 'Research.');
  await h.conductor.idle();

  assert.equal(h.model.requests.length, 0, 'the $6 worst case does not fit the $5 budget');
  assert.equal(h.model.pending('conductor'), 1);
  const question = h.outbox.questions[0];
  assert.ok(question);
  assert.equal(question.reason, 'budget_overrun');
  assert.equal(h.conductor.state.run(question.runId)?.state, 'waiting');
  const budget = h.conductor.state.budget(question.runId);
  assert.equal(budget.spentUsd, 0, 'a refused request holds and costs nothing');
  assert.equal(log.opened, log.closed, 'the turn’s access was closed when it ended');
});

test('through the gateway each request is charged once, at what the gateway settled', async (t) => {
  let url = '';
  const { gateway, log } = fakeGateway(() => url, 0.5, 0.01);
  const h = await makeHarness(t, {
    conductor: { access: { apiKey: 'gateway', gateway } },
  });
  url = h.model.url;
  h.model.script('planner', plan);
  h.model.script(
    'conductor',
    // The fake reports 300k output tokens ($6 at list price): only the gateway's $0.01 counts.
    {
      ...calls(tool('start_playbook', { playbook: 'research', goal: 'g' })),
      usage: { output: 300_000 },
    },
    text('Done.'),
  );
  await h.send('cnv_1', 'Research.');
  await h.conductor.idle();

  assert.equal(h.model.pending('conductor'), 0);
  assert.equal(log.settled.length, h.model.requests.length);
  const runId = h.outbox.messages[0]?.runId;
  assert.ok(runId);
  const budget = h.conductor.state.budget(runId);
  assert.ok(Math.abs(budget.modelUsd - 0.01 * log.settled.length) < 1e-9, `${budget.modelUsd}`);
  assert.equal(budget.reservedUsd, 0, 'every reservation was settled');
  assert.equal(h.outbox.questions.length, 0);
  assert.ok(log.opened >= 1);
  assert.equal(log.opened, log.closed);
});

test('a model request a previous process reserved and never settled is charged in full at restart', async (t) => {
  let url = '';
  const { gateway } = fakeGateway(() => url, 0.5, 0.01);
  const h = await makeHarness(t, {
    conductor: { access: { apiKey: 'gateway', gateway } },
  });
  url = h.model.url;
  h.model.script('planner', plan);
  h.model.script('conductor', text('Done.'));
  await h.send('cnv_1', 'Hi.');
  await h.conductor.idle();
  const runId = h.outbox.messages[0]?.runId;
  assert.ok(runId);
  const before = h.conductor.state.budget(runId);
  // What a crash between the reservation and the settlement leaves behind.
  const held = h.conductor.state.tryReserve(runId, 0.3, 'request:crashed');
  assert.ok(held.ok);

  await h.restart();
  const after = h.conductor.state.budget(runId);
  assert.equal(after.reservedUsd, 0);
  assert.ok(Math.abs(after.modelUsd - before.modelUsd - 0.3) < 1e-9, `${after.modelUsd}`);
});
