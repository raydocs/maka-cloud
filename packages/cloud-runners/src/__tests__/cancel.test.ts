import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemorySessionStore } from '../session-store.js';
import {
  collect,
  deferred,
  exists,
  isRunning,
  reader,
  setup,
  settles,
  terminal,
  until,
  type Harness,
} from './harness.js';
import { Tracking } from './tracking.js';

const WORKING = (event: { type: string; note?: string }) =>
  event.type === 'progress' && event.note === 'working on it';

function assertClean(h: Harness, tr: Tracking, options: { watches?: boolean } = {}): void {
  assert.equal(h.runners.fleet.openRuns, 0, 'run still open');
  if (options.watches !== false)
    assert.equal(h.runners.fleet.poller.watchCount(), 0, 'poll watch left behind');
  assert.equal(h.runners.fleet.leaseRenewals, 0, 'lease renewal timer still running');
  assert.equal(h.fake.leases.size, 0, 'activity lease left behind');
  assert.equal(tr.released, tr.acquired, 'sandbox lease not released');
  assert.equal(tr.revoked, tr.issued, 'model access not revoked');
}

test('cancel while model access is being issued returns at once and revokes the key that arrives later', async (t) => {
  const tr = new Tracking();
  tr.issueGate = deferred();
  const h = await setup({ cloud: { modelAccess: tr.access, sandboxes: tr.sandboxes } });
  t.after(() => h.cleanup());
  const handle = await h.runners.claude.start(await h.spec('tsk_c_issue'));
  await tr.issueEntered.promise;

  assert.notEqual(await settles(handle.cancel()), 'stuck', 'cancel waited for the provider');
  assert.notEqual(await settles(collect(handle)), 'stuck', 'the stream did not close');
  assert.equal(h.runners.fleet.openRuns, 0);

  tr.issueGate.resolve();
  await tr.revokeEntered.promise;
  assert.equal(tr.revoked, 1, 'a key issued after the cancel is revoked');
  assert.equal(tr.acquired, 0, 'and no sandbox was taken for a cancelled run');
});

test('cancel while a sandbox is being acquired releases the lease that arrives later', async (t) => {
  const tr = new Tracking();
  tr.acquireGate = deferred();
  const h = await setup({ cloud: { modelAccess: tr.access, sandboxes: tr.sandboxes } });
  t.after(() => h.cleanup());
  const handle = await h.runners.claude.start(await h.spec('tsk_c_acq'));
  await tr.acquireEntered.promise;

  assert.notEqual(await settles(handle.cancel()), 'stuck');
  assert.equal(tr.revoked, 1, 'the key is revoked without waiting for the sandbox');

  tr.acquireGate.resolve();
  await tr.releaseDone.promise;
  assert.equal(tr.released, 1);
  assertClean(h, tr);
  assert.equal(await h.sessions.get('tsk_c_acq'), undefined, 'a cancelled run records nothing');
});

test('cancel while the CLI is being installed releases everything', async (t) => {
  const tr = new Tracking();
  const h = await setup({
    installClis: false,
    cloud: {
      modelAccess: tr.access,
      sandboxes: tr.sandboxes,
      leaseTtlSeconds: 1,
      installCommands: {
        'claude-agent-sdk': `touch "$HOME/install-started"
while [ ! -e "$HOME/go" ]; do sleep 0.05; done
exit 1`,
      },
    },
  });
  t.after(() => h.cleanup());
  const handle = await h.runners.claude.start(await h.spec('tsk_c_install'));
  await until(() => exists(join(h.home, 'install-started')));

  assert.notEqual(await settles(handle.cancel()), 'stuck', 'cancel waited for the install');
  // The install is shared with other tasks, so it goes on; its watch is not the run's.
  assertClean(h, tr, { watches: false });
  assert.notEqual(await settles(collect(handle)), 'stuck');
  await fs.writeFile(join(h.home, 'go'), '');
  await until(() => h.runners.fleet.poller.watchCount() === 0);
});

test('cancel while a snapshot is pending releases everything and deletes the unfinished snapshot', async (t) => {
  const tr = new Tracking();
  const h = await setup({ cloud: { modelAccess: tr.access, sandboxes: tr.sandboxes } });
  t.after(() => h.cleanup());
  h.fake.snapshotPolls = Number.MAX_SAFE_INTEGER;
  const created = deferred();
  const create = h.client.createSnapshot.bind(h.client);
  h.client.createSnapshot = async (...args) => {
    const snapshot = await create(...args);
    created.resolve();
    return snapshot;
  };
  const handle = await h.runners.claude.start(await h.spec('tsk_c_snap'));
  await created.promise;

  assert.notEqual(await settles(handle.cancel()), 'stuck', 'cancel waited for the snapshot');
  assertClean(h, tr);
  await until(() => h.fake.snapshots.size === 0);
  assert.deepEqual((await h.sessions.get('tsk_c_snap'))?.snapshotIds ?? [], []);
});

test('repeated cancels share one cleanup, and a revoke that never answers does not hold it up', async (t) => {
  const tr = new Tracking();
  tr.revokeMode = 'hang';
  const errors: { step: string; message: string }[] = [];
  const h = await setup({
    cloud: {
      modelAccess: tr.access,
      sandboxes: tr.sandboxes,
      cleanupTimeoutMs: 1_500,
      onCleanupError: ({ step, error }) =>
        errors.push({ step, message: error instanceof Error ? error.message : String(error) }),
    },
  });
  t.after(() => h.cleanup());
  await h.setMode('hang');
  const handle = await h.runners.claude.start(await h.spec('tsk_c_twice'));
  const events = reader(handle);
  await events.until(WORKING);
  const pid = await h.runPid('tsk_c_twice');

  const both = Promise.all([handle.cancel(), handle.cancel(), handle.cancel()]);
  assert.notEqual(await settles(both), 'stuck');
  assert.equal(tr.revoked, 1, 'one cleanup, one revoke');
  assert.equal(tr.released, 1);
  assert.equal(await isRunning(pid), false);
  assert.equal(h.fake.leases.size, 0);
  assert.equal(h.runners.fleet.openRuns, 0);
  assert.deepEqual(
    errors.map((e) => e.step),
    ['revoke model access'],
  );
  assert.match(errors[0]?.message ?? '', /timed out/);
  assert.equal(terminal(await events.rest()), undefined);
  await handle.cancel();
  assert.equal(tr.revoked, 1);
});

for (const mode of ['sync-throw', 'reject'] as const) {
  test(`a revoke that fails (${mode}) skips none of the other steps`, async (t) => {
    const tr = new Tracking();
    tr.revokeMode = mode;
    const errors: string[] = [];
    const h = await setup({
      cloud: {
        modelAccess: tr.access,
        sandboxes: tr.sandboxes,
        onCleanupError: ({ step }) => errors.push(step),
      },
    });
    t.after(() => h.cleanup());
    const events = await settles(collect(await h.runners.claude.start(await h.spec('tsk_c_rev'))));
    assert.notEqual(events, 'stuck', 'the stream never closed');
    assert.equal(terminal(events === 'stuck' ? [] : events)?.type, 'finished');
    assertClean(h, tr);
    assert.equal(tr.revoked, 1);
    assert.deepEqual(errors, ['revoke model access']);
  });

  test(`a sandbox release that fails (${mode}) still closes the stream and counts the run out`, async (t) => {
    const tr = new Tracking();
    tr.releaseMode = mode;
    const h = await setup({ cloud: { modelAccess: tr.access, sandboxes: tr.sandboxes } });
    t.after(() => h.cleanup());
    const events = await settles(collect(await h.runners.claude.start(await h.spec('tsk_c_rel'))));
    assert.notEqual(events, 'stuck');
    assertClean(h, tr);
  });
}

test('when the session record cannot be written, the sandbox lease is released', async (t) => {
  const tr = new Tracking();
  const sessions = new MemorySessionStore();
  const put = sessions.put.bind(sessions);
  let failures = 1;
  sessions.put = async (record) => {
    if (failures-- > 0) throw new Error('disk full');
    return await put(record);
  };
  const h = await setup({ cloud: { modelAccess: tr.access, sandboxes: tr.sandboxes, sessions } });
  t.after(() => h.cleanup());
  const events = await settles(collect(await h.runners.claude.start(await h.spec('tsk_c_put'))));
  assert.notEqual(events, 'stuck');
  const last = terminal(events === 'stuck' ? [] : events);
  assert.equal(last?.type, 'failed');
  assert.match(last?.type === 'failed' ? last.reason : '', /disk full/);
  assert.equal(tr.acquired, 1);
  assertClean(h, tr);
});

test('when the record of a restored sandbox cannot be written, that lease is released too', async (t) => {
  const tr = new Tracking();
  const sessions = new MemorySessionStore();
  const h = await setup({ cloud: { modelAccess: tr.access, sandboxes: tr.sandboxes, sessions } });
  t.after(() => h.cleanup());
  const spec = await h.spec('tsk_c_restore');
  assert.equal(terminal(await collect(await h.runners.claude.start(spec)))?.type, 'finished');
  assertClean(h, tr);

  h.fake.machineState = 'deleted';
  const put = sessions.put.bind(sessions);
  sessions.put = async (record) => {
    if (record.taskId === 'tsk_c_restore') throw new Error('disk full');
    return await put(record);
  };
  const events = await settles(
    collect(await h.runners.claude.resume('tsk_c_restore', { prompt: 'again', spec })),
  );
  assert.notEqual(events, 'stuck');
  assert.match(JSON.stringify(events), /disk full/);
  assert.equal(tr.acquired, 2, 'a sandbox was restored');
  assertClean(h, tr);
});
