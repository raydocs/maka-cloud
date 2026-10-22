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
import {
  BASE_RESTORE_SCRIPT,
  BASE_REVERT_SCRIPT,
  BASE_STAGE_SCRIPT,
  CLONE_SCRIPT,
} from '../scripts.js';

// The real thing, where this machine has a second account to run as the agent.
const CHANNEL = { user: 'nobody', group: 'nogroup' };

function canSeparate(): string | undefined {
  if (process.getuid?.() !== 0) return 'needs root, to run commands as another account';
  try {
    execFileSync('sudo', ['-n', '-u', CHANNEL.user, 'id', '-u'], { stdio: 'pipe' });
    execFileSync('getent', ['group', CHANNEL.group], { stdio: 'pipe' });
  } catch {
    return `needs sudo -n and the account ${CHANNEL.user} with the group ${CHANNEL.group}`;
  }
  return undefined;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();

test('the agent account reads and writes the nested files of a checkout, and of a base check', {
  skip: canSeparate(),
}, async (t) => {
  const tmp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'checkout-real-')));
  const root = join(tmp, 'work');
  const logRoot = join('/dev/shm', `maka-logs-${basename(tmp)}`);
  const home = join(tmp, 'home');
  await fs.mkdir(home, { recursive: true });
  for (let dir = root; dir !== '/' && dir !== dirname(dir); dir = dirname(dir)) {
    if (dir.startsWith('/tmp/'))
      await fs.mkdir(dir, { recursive: true }).then(() => fs.chmod(dir, 0o755));
  }
  const scratch = join(tmp, 'scratch');
  await fs.mkdir(scratch, { mode: 0o1777 });
  await fs.chmod(scratch, 0o1777);
  const origin = join(tmp, 'origin');
  await fs.mkdir(join(origin, 'lib', 'deep'), { recursive: true });
  await fs.writeFile(join(origin, 'lib', 'deep', 'a.txt'), 'one\n');
  await fs.writeFile(join(origin, 'lib', 'deep', 'gone.txt'), 'will be deleted\n');
  await fs.writeFile(join(origin, 'lib', 'run.sh'), '#!/bin/sh\necho ran\n', { mode: 0o755 });
  git(origin, 'init', '-q');
  git(origin, 'add', '-A');
  git(origin, 'commit', '-q', '-m', 'base');
  // The machine running the test may carry file capabilities of its own (a media helper, say), which
  // the box check refuses; what is tested here is the checkout, so its capability scan reads nothing.
  const noCaps = join(tmp, 'no-caps');
  await fs.mkdir(noCaps);
  await fs.writeFile(join(noCaps, 'getcap'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${noCaps}:${path ?? ''}`;
  t.after(() => {
    process.env.PATH = path;
  });
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
  const taskId = 'tsk_real_checkout';
  const machine = fleet.machine(fake.machineId);
  await machine.prepare(taskId, undefined, undefined, CHANNEL.group);
  const ws = await new FleetCodingSandbox(fleet).open(taskId);
  t.after(() => ws.release());

  const cloned = await ws.exec(CLONE_SCRIPT, {
    envs: { MAKA_DIR: ws.dir, MAKA_REPO_URL: `file://${origin}`, MAKA_REF: 'HEAD' },
    timeoutSeconds: 60,
  });
  const base = /^BASE ([0-9a-f]{40})$/mu.exec(cloned.stdout)?.[1];
  assert.ok(base, cloned.stdout + cloned.stderr);

  // The agent works in the checkout: it reads a nested file, runs a script, edits, adds and deletes.
  const asAgent = async (command: string) => {
    const out = await ws.execCheck(`cd "$MAKA_DIR/workspace" && ${command}`, {
      envs: { MAKA_DIR: ws.dir, TMPDIR: scratch },
      timeoutSeconds: 30,
    });
    assert.equal(out.exitCode, 0, `${command}: ${out.stderr}`);
    return out.stdout.trim();
  };
  assert.equal(await asAgent('cat lib/deep/a.txt'), 'one');
  assert.equal(await asAgent('lib/run.sh'), 'ran');
  // A file made with a narrow umask is the agent's alone to write: it must stay so after a restore.
  await asAgent(
    'umask 022 && echo two > lib/deep/a.txt && rm lib/deep/gone.txt && mkdir -p lib/new && echo n > lib/new/f',
  );

  // Git, run by the agent in a checkout the sandbox user owns, is not refused as someone else's.
  assert.equal(await asAgent('git log -1 --format=%H'), base);
  assert.match(await asAgent('git status --short'), /M lib\/deep\/a\.txt/u);

  // The base check puts the base's files back: the sandbox user stages them, the agent's account
  // writes them into its workspace, so the agent reads and writes them, and the change returns.
  const env = { MAKA_DIR: ws.dir, MAKA_BASE: base, MAKA_KEEP: '' };
  const stage = () => ws.exec(BASE_STAGE_SCRIPT, { envs: env, timeoutSeconds: 60 });
  const restore = () =>
    ws.execCheck(BASE_RESTORE_SCRIPT, { envs: { MAKA_DIR: ws.dir }, timeoutSeconds: 60 });
  const staged = await stage();
  assert.match(staged.stdout, /^STAGED \d+$/mu, staged.stdout + staged.stderr);
  const reverted = await ws.execCheck(BASE_REVERT_SCRIPT, { envs: env, timeoutSeconds: 60 });
  assert.match(reverted.stdout, /^REVERTED \d+$/mu, reverted.stdout + reverted.stderr);
  assert.equal(await asAgent('cat lib/deep/a.txt'), 'one');
  assert.equal(await asAgent('cat lib/deep/gone.txt'), 'will be deleted');
  assert.equal(await asAgent('lib/run.sh'), 'ran');
  assert.equal(await asAgent('echo more >> lib/deep/gone.txt && echo written'), 'written');
  // The stage is the agent's to read, not to change.
  assert.equal(await asAgent(`cat ${ws.dir}/base-stage/paths >/dev/null && echo read`), 'read');
  assert.equal(
    await asAgent(`touch ${ws.dir}/base-stage/x 2>/dev/null || echo cannot write`),
    'cannot write',
  );
  // A file the agent's account could not read would fail a base check for the wrong reason: refused.
  const putBack = await restore();
  assert.match(putBack.stdout, /RESTORED/u, putBack.stdout + putBack.stderr);
  await fs.writeFile(join(ws.dir, 'workspace', 'lib', 'private.txt'), 'x', { mode: 0o600 });
  await fs.chown(join(ws.dir, 'workspace', 'lib', 'private.txt'), 0, 0);
  const refused = await ws.exec(BASE_STAGE_SCRIPT, {
    envs: { ...env, MAKA_KEEP: 'lib/private.txt' },
    timeoutSeconds: 60,
  });
  assert.match(refused.stdout, /^UNREADABLE_FOR_AGENT .*private\.txt$/mu, refused.stdout);
  await fs.rm(join(ws.dir, 'workspace', 'lib', 'private.txt'));
  const restored = await restore();
  assert.match(restored.stdout, /RESTORED/u, restored.stdout + restored.stderr);
  assert.equal(await asAgent('cat lib/deep/a.txt'), 'two');
  assert.equal(await asAgent('cat lib/new/f'), 'n');
  assert.equal(await asAgent('echo more >> lib/new/f && echo written'), 'written');
});
