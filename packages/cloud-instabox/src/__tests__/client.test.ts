import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { InstaboxClient } from '../client.js';
import { InstaboxApiError, InstaboxOperationError, InstaboxTransportError } from '../errors.js';
import { setup, type Harness } from './harness.js';

describe('InstaboxClient', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('sends the API key and parses collected exec output', async () => {
    const result = await h.client.exec(h.fake.machineId, { cmd: 'echo hi; echo err >&2; exit 3' });
    assert.deepEqual(
      { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
      { stdout: 'hi\n', stderr: 'err\n', exitCode: 3 },
    );
    assert.equal(h.fake.execRequests[0]?.headers['x-api-key'], h.fake.apiKey);
  });

  it('turns the error envelope into InstaboxApiError and never echoes the key', async () => {
    const wrong = new InstaboxClient({ apiKey: 'ibk_wrong_secret', baseUrl: h.fake.url });
    await assert.rejects(wrong.getMachine(h.fake.machineId), (error: unknown) => {
      assert.ok(error instanceof InstaboxApiError);
      assert.equal(error.status, 401);
      assert.equal(error.code, 'unauthenticated');
      assert.equal(error.requestId, 'req_fake');
      assert.equal(error.retryable, false);
      assert.ok(!error.message.includes('ibk_wrong_secret'));
      return true;
    });
  });

  it('retries exec only when the server marks the failure retryable, with the same body', async () => {
    h.fake.onExec = (_request, index) =>
      index < 2
        ? { status: 429, error: { code: 'quota_exceeded', message: 'busy', retryable: true } }
        : undefined;
    const result = await h.client.exec(h.fake.machineId, { cmd: 'echo ran' });
    assert.equal(result.stdout, 'ran\n');
    const bodies = h.fake.execRequests.map((r) => JSON.stringify(r.body));
    assert.equal(bodies.length, 3);
    assert.equal(new Set(bodies).size, 1);
    assert.equal(h.sleeps.length, 2);
  });

  it('does not retry exec on a non-retryable quota error', async () => {
    h.fake.onExec = () => ({
      status: 429,
      error: { code: 'quota_exceeded', message: 'sandbox limit reached', retryable: false },
    });
    await assert.rejects(h.client.exec(h.fake.machineId, { cmd: 'true' }), InstaboxApiError);
    assert.equal(h.fake.execRequests.length, 1);
  });

  it('never replays exec after the connection drops: the command may have run', async () => {
    h.fake.onExec = () => ({ drop: true });
    await assert.rejects(h.client.exec(h.fake.machineId, { cmd: 'true' }), InstaboxTransportError);
    assert.equal(h.fake.execRequests.length, 1);
  });

  it('sends no Idempotency-Key on exec', async () => {
    await h.client.exec(h.fake.machineId, { cmd: 'true' });
    assert.equal(h.fake.execRequests[0]?.headers['idempotency-key'], undefined);
  });

  it('reuses one Idempotency-Key across retries, so a dropped response creates one operation', async () => {
    h.fake.machineState = 'suspended';
    h.fake.dropMutationResponseOnce = true;
    const operation = await h.client.resumeMachine(h.fake.machineId);
    const posts = h.fake.requestsTo('POST', /\/resume$/);
    assert.equal(posts.length, 2);
    const keys = posts.map((r) => r.headers['idempotency-key']);
    assert.ok(typeof keys[0] === 'string' && keys[0].length > 0);
    assert.equal(keys[0], keys[1]);
    assert.equal(h.fake.operations.size, 1);
    assert.equal(operation.id, 'op_1');
  });

  it('retries a retryable mutation failure with the same key', async () => {
    h.fake.machineState = 'stopped';
    h.fake.failNextMutation = { status: 503, code: 'host_unavailable', retryable: true };
    await h.client.startMachine(h.fake.machineId);
    const keys = h.fake.requestsTo('POST', /\/start$/).map((r) => r.headers['idempotency-key']);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
  });

  it('does not retry idempotency_conflict', async () => {
    h.fake.failNextMutation = { status: 409, code: 'idempotency_conflict', retryable: false };
    await assert.rejects(
      h.client.resumeMachine(h.fake.machineId),
      (error: unknown) =>
        error instanceof InstaboxApiError && error.code === 'idempotency_conflict',
    );
    assert.equal(h.fake.requestsTo('POST', /\/resume$/).length, 1);
  });

  it('uses a fresh key for a separate logical mutation', async () => {
    await h.client.resumeMachine(h.fake.machineId);
    await h.client.resumeMachine(h.fake.machineId);
    const [a, b] = h.fake.requestsTo('POST', /\/resume$/).map((r) => r.headers['idempotency-key']);
    assert.notEqual(a, b);
  });

  it('long-polls an operation with wait=25s until it succeeds', async () => {
    h.fake.operationPolls = 3;
    h.fake.machineState = 'suspended';
    const accepted = await h.client.resumeMachine(h.fake.machineId);
    const done = await h.client.waitForOperation(accepted.id);
    assert.equal(done.state, 'succeeded');
    const polls = h.fake.requestsTo('GET', /\/v1\/operations\//);
    assert.equal(polls.length, 3);
    assert.ok(polls.every((r) => r.query.get('wait') === '25s'));
  });

  it('reports a failed operation with its error message', async () => {
    h.fake.failNextOperation = true;
    const accepted = await h.client.resumeMachine(h.fake.machineId);
    await assert.rejects(
      h.client.waitForOperation(accepted.id),
      (error: unknown) =>
        error instanceof InstaboxOperationError && /host rejected the resume/.test(error.message),
    );
  });

  it('gives up on an operation that never finishes', async () => {
    h.fake.operationPolls = 1_000_000;
    const accepted = await h.client.resumeMachine(h.fake.machineId);
    let clock = 0;
    const slow = new InstaboxClient({
      apiKey: h.fake.apiKey,
      baseUrl: h.fake.url,
      now: () => (clock += 10 * 60_000),
    });
    await assert.rejects(slow.waitForOperation(accepted.id), InstaboxOperationError);
  });

  it('ensureRunning resumes a paused sandbox and starts a stopped one', async () => {
    h.fake.machineState = 'suspended';
    await h.client.ensureRunning(h.fake.machineId);
    assert.equal(h.fake.machineState, 'running');
    assert.equal(h.fake.requestsTo('POST', /\/resume$/).length, 1);

    h.fake.machineState = 'stopped';
    await h.client.ensureRunning(h.fake.machineId);
    assert.equal(h.fake.machineState, 'running');
    assert.equal(h.fake.requestsTo('POST', /\/start$/).length, 1);
  });

  it('ensureRunning wakes an idle-suspended sandbox instead of resuming it', async () => {
    h.fake.machineState = 'suspended';
    h.fake.autoSuspendedAt = new Date().toISOString();
    await h.client.ensureRunning(h.fake.machineId);
    assert.equal(h.fake.requestsTo('POST', /\/wake$/).length, 1);
    assert.equal(h.fake.requestsTo('POST', /\/resume$/).length, 0);
  });

  it('ensureRunning refuses a deleted sandbox', async () => {
    h.fake.machineState = 'deleted';
    await assert.rejects(h.client.ensureRunning(h.fake.machineId), /cannot be started/);
  });
});
