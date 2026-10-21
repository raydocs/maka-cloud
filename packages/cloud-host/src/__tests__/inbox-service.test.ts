import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Supervisor } from '@maka-cloud/supervisor';
import { inboxService } from '../inbox/service.js';

function fakeSupervisor() {
  const calls: unknown[][] = [];
  const supervisor = {
    setOwnerMute: (...args: unknown[]) => (calls.push(['mute', ...args]), { mutedKinds: [] }),
    getOwnerSettings: (...args: unknown[]) => (calls.push(['get', ...args]), {}),
    setOwnerSettings: (...args: unknown[]) => (calls.push(['set', ...args]), {}),
    digest: async (...args: unknown[]) => (calls.push(['digest', ...args]), {}),
  } as unknown as Supervisor;
  return { service: inboxService(supervisor), calls };
}

test('the inbox service passes the owner to every call and refuses what is the operator’s to set', async () => {
  const { service, calls } = fakeSupervisor();
  assert.deepEqual(service.setMute('inv_a', 'nonsense', true), { ok: false });
  assert.equal(service.setMute('inv_a', 'finished', true).ok, true);
  service.settings('inv_a');
  await service.digest('inv_a');
  assert.equal(service.updateSettings('inv_a', { quietHours: null }).ok, true);
  for (const patch of [
    { stallAfterMinutes: 1 },
    { maxInterruptsPerHour: 1000 },
    { digestAt: null },
    { verifierDailyCapUsd: 999 },
    { timeZone: 'Not/AZone' },
  ]) {
    assert.deepEqual(service.updateSettings('inv_a', patch), { ok: false }, JSON.stringify(patch));
  }
  assert.deepEqual(
    calls.map((call) => [call[0], call[1]]),
    [
      ['mute', 'inv_a'],
      ['get', 'inv_a'],
      ['digest', 'inv_a'],
      ['set', 'inv_a'],
    ],
  );
});
