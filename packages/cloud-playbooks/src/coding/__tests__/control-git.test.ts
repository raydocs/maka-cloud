import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BASE_RESTORE_SCRIPT,
  BASE_REVERT_SCRIPT,
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

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const tmp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'control-git-')));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const origin = join(tmp, 'origin');
  await fs.mkdir(join(origin, 'lib'), { recursive: true });
  await fs.writeFile(join(origin, 'lib', 'a.txt'), 'one\n');
  await fs.writeFile(join(origin, 'b.txt'), 'two\n');
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
  const reverted = run(BASE_REVERT_SCRIPT, { ...env, MAKA_KEEP: '' });
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
