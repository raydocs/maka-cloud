import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OffHiDevice } from '../hi-device.js';

test('P5 hi device stays off and cloud payment is approval_unavailable', async () => {
  const device = new OffHiDevice();
  assert.equal(device.enabled, false);
  assert.deepEqual(
    await device.evaluate({ tenantId: 'inv_local', workerId: 'w', prompt: 'review' }),
    { ok: false, reason: 'disabled' },
  );
  assert.deepEqual(
    await device.requestPayment({ tenantId: 'inv_local', workerId: 'w', prompt: 'pay' }),
    { ok: false, reason: 'approval_unavailable' },
  );
});
