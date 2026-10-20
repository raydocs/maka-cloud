import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DutyEngine } from '../engine.js';
import { MAX_BODY_BYTES } from '../webhook.js';
import { CI_DEFAULT, ISSUES, issueOpened, request, rig, sign, workflowRun } from './harness.js';

const total = (r: Awaited<ReturnType<typeof rig>>, dutyId: string) =>
  r.engine.requestsOf(dutyId).length;

test('a delivery with no signature is rejected and stores nothing', async () => {
  const r = await rig();
  const [duty] = await r.activate(ISSUES);
  const { headers, body } = request('issues', issueOpened());
  const { 'x-hub-signature-256': _dropped, ...unsigned } = headers;
  const result = r.engine.receive(unsigned, body);
  assert.equal(result.status, 401);
  assert.equal(result.body.error, 'missing_signature');
  assert.equal(total(r, duty as string), 0);
  r.cleanup();
});

test('a delivery with a wrong signature is rejected and stores nothing, even when its id is new', async () => {
  const r = await rig();
  const [duty] = await r.activate(ISSUES);
  const wrongSecret = request('issues', issueOpened(), {
    secret: 'another-secret-of-sufficient-length',
  });
  assert.equal(r.engine.receive(wrongSecret.headers, wrongSecret.body).status, 401);

  // A valid signature for a different body does not cover this one.
  const good = request('issues', issueOpened({ number: 5 }));
  const tampered = Buffer.from(JSON.stringify(issueOpened({ number: 6 })));
  const result = r.engine.receive(good.headers, tampered);
  assert.equal(result.status, 401);
  assert.equal(result.body.error, 'bad_signature');
  assert.equal(total(r, duty as string), 0);

  // Then the same id with the right signature is still new: nothing was remembered.
  const ok = request('issues', issueOpened(), { id: good.headers['x-github-delivery'] });
  assert.equal(r.engine.receive(ok.headers, ok.body).status, 200);
  assert.equal(total(r, duty as string), 1);
  r.cleanup();
});

test('a malformed signature header never matches', async () => {
  const r = await rig();
  const { headers, body } = request('issues', issueOpened());
  const real = (headers['x-hub-signature-256'] as string).slice('sha256='.length);
  for (const bad of [
    '',
    'sha256=',
    `sha1=${real}`,
    real,
    `sha256=${real.toUpperCase()}`,
    `sha256=${real.slice(2)}`,
    `sha256=${real}00`,
    `sha256=${'z'.repeat(64)}`,
  ]) {
    const result = r.engine.receive({ ...headers, 'x-hub-signature-256': bad }, body);
    assert.equal(result.status, 401, `header ${JSON.stringify(bad)}`);
  }
  r.cleanup();
});

test('an event type this product does not handle is rejected, after the signature is proven', async () => {
  const r = await rig();
  const unknown = request('push', { ref: 'refs/heads/main' });
  const result = r.engine.receive(unknown.headers, unknown.body);
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'unsupported_event');

  // Unsigned and unknown: the signature is checked first, so a stranger learns nothing about events.
  const { 'x-hub-signature-256': _dropped, ...unsigned } = unknown.headers;
  assert.equal(r.engine.receive(unsigned, unknown.body).status, 401);
  const noEvent = request('issues', issueOpened());
  const { 'x-github-event': _event, ...withoutEvent } = noEvent.headers;
  assert.equal(r.engine.receive(withoutEvent, noEvent.body).status, 400);
  r.cleanup();
});

test('a missing delivery id, an oversized body and a body that is not JSON are rejected', async () => {
  const r = await rig();
  const { headers, body } = request('issues', issueOpened());
  const { 'x-github-delivery': _id, ...noId } = headers;
  assert.equal(r.engine.receive(noId, body).body.error, 'missing_delivery_id');
  assert.equal(
    r.engine.receive({ ...headers, 'x-github-delivery': 'has spaces!' }, body).body.error,
    'missing_delivery_id',
  );

  const big = Buffer.alloc(MAX_BODY_BYTES + 1, 0x20);
  const tooLarge = r.engine.receive({ ...headers, 'x-hub-signature-256': sign(big) }, big);
  assert.equal(tooLarge.status, 413);

  const text = Buffer.from('not json');
  const notJson = r.engine.receive(
    { ...headers, 'x-github-delivery': 'abc', 'x-hub-signature-256': sign(text) },
    text,
  );
  assert.equal(notJson.status, 400);
  assert.equal(notJson.body.error, 'invalid_payload');

  // Shaped wrong for its event (no installation): rejected, never guessed at.
  const payload = { ...issueOpened(), installation: undefined };
  const shaped = request('issues', payload);
  assert.equal(r.engine.receive(shaped.headers, shaped.body).body.error, 'invalid_payload');
  r.cleanup();
});

test('a signed ping is answered and starts nothing', async () => {
  const r = await rig();
  const result = r.deliver('ping', { zen: 'Keep it logically awesome.', hook_id: 1 });
  assert.equal(result.status, 200);
  assert.equal(result.body.pong, true);
  r.cleanup();
});

test('without a usable secret the engine does not start', () => {
  assert.throws(() => new DutyEngine({ dbPath: ':memory:', webhookSecret: '' }), /at least/);
  assert.throws(() => new DutyEngine({ dbPath: ':memory:', webhookSecret: 'short' }), /at least/);
});

test('a delivery for a repository nobody registered, or another installation, is acknowledged and ignored', async () => {
  const r = await rig();
  const [duty] = await r.activate(CI_DEFAULT);
  const other = { ...workflowRun(), repository: { full_name: 'someone/else' } };
  assert.equal(r.deliver('workflow_run', other).body.ignored, 'unknown_project');
  const wrongInstallation = { ...workflowRun(), installation: { id: 1 } };
  assert.equal(r.deliver('workflow_run', wrongInstallation).body.ignored, 'installation_mismatch');
  assert.equal(total(r, duty as string), 0);
  r.cleanup();
});
