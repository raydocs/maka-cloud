import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { InstaboxClient } from '@maka-cloud/instabox';
import { FakeInstabox } from '@maka-cloud/instabox/testing';
import { Fleet, FixedMachineProvider } from '@maka-cloud/runners';
import { FleetCodingSandbox } from '../sandbox.js';
import { CHECK_SCRIPT, CHECK_STOP_SCRIPT, checkTagPrefix } from '../scripts.js';

// The real thing, where this machine has a second account to run the checks as.
const CHANNEL = {
  user: process.env.MAKA_TEST_AGENT_USER ?? 'nobody',
  group: process.env.MAKA_TEST_AGENT_GROUP ?? 'nogroup',
};

function canSeparate(): string | undefined {
  const why = unseparated();
  // The job that is meant to run these (deploy/Dockerfile `real-account-tests`) must not skip them.
  if (why !== undefined && process.env.MAKA_REQUIRE_REAL_ACCOUNTS === '1') {
    throw new Error(`the real-account tests are required here, and ${why}`);
  }
  return why;
}

function unseparated(): string | undefined {
  if (process.getuid?.() !== 0) return 'needs root, to run commands as another account';
  try {
    execFileSync('sudo', ['-n', '-u', CHANNEL.user, 'id', '-u'], { stdio: 'pipe' });
    execFileSync('getent', ['group', CHANNEL.group], { stdio: 'pipe' });
  } catch {
    return `needs sudo -n and the account ${CHANNEL.user} with the group ${CHANNEL.group}`;
  }
  return undefined;
}

test('a repository test command runs as the other account, and the stop that ends it works', {
  skip: canSeparate(),
}, async (t) => {
  const tmp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'check-real-')));
  const root = join(tmp, 'work');
  const logRoot = join('/dev/shm', `maka-logs-${basename(tmp)}`);
  const home = join(tmp, 'home');
  await fs.mkdir(home, { recursive: true });
  for (let dir = root; dir !== '/' && dir !== dirname(dir); dir = dirname(dir)) {
    if (dir.startsWith('/tmp/'))
      await fs.mkdir(dir, { recursive: true }).then(() => fs.chmod(dir, 0o755));
  }
  // Where the account's `mktemp` can create (a real box's /tmp is world-writable).
  const scratch = join(tmp, 'scratch');
  await fs.mkdir(scratch, { mode: 0o1777 });
  await fs.chmod(scratch, 0o1777);
  const fake = await new FakeInstabox({ home }).start();
  t.after(async () => {
    await fake.close();
    await fs.rm(logRoot, { recursive: true, force: true });
    await fs.rm(tmp, { recursive: true, force: true });
  });
  const fleet = new Fleet({
    client: new InstaboxClient({
      apiKey: fake.apiKey,
      baseUrl: fake.url,
      sleep: async () => {},
      random: () => 0,
    }),
    sandboxes: new FixedMachineProvider(fake.machineId),
    workRoot: root,
    logRoot,
    pollIntervalMs: 5,
    agentChannel: CHANNEL,
  });
  const taskId = 'tsk_real_check';
  const machine = fleet.machine(fake.machineId);
  await machine.prepare(taskId, undefined, undefined, CHANNEL.group);
  const ws = await new FleetCodingSandbox(fleet).open(taskId);
  t.after(() => ws.release());
  const uid = execFileSync('id', ['-u', CHANNEL.user]).toString().trim();

  const tag = `${checkTagPrefix(taskId)}1-test`;
  const ran = await ws.execCheck(CHECK_SCRIPT, {
    envs: {
      MAKA_DIR: ws.dir,
      TMPDIR: scratch,
      MAKA_CHECK_TAG: tag,
      MAKA_CMD: 'id -u; echo mine > uid-was-written; id -u > uid',
      MAKA_TIMEOUT: '20',
      MAKA_TAIL: '1000',
    },
    timeoutSeconds: 40,
  });
  assert.equal(ran.exitCode, 0, ran.stderr);
  assert.equal(ran.stdout.trim(), uid, 'the test command ran as the other account');
  assert.notEqual(uid, String(process.getuid?.()));

  // A check still running is found by its tag and ended by the stop, which runs as root.
  const slow = ws.execCheck(CHECK_SCRIPT, {
    envs: {
      MAKA_DIR: ws.dir,
      TMPDIR: scratch,
      MAKA_CHECK_TAG: `${checkTagPrefix(taskId)}2-slow`,
      MAKA_CMD: 'sleep 30',
      MAKA_TIMEOUT: '30',
      MAKA_TAIL: '1000',
    },
    timeoutSeconds: 60,
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const stopped = await ws.execCheckStop(CHECK_STOP_SCRIPT, {
    envs: { MAKA_CHECK_TAG: checkTagPrefix(taskId) },
    timeoutSeconds: 30,
  });
  assert.equal(stopped.stdout.trim(), 'STOPPED', stopped.stderr);
  const ended = await slow;
  assert.notEqual(ended.exitCode, 0);
});
