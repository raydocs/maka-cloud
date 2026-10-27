import assert from 'node:assert/strict';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { InstaboxApiError, type SandboxApi } from '@maka-cloud/instabox';
import { BOAT_EXEC_DIR, BoatClient, machineState } from '../client.js';
import { FakeBoat } from './fake-boat.js';

const SECRET = "ghp_s3cr3t-value with 'quotes' and $dollars";

describe('BoatClient', () => {
  const boat = new FakeBoat();
  let client: BoatClient;

  before(async () => {
    await boat.start();
  });
  after(async () => {
    await boat.stop();
  });
  beforeEach(() => {
    boat.requests.length = 0;
    boat.sandboxes.clear();
    boat.snapshots.clear();
    client = new BoatClient({
      apiKey: 'boat_test',
      baseUrl: boat.url,
      sleep: async () => {},
      random: () => 0,
    });
  });

  test('is a SandboxApi', () => {
    const api: SandboxApi = client;
    assert.equal(typeof api.exec, 'function');
  });

  test('exec passes env and stdin through private files, never in the command text', async () => {
    const sandbox = boat.addSandbox('bx_aaaaaaaa');
    const result = await client.exec('bx_aaaaaaaa', {
      cmd: 'printf "%s|" "$MAKA_TOKEN"; cat',
      envs: { MAKA_TOKEN: SECRET },
      stdin: 'the brief\nline two',
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `${SECRET}|the brief\nline two`);
    for (const command of boat.commands()) {
      assert.ok(!command.includes('s3cr3t'), `secret in command text: ${command}`);
      assert.ok(!command.includes('the brief'), `stdin in command text: ${command}`);
    }
    // The staged files are gone, and their directory is private.
    const dir = join(sandbox.home, BOAT_EXEC_DIR);
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });

  test('exec without env or stdin sends no file and reads nothing from stdin', async () => {
    boat.addSandbox('bx_aaaaaaaa');
    const result = await client.exec('bx_aaaaaaaa', { cmd: 'cat; echo done' });
    assert.equal(result.stdout, 'done\n');
    assert.equal(boat.requests.filter((r) => r.method === 'PUT').length, 0);
  });

  test('exec runs in cwd and reports a failing exit code', async () => {
    const sandbox = boat.addSandbox('bx_aaaaaaaa');
    const result = await client.exec('bx_aaaaaaaa', { cmd: 'pwd; exit 3', cwd: sandbox.home });
    assert.equal(result.exitCode, 3);
    assert.equal(result.stdout.trim(), sandbox.home);
  });

  test('exec refuses a timeout boat would refuse', async () => {
    boat.addSandbox('bx_aaaaaaaa');
    await assert.rejects(
      client.exec('bx_aaaaaaaa', { cmd: 'true', timeoutSeconds: 601 }),
      /at most 600 s/u,
    );
    assert.equal(boat.requests.length, 0);
  });

  test('exec makes the exec directory again when it went missing', async () => {
    const sandbox = boat.addSandbox('bx_aaaaaaaa');
    await client.exec('bx_aaaaaaaa', { cmd: 'true', envs: { A: '1' } });
    // The sandbox is made again under the same id: its home is empty.
    const { rmSync } = await import('node:fs');
    rmSync(join(sandbox.home, BOAT_EXEC_DIR), { recursive: true });
    const result = await client.exec('bx_aaaaaaaa', { cmd: 'echo "$A"', envs: { A: '2' } });
    assert.equal(result.stdout, '2\n');
  });

  test('a stopped sandbox answers machine_not_running, which ensureRunning fixes', async () => {
    boat.addSandbox('bx_aaaaaaaa', 'archived');
    await assert.rejects(
      client.exec('bx_aaaaaaaa', { cmd: 'true' }),
      (error: unknown) =>
        error instanceof InstaboxApiError &&
        error.code === 'machine_not_running' &&
        !error.retryable,
    );
    await client.ensureRunning('bx_aaaaaaaa');
    assert.equal(boat.sandboxes.get('bx_aaaaaaaa')?.state, 'ready');
    assert.equal(boat.requests.filter((r) => r.path.endsWith('/resume')).length, 1);
    assert.equal((await client.exec('bx_aaaaaaaa', { cmd: 'echo up' })).stdout, 'up\n');
  });

  test('a command that boat may have run is never sent twice', async () => {
    boat.addSandbox('bx_aaaaaaaa');
    boat.failNext('POST /sandboxes/bx_aaaaaaaa/commands', {
      status: 502,
      code: 'sandbox_direct_failed',
      message: 'connection reset',
      details: { retryable: false },
    });
    await assert.rejects(client.exec('bx_aaaaaaaa', { cmd: 'true' }), /connection reset/u);
    assert.equal(boat.commands().length, 1);
  });

  test('a command boat says did not run is sent again', async () => {
    boat.addSandbox('bx_aaaaaaaa');
    boat.failNext('POST /sandboxes/bx_aaaaaaaa/commands', {
      status: 502,
      code: 'sandbox_direct_failed',
      message: 'sandbox_restoring',
    });
    const result = await client.exec('bx_aaaaaaaa', { cmd: 'echo ok' });
    assert.equal(result.stdout, 'ok\n');
    assert.equal(boat.commands().length, 2);
  });

  test('staged files are removed when the command fails to start', async () => {
    const sandbox = boat.addSandbox('bx_aaaaaaaa');
    // Makes the exec directory, so the next failure hits the command itself.
    await client.exec('bx_aaaaaaaa', { cmd: 'true', envs: { T: '1' } });
    boat.failNext('POST /sandboxes/bx_aaaaaaaa/commands', {
      status: 409,
      code: 'sandbox_not_ready',
      message: 'error state',
    });
    await assert.rejects(client.exec('bx_aaaaaaaa', { cmd: 'true', envs: { T: SECRET } }));
    assert.deepEqual(readdirSync(join(sandbox.home, BOAT_EXEC_DIR)), []);
  });

  test('getMachine maps boat states and keeps a 404 as a 404', async () => {
    boat.addSandbox('bx_aaaaaaaa', 'archiving');
    assert.equal((await client.getMachine('bx_aaaaaaaa')).state, 'suspending');
    await assert.rejects(
      client.getMachine('bx_missing0'),
      (error: unknown) => error instanceof InstaboxApiError && error.status === 404,
    );
    assert.equal(machineState('idle'), 'running');
    assert.equal(machineState('cloning'), 'starting');
    assert.equal(machineState('archived'), 'suspended');
    assert.equal(machineState('error'), 'error');
  });

  test('leases move the auto-stop deadline; the last one let go sets the idle deadline', async () => {
    const sandbox = boat.addSandbox('bx_aaaaaaaa');
    client = new BoatClient({ apiKey: 'boat_test', baseUrl: boat.url, idleTtlSeconds: 300 });
    await client.putActivityLease('bx_aaaaaaaa', 'task-1', 900);
    await client.putActivityLease('bx_aaaaaaaa', 'task-2', 900);
    assert.equal(sandbox.ttlSeconds, 900);
    await client.deleteActivityLease('bx_aaaaaaaa', 'task-1');
    assert.equal(sandbox.ttlSeconds, 900);
    await client.deleteActivityLease('bx_aaaaaaaa', 'task-2');
    assert.equal(sandbox.ttlSeconds, 300);
    // A sandbox already gone has nothing to keep alive.
    await client.deleteActivityLease('bx_missing0', 'task-3');
  });

  test('snapshots are saved snapshots, named by the snapshot', async () => {
    boat.addSandbox('bx_aaaaaaaa');
    const created = await client.createSnapshot('bx_aaaaaaaa', { name: 'maka/Task_1 turn 2' });
    assert.equal(created.id, 'maka-task-1-turn-2');
    assert.equal(created.status, 'pending');
    const ready = await client.waitForSnapshot(created.id);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.sourceMachineId, 'bx_aaaaaaaa');
    await client.deleteSnapshot(created.id);
    assert.equal(boat.snapshots.size, 0);
    await client.deleteSnapshot(created.id);
  });

  test('a rate limit is retried after boat says when', async () => {
    boat.addSandbox('bx_aaaaaaaa');
    const waits: number[] = [];
    client = new BoatClient({
      apiKey: 'boat_test',
      baseUrl: boat.url,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    boat.failNext('GET /sandboxes/bx_aaaaaaaa', {
      status: 429,
      code: 'rate_limited',
      message: 'slow down',
      retryAfterSeconds: 2,
    });
    assert.equal((await client.getMachine('bx_aaaaaaaa')).state, 'running');
    assert.deepEqual(waits, [2000]);
  });

  test('getFile reads a file and describes a directory', {
    skip: process.platform !== 'linux' && 'needs GNU stat and base64, as in a boat sandbox',
  }, async () => {
    const sandbox = boat.addSandbox('bx_aaaaaaaa');
    writeFileSync(join(sandbox.home, 'notes.txt'), 'héllo\n');
    const file = await client.getFile('bx_aaaaaaaa', join(sandbox.home, 'notes.txt'));
    assert.equal(file.type, 'file');
    assert.equal(file.content, 'héllo\n');
    assert.equal(file.size, Buffer.byteLength('héllo\n'));
    assert.equal(file.binary, false);
    const dir = await client.getFile('bx_aaaaaaaa', sandbox.home);
    assert.equal(dir.type, 'dir');
    await assert.rejects(
      client.getFile('bx_aaaaaaaa', join(sandbox.home, 'missing')),
      (error: unknown) => error instanceof InstaboxApiError && error.status === 404,
    );
  });
});
