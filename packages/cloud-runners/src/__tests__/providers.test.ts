import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FixedMachineProvider, TenantMachineProvider } from '../providers.js';

test('two tenants cannot share a machine', () => {
  assert.throws(
    () => new TenantMachineProvider({ alice: 'm_one', bob: 'm_one' }),
    /machine "m_one" is assigned to both "alice" and "bob"/,
  );
});

test('a tenant table with one machine each still works', async () => {
  const provider = new TenantMachineProvider({ alice: 'm_one', bob: 'm_two' });
  assert.equal((await provider.acquire({ tenantId: 'bob', taskId: 't' })).machineId, 'm_two');
  assert.deepEqual(provider.knownMachines().sort(), ['m_one', 'm_two']);
  await assert.rejects(provider.acquire({ tenantId: 'carol', taskId: 't' }), /No sandbox/);
});

test('an empty machine id is refused', () => {
  assert.throws(() => new TenantMachineProvider({ alice: '' }), /empty machine id/);
  assert.throws(() => new FixedMachineProvider(''), /empty machine id/);
});

test("the log root must be a real path of its own, since a task's log directory is deleted whole", async () => {
  const { Fleet } = await import('../fleet.js');
  const client = {} as never;
  const sandboxes = new FixedMachineProvider('m_one');
  for (const logRoot of ['', '/', 'relative/dir'])
    assert.throws(
      () => new Fleet({ client, sandboxes, logRoot }),
      /logRoot must be an absolute path/,
    );
  assert.equal(new Fleet({ client, sandboxes, logRoot: '/dev/shm/x/' }).logRoot, '/dev/shm/x');
});
