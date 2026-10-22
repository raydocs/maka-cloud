import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BASE_RESTORE_SCRIPT,
  BASE_REVERT_SCRIPT,
  BASE_STAGE_SCRIPT,
  BLOB_CHUNK_SCRIPT,
  CHANGES_SCRIPT,
  CLONE_SCRIPT,
  SAMPLE_SCRIPT,
} from '../scripts.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();

function run(script: string, env: Record<string, string>): string {
  return execFileSync('bash', ['-c', script], {
    env: { PATH: process.env.PATH ?? '', HOME: env.MAKA_DIR ?? '/', ...env },
    encoding: 'utf8',
  });
}

/**
 * The base check's two scripts in order, as the runner runs them: the stage (the sandbox user),
 * then the revert (the agent's account; the same user here). Gives the stage's output when it
 * staged nothing, else the revert's.
 */
function revertForBase(env: Record<string, string>): string {
  const staged = run(BASE_STAGE_SCRIPT, env);
  if (!/^STAGED \d+$/mu.test(staged)) return staged;
  return run(BASE_REVERT_SCRIPT, { MAKA_DIR: env.MAKA_DIR as string });
}

/** Every entry under `root` with what a write would change: mode, size, mtime and a link's target. */
async function snapshot(root: string): Promise<string[]> {
  const out: string[] = [];
  const entry = async (path: string) => {
    const st = await fs.lstat(path);
    const target = st.isSymbolicLink() ? ` -> ${await fs.readlink(path)}` : '';
    out.push(`${path} ${st.mode} ${st.size} ${st.mtimeMs}${target}`);
    return st;
  };
  const walk = async (dir: string) => {
    for (const name of await fs.readdir(dir)) {
      const st = await entry(join(dir, name));
      if (st.isDirectory()) await walk(join(dir, name));
    }
  };
  await entry(root);
  await walk(root);
  return out.sort();
}

/** The text of every file under `root`, one string. */
async function allText(root: string): Promise<string> {
  let text = '';
  for (const name of await fs.readdir(root, { withFileTypes: true })) {
    const path = join(root, name.name);
    text += `${name.name}\n`;
    if (name.isDirectory()) text += await allText(path);
    else if (name.isFile()) text += await fs.readFile(path, 'utf8');
  }
  return text;
}

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const tmp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'control-git-')));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const origin = join(tmp, 'origin');
  await fs.mkdir(join(origin, 'lib'), { recursive: true });
  await fs.writeFile(join(origin, 'lib', 'a.txt'), 'one\n');
  await fs.writeFile(join(origin, 'b.txt'), 'two\n');
  await fs.mkdir(join(origin, 'bin'));
  await fs.writeFile(join(origin, 'bin', 'run.sh'), '#!/bin/sh\necho ran\n', { mode: 0o755 });
  await fs.symlink('b.txt', join(origin, 'link'));
  git(origin, 'init', '-q');
  git(origin, 'add', '-A');
  git(origin, 'commit', '-q', '-m', 'base');
  const dir = join(tmp, 'task');
  const cloned = run(CLONE_SCRIPT, {
    MAKA_DIR: dir,
    MAKA_REPO_URL: `file://${origin}`,
    MAKA_REF: 'HEAD',
  });
  const base = /^BASE ([0-9a-f]{40})$/mu.exec(cloned)?.[1];
  assert.ok(base, cloned);
  return { tmp, dir, base, ws: join(dir, 'workspace') };
}

test('what the agent put in its own .git or .gitattributes never runs when the runner looks at the work', async (t) => {
  const { tmp, dir, base, ws } = await setup(t);
  const marker = join(tmp, 'ran-as-the-sandbox-user');
  const script = join(tmp, 'filter.sh');
  await fs.writeFile(script, `#!/bin/sh\n: > "${marker}"\ncat\n`, { mode: 0o755 });
  // The agent controls these: a filter, an external diff, a textconv, a hook path, fsmonitor.
  await fs.appendFile(
    join(ws, '.git', 'config'),
    `[filter "x"]\n\tclean = ${script}\n\tsmudge = ${script}\n\trequired = true\n` +
      `[diff "x"]\n\ttextconv = ${script}\n\tcommand = ${script}\n` +
      `[core]\n\tfsmonitor = ${script}\n\thooksPath = ${tmp}\n`,
  );
  await fs.writeFile(join(ws, '.gitattributes'), '* filter=x diff=x\n');
  await fs.writeFile(join(ws, 'lib', 'a.txt'), 'changed\n');
  await fs.writeFile(join(ws, 'new.txt'), 'new\n');

  const env = { MAKA_DIR: dir, MAKA_BASE: base };
  const changes = run(CHANGES_SCRIPT, env);
  assert.match(changes, /^RAW /mu, changes);
  assert.match(changes, /^PATCH \d+$/mu, changes);
  const sample = run(SAMPLE_SCRIPT, { MAKA_DIR: dir, MAKA_MAX_FILES: '100' });
  assert.match(sample, /^H [0-9a-f]{40} lib\/a\.txt$/mu, sample);
  const reverted = revertForBase({ ...env, MAKA_KEEP: '' });
  assert.match(reverted, /^REVERTED \d+$/mu, reverted);
  assert.equal(await fs.readFile(join(ws, 'lib', 'a.txt'), 'utf8'), 'one\n');
  assert.equal(existsSync(join(ws, 'new.txt')), false);
  assert.match(run(BASE_RESTORE_SCRIPT, { MAKA_DIR: dir }), /RESTORED/u);
  assert.equal(await fs.readFile(join(ws, 'lib', 'a.txt'), 'utf8'), 'changed\n');
  assert.equal(existsSync(marker), false, 'the agent’s filter ran as the sandbox user');
});

test('the change is read from the working tree whatever the agent did to its own repository', async (t) => {
  const { dir, base, ws } = await setup(t);
  // The agent replaces its repository outright and commits a different history over the base.
  await fs.rm(join(ws, '.git'), { recursive: true, force: true });
  git(ws, 'init', '-q');
  await fs.writeFile(join(ws, 'b.txt'), 'rewritten\n');
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'other history');
  const env = { MAKA_DIR: dir, MAKA_BASE: base };
  const changes = run(CHANGES_SCRIPT, env);
  const raw = /^RAW (\S*)$/mu.exec(changes)?.[1] ?? '';
  const entries = Buffer.from(raw, 'base64').toString('utf8').split('\0').filter(Boolean);
  assert.ok(
    entries.some((entry) => entry === 'b.txt'),
    entries.join(' | '),
  );
  assert.ok(!entries.includes('lib/a.txt'), 'a file the work did not change is not listed');
  const size = /^SIZE ([0-9a-f]{40}) (\d+)$/mu.exec(changes);
  if (size) {
    const blob = run(BLOB_CHUNK_SCRIPT, {
      MAKA_DIR: dir,
      MAKA_SHA: size[1] as string,
      MAKA_OFF: '0',
      MAKA_LEN: '100',
    });
    assert.ok(Buffer.from(blob, 'base64').length > 0);
  }
});

test('a workspace without the control repository is refused, not read through its own .git', async (t) => {
  const { dir, base } = await setup(t);
  await fs.rm(join(dir, 'control.git'), { recursive: true, force: true });
  const out = run(CHANGES_SCRIPT, { MAKA_DIR: dir, MAKA_BASE: base });
  assert.match(out, /^ERR control repository missing$/mu, out);
});

test('a repository inside the checkout is refused before git runs a child in it', async (t) => {
  const { tmp, dir, base, ws } = await setup(t);
  const marker = join(tmp, 'ran-in-the-nested-repository');
  const script = join(tmp, 'monitor.sh');
  await fs.writeFile(script, `#!/bin/sh\n: > "${marker}"\n`, { mode: 0o755 });
  // A gitlink in the index makes git look inside the directory, with the agent's own configuration.
  const nested = join(ws, 'lib', 'sub');
  await fs.mkdir(nested, { recursive: true });
  git(nested, 'init', '-q');
  await fs.writeFile(join(nested, 'f'), 'x\n');
  git(nested, 'add', '-A');
  git(nested, 'commit', '-q', '-m', 'inner');
  await fs.appendFile(join(nested, '.git', 'config'), `[core]\n\tfsmonitor = ${script}\n`);
  const env = { MAKA_DIR: dir, MAKA_BASE: base };
  for (const [name, out] of [
    ['changes', run(CHANGES_SCRIPT, env)],
    ['sample', run(SAMPLE_SCRIPT, { MAKA_DIR: dir, MAKA_MAX_FILES: '100' })],
    ['revert', revertForBase({ ...env, MAKA_KEEP: '' })],
  ] as const) {
    assert.match(out, /^ERR nested repository .*lib\/sub\/\.git$/mu, `${name}: ${out}`);
  }
  assert.equal(existsSync(marker), false, 'a program of the nested repository ran');
});

test('the stage leaves the workspace as it was and keeps the base versions in numbered files', async (t) => {
  const { dir, base, ws } = await setup(t);
  await fs.writeFile(join(ws, 'lib', 'a.txt'), 'changed\n');
  await fs.writeFile(join(ws, 'new.txt'), 'new\n');
  await fs.rm(join(ws, 'bin', 'run.sh'));
  await fs.rm(join(ws, 'link'));
  await fs.writeFile(join(ws, 'kept.txt'), 'the reproduction test\n');
  const before = await snapshot(ws);
  const out = run(BASE_STAGE_SCRIPT, { MAKA_DIR: dir, MAKA_BASE: base, MAKA_KEEP: 'kept.txt' });
  assert.match(out, /^STAGED 4$/mu, out);
  assert.deepEqual(await snapshot(ws), before, 'the stage wrote in the workspace');

  const st = join(dir, 'base-stage');
  assert.deepEqual((await fs.readdir(st)).sort(), ['blobs', 'modes', 'paths']);
  const split = async (name: string) =>
    (await fs.readFile(join(st, name), 'utf8')).split('\0').slice(0, -1);
  const paths = await split('paths');
  const modes = await split('modes');
  assert.deepEqual([...paths].sort(), ['bin/run.sh', 'lib/a.txt', 'link', 'new.txt']);
  const mode = (path: string) => modes[paths.indexOf(path)];
  assert.equal(mode('lib/a.txt'), '100644');
  assert.equal(mode('bin/run.sh'), '100755');
  assert.equal(mode('link'), '120000');
  assert.equal(mode('new.txt'), '-', 'a new file has no base version');
  // Content is by number, never by path.
  const blobs = (await fs.readdir(join(st, 'blobs'))).sort();
  assert.deepEqual(blobs, ['0', '1', '2']);
  const blob = (path: string) =>
    fs.readFile(join(st, 'blobs', String(paths.indexOf(path))), 'utf8');
  assert.equal(await blob('lib/a.txt'), 'one\n');
  assert.equal(await blob('bin/run.sh'), '#!/bin/sh\necho ran\n');
  assert.equal(await blob('link'), 'b.txt');
  assert.equal(existsSync(join(dir, 'base-check')), true, 'the backup directory is made here');
});

test('a directory the agent swapped for a symlink is not read or written through by the stage', async (t) => {
  const { tmp, dir, base, ws } = await setup(t);
  const outside = join(tmp, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(join(outside, 'a.txt'), 'not the checkout\n');
  await fs.writeFile(join(outside, 'secret.txt'), 'control-user-only\n');
  await fs.rm(join(ws, 'lib'), { recursive: true });
  await fs.symlink(outside, join(ws, 'lib'));
  const beforeOutside = await snapshot(outside);
  const beforeWs = await snapshot(ws);
  const out = run(BASE_STAGE_SCRIPT, { MAKA_DIR: dir, MAKA_BASE: base, MAKA_KEEP: '' });
  assert.match(out, /^STAGED \d+$/mu, out);
  assert.deepEqual(await snapshot(outside), beforeOutside, 'the stage wrote through the link');
  assert.deepEqual(await snapshot(ws), beforeWs, 'the stage wrote in the workspace');
  const staged =
    (await allText(join(dir, 'base-stage'))) + (await allText(join(dir, 'base-check')));
  assert.ok(!staged.includes('not the checkout'), 'the stage read through the link');
  assert.ok(!staged.includes('control-user-only'), 'the stage read through the link');
  assert.match(staged, /one\n/u, 'the base version came from the control repository');
});

test('the revert and the restore put the base back and the change returns, modes and links included', async (t) => {
  const { dir, base, ws } = await setup(t);
  await fs.writeFile(join(ws, 'lib', 'a.txt'), 'changed\n');
  await fs.writeFile(join(ws, 'new.txt'), 'new\n');
  await fs.mkdir(join(ws, 'fresh', 'deep'), { recursive: true });
  await fs.writeFile(join(ws, 'fresh', 'deep', 'f.txt'), 'deep\n');
  await fs.rm(join(ws, 'bin', 'run.sh'));
  await fs.writeFile(join(ws, 'bin', 'run.sh'), 'not executable now\n', { mode: 0o644 });
  await fs.rm(join(ws, 'link'));
  await fs.writeFile(join(ws, 'link'), 'now a file\n');
  await fs.writeFile(join(ws, 'kept.txt'), 'the reproduction test\n');
  const env = { MAKA_DIR: dir, MAKA_BASE: base, MAKA_KEEP: 'kept.txt' };
  const out = revertForBase(env);
  assert.match(out, /^REVERTED 5$/mu, out);
  assert.equal(await fs.readFile(join(ws, 'lib', 'a.txt'), 'utf8'), 'one\n');
  assert.equal(existsSync(join(ws, 'new.txt')), false);
  assert.equal(existsSync(join(ws, 'fresh', 'deep', 'f.txt')), false);
  assert.equal(await fs.readFile(join(ws, 'kept.txt'), 'utf8'), 'the reproduction test\n');
  assert.equal(await fs.readFile(join(ws, 'bin', 'run.sh'), 'utf8'), '#!/bin/sh\necho ran\n');
  assert.ok(
    (statSync(join(ws, 'bin', 'run.sh')).mode & 0o100) !== 0,
    'the base file is executable',
  );
  assert.equal(await fs.readlink(join(ws, 'link')), 'b.txt');
  // What the agent writes in the base's files stays readable and writable by its group.
  assert.equal(statSync(join(ws, 'lib', 'a.txt')).mode & 0o660, 0o660);
  assert.match(run(BASE_RESTORE_SCRIPT, { MAKA_DIR: dir }), /^RESTORED$/mu);
  assert.equal(await fs.readFile(join(ws, 'lib', 'a.txt'), 'utf8'), 'changed\n');
  assert.equal(await fs.readFile(join(ws, 'new.txt'), 'utf8'), 'new\n');
  assert.equal(await fs.readFile(join(ws, 'fresh', 'deep', 'f.txt'), 'utf8'), 'deep\n');
  assert.equal(await fs.readFile(join(ws, 'bin', 'run.sh'), 'utf8'), 'not executable now\n');
  assert.equal(await fs.readFile(join(ws, 'link'), 'utf8'), 'now a file\n');
  assert.deepEqual(await fs.readdir(join(dir, 'base-check')), [], 'the backup is emptied');
  assert.match(run(BASE_RESTORE_SCRIPT, { MAKA_DIR: dir }), /^RESTORED$/mu, 'idempotent');
});

test('the agent group reads the stage and writes the backup, and cannot write the stage', async (t) => {
  const { dir, base, ws } = await setup(t);
  await fs.writeFile(join(ws, 'lib', 'a.txt'), 'changed\n');
  const group = execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim();
  // As on a box, where the workspace is handed to the agent's group before anything runs in it.
  execFileSync('chmod', ['-R', 'g+rwX', ws]);
  const out = run(BASE_STAGE_SCRIPT, {
    MAKA_DIR: dir,
    MAKA_BASE: base,
    MAKA_KEEP: '',
    MAKA_AGENT_GROUP: group,
  });
  assert.match(out, /^STAGED 1$/mu, out);
  const perm = (path: string) => statSync(path).mode & 0o7777;
  const st = join(dir, 'base-stage');
  assert.equal(perm(st), 0o2750);
  assert.equal(perm(join(st, 'blobs')), 0o2750);
  assert.equal(perm(join(st, 'paths')), 0o640);
  assert.equal(perm(join(st, 'blobs', '0')), 0o640);
  assert.equal(perm(join(dir, 'base-check')), 0o2770);
});

test('a checkout file the agent group cannot read refuses the base check at the stage', async (t) => {
  const { dir, base, ws } = await setup(t);
  const group = execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim();
  // The clone is private to the sandbox user until the box hands it to the group: not readable by it.
  const out = run(BASE_STAGE_SCRIPT, {
    MAKA_DIR: dir,
    MAKA_BASE: base,
    MAKA_KEEP: '',
    MAKA_AGENT_GROUP: group,
  });
  assert.match(out, /^UNREADABLE_FOR_AGENT /mu, out);
  assert.equal(existsSync(join(ws, 'lib', 'a.txt')), true);
  assert.equal(existsSync(join(dir, 'base-check')), false, 'nothing is handed to the agent');
});

test('a staged path that leaves the workspace is refused by the revert', async (t) => {
  const { tmp, dir, ws } = await setup(t);
  await fs.writeFile(join(tmp, 'evil'), 'mine\n');
  const st = join(dir, 'base-stage');
  await fs.mkdir(st);
  await fs.writeFile(join(st, 'paths'), '../../evil\0');
  await fs.writeFile(join(st, 'modes'), '-\0');
  await fs.mkdir(join(dir, 'base-check'));
  const out = run(BASE_REVERT_SCRIPT, { MAKA_DIR: dir });
  assert.match(out, /^UNSAFE_PATH \.\.\/\.\.\/evil$/mu, out);
  assert.equal(await fs.readFile(join(tmp, 'evil'), 'utf8'), 'mine\n');
  assert.equal(existsSync(join(ws, 'lib', 'a.txt')), true);
});

test('a leftover of an interrupted check blocks a new revert until it is put back', async (t) => {
  const { dir, base, ws } = await setup(t);
  await fs.writeFile(join(ws, 'lib', 'a.txt'), 'changed\n');
  const env = { MAKA_DIR: dir, MAKA_BASE: base, MAKA_KEEP: '' };
  assert.match(revertForBase(env), /^REVERTED 1$/mu);
  assert.match(run(BASE_REVERT_SCRIPT, { MAKA_DIR: dir }), /^RESTORE_FAILED$/mu);
  assert.match(run(BASE_RESTORE_SCRIPT, { MAKA_DIR: dir }), /^RESTORED$/mu);
  assert.equal(await fs.readFile(join(ws, 'lib', 'a.txt'), 'utf8'), 'changed\n');
});

test('a base check a closed process left half-way is not put over the tree the next run clones', async (t) => {
  const { tmp, dir, base, ws } = await setup(t);
  await fs.writeFile(join(ws, 'lib', 'a.txt'), 'changed by the earlier process\n');
  const env = { MAKA_DIR: dir, MAKA_BASE: base };
  assert.match(revertForBase({ ...env, MAKA_KEEP: '' }), /^REVERTED \d+$/mu);
  assert.equal(existsSync(join(dir, 'base-check')), true, 'the closed process left its copy');

  // The next process runs the task again from a fresh clone.
  const cloned = run(CLONE_SCRIPT, {
    MAKA_DIR: dir,
    MAKA_REPO_URL: `file://${join(tmp, 'origin')}`,
    MAKA_REF: 'HEAD',
  });
  assert.match(cloned, /^BASE [0-9a-f]{40}$/mu, cloned);
  assert.equal(existsSync(join(dir, 'base-check')), false);
  assert.match(revertForBase({ ...env, MAKA_KEEP: '' }), /^REVERTED 0$/mu);
  assert.equal(await fs.readFile(join(ws, 'lib', 'a.txt'), 'utf8'), 'one\n');
  assert.match(run(BASE_RESTORE_SCRIPT, { MAKA_DIR: dir }), /RESTORED/u);
  assert.equal(
    await fs.readFile(join(ws, 'lib', 'a.txt'), 'utf8'),
    'one\n',
    'the earlier process’s change did not come back',
  );
});
