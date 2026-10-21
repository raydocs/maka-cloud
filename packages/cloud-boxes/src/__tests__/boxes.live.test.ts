import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { InstaboxApiError, InstaboxClient, type InstaboxMachine } from '@maka-cloud/instabox';

/**
 * Probes what the pool assumes about real instabox. Each answer the pool depends on is written to the
 * test output (`t.diagnostic`) so a change on instabox's side shows up as a changed line:
 *
 * - a second create with a name that is in use is refused (the pool takes it as "this box exists");
 * - labels written at create come back from `listMachines({metadata})`, and a patch replaces them;
 * - a suspended box is woken by `ensureRunning`, and files under /data survive it;
 * - what `exec` does on a suspended box (the pool never relies on it: it wakes first);
 * - a snapshot taken from a box makes a box that has its files, when the template allows snapshots.
 *
 * It makes and deletes only machines and snapshots named `mk-probe-<random>`, and costs a few
 * minutes of sandbox time. It runs only with MAKA_CLOUD_LIVE=1, INSTABOX_API_KEY and
 * MAKA_CLOUD_BOX_TEMPLATE (a template id); CI leaves them unset. The snapshot step also needs
 * MAKA_CLOUD_BOX_SNAPSHOTS=1, because it needs a template with `identity-reset`.
 */
const live =
  process.env.MAKA_CLOUD_LIVE === '1' &&
  Boolean(process.env.INSTABOX_API_KEY) &&
  Boolean(process.env.MAKA_CLOUD_BOX_TEMPLATE);

test('live probe: instabox does what the box pool assumes', {
  skip: !live,
  timeout: 900_000,
}, async (t) => {
  const client = new InstaboxClient({
    apiKey: process.env.INSTABOX_API_KEY ?? '',
    ...(process.env.INSTABOX_API_URL ? { baseUrl: process.env.INSTABOX_API_URL } : {}),
  });
  const templateId = process.env.MAKA_CLOUD_BOX_TEMPLATE ?? '';
  const id = `mk-probe-${randomBytes(4).toString('hex')}`;
  const made: string[] = [];
  const snapshots: string[] = [];
  const create = async (
    name: string,
    source: { templateId: string } | { snapshotId: string },
    metadata: Record<string, string>,
  ): Promise<InstaboxMachine> => {
    const operation = await client.createMachine({ name, ...source, metadata });
    made.push(operation.machineId);
    await client.waitForOperation(operation.id);
    return await client.getMachine(operation.machineId);
  };

  try {
    const box = await create(id, { templateId }, { 'maka.probe': id, 'maka.slot': '0' });
    assert.equal(box.state, 'running');

    // A name in use.
    const duplicate = await client
      .createMachine({ name: id, templateId, metadata: { 'maka.probe': id } })
      .then(
        (operation) => {
          made.push(operation.machineId);
          return undefined;
        },
        (error: unknown) => error,
      );
    assert.ok(
      duplicate instanceof InstaboxApiError,
      'a second create with the same name must be refused',
    );
    t.diagnostic(`duplicate name: HTTP ${duplicate.status} ${duplicate.code ?? ''}`);
    assert.equal(duplicate.status, 409, 'the pool treats 409 as "that box exists"');

    // Labels.
    const found = await client.listMachines({ metadata: { 'maka.probe': id } });
    assert.deepEqual(
      found.map((machine) => machine.id),
      [box.id],
    );
    await client.patchMachineMetadata(box.id, { 'maka.probe': id, 'maka.task': 'task-1' });
    const patched = await client.getMachine(box.id);
    assert.deepEqual(
      patched.metadata,
      { 'maka.probe': id, 'maka.task': 'task-1' },
      'a patch replaces the labels',
    );

    // Sleep and wake.
    await client.exec(box.id, {
      cmd: 'mkdir -p /data/maka-probe && echo kept > /data/maka-probe/file && sync',
    });
    const suspend = await client.suspendMachine(box.id);
    await client.waitForOperation(suspend.id);
    assert.equal((await client.getMachine(box.id)).state, 'suspended');
    const onSuspended = await client.exec(box.id, { cmd: 'echo hi', timeoutSeconds: 30 }).then(
      (result) => `exec on a suspended box answered with exit ${result.exitCode}`,
      (error: unknown) =>
        `exec on a suspended box failed: ${error instanceof InstaboxApiError ? `HTTP ${error.status} ${error.code ?? ''}` : String(error)}`,
    );
    t.diagnostic(onSuspended);
    await client.ensureRunning(box.id);
    assert.equal((await client.getMachine(box.id)).state, 'running');
    const kept = await client.exec(box.id, { cmd: 'cat /data/maka-probe/file' });
    assert.equal(kept.stdout.trim(), 'kept', 'files under /data must survive a suspend');
    assert.deepEqual(
      (await client.getMachine(box.id)).metadata,
      patched.metadata,
      'labels survive a suspend',
    );

    // Snapshot.
    if (process.env.MAKA_CLOUD_BOX_SNAPSHOTS === '1') {
      const snapshot = await client.createSnapshot(box.id, {
        name: id,
        description: 'maka box probe',
      });
      snapshots.push(snapshot.id);
      const ready = await client.waitForSnapshot(snapshot.id);
      assert.equal(ready.status, 'ready');
      const copy = await create(`${id}-copy`, { snapshotId: ready.id }, { 'maka.probe': id });
      const files = await client.exec(copy.id, { cmd: 'cat /data/maka-probe/file' });
      assert.equal(files.stdout.trim(), 'kept', 'a box made from the snapshot has the files');
      const clash = await client.createSnapshot(box.id, { name: id }).then(
        (extra) => {
          snapshots.push(extra.id);
          return undefined;
        },
        (error: unknown) => error,
      );
      assert.ok(
        clash instanceof InstaboxApiError,
        'a second snapshot with the same name must be refused',
      );
      t.diagnostic(`duplicate snapshot name: HTTP ${clash.status} ${clash.code ?? ''}`);
    }
  } finally {
    for (const snapshotId of snapshots)
      await client.deleteSnapshot(snapshotId).catch(() => undefined);
    for (const machineId of made) {
      await client
        .deleteMachine(machineId)
        .then((operation) => client.waitForOperation(operation.id))
        .catch(() => undefined);
    }
  }
});
