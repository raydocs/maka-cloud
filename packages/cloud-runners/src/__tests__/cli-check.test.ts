import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { cliCheckScript } from '../scripts.js';

/** A home with a `claude` CLI in it that records that it ran; the check's exit code is returned. */
function boxWith(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'cli-check-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, '.maka-cli', 'bin');
  mkdirSync(bin, { recursive: true });
  const ran = join(home, 'ran');
  const cli = join(bin, 'claude');
  // The CLI says who it ran as: only through the sudo double below is it the agent's account.
  writeFileSync(
    cli,
    `#!/bin/sh\necho "\${MAKA_TEST_VIA_SUDO:-control user}" >> ${ran}\necho 9.9.9\n`,
    { mode: 0o755 },
  );
  // A `sudo` that only marks the run as the agent's, as the fake sandbox of the other tests does.
  const shim = join(home, 'shim');
  mkdirSync(shim);
  writeFileSync(
    join(shim, 'sudo'),
    '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -n|--preserve-env) shift ;; -u) shift 2 ;; --) shift; break ;; *) break ;; esac; done\nif [ "$1" = env ] && [ "$2" = -i ]; then shift 2; exec env -i MAKA_TEST_VIA_SUDO=agent "$@"; fi\nMAKA_TEST_VIA_SUDO=agent exec "$@"\n',
    { mode: 0o755 },
  );
  const marker = join(home, 'marker.ok');
  writeFileSync(marker, '');
  const check = (): number => {
    try {
      execFileSync('sh', ['-c', cliCheckScript('claude', 'maka-agent')], {
        env: {
          PATH: `${shim}:${process.env.PATH ?? ''}`,
          HOME: home,
          MAKA_MARKER: marker,
          MAKA_VERSION: '9.9.9',
        },
        stdio: 'ignore',
      });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? 1;
    }
  };
  return { home, bin, cli, ran, check, shim };
}

test("a CLI that is the sandbox user's own and closed to everyone else passes the check", (t) => {
  const box = boxWith(t);
  assert.equal(box.check(), 0);
  // And it was asked as the agent's account, never as the sandbox user.
  assert.equal(readFileSync(box.ran, 'utf8').trim(), 'agent');
});

test('nothing in ~/.maka-cli stands in for a tool the check itself runs, and the CLI is never run by the sandbox user', (t) => {
  const box = boxWith(t);
  const hijacked = join(box.home, 'hijacked');
  // Whatever is on a PATH that has ~/.maka-cli/bin first would run as the sandbox user.
  for (const tool of ['id', 'readlink', 'find', 'grep']) {
    writeFileSync(
      join(box.bin, tool),
      `#!/bin/sh\necho ${tool} >> ${hijacked}\nexec /usr/bin/${tool} "$@"\n`,
      {
        mode: 0o755,
      },
    );
  }
  box.check();
  assert.equal(existsSync(hijacked), false, 'a planted tool ran as the sandbox user');
  assert.deepEqual(readFileSync(box.ran, 'utf8').trim().split('\n'), ['agent']);
});

test('a CLI the agent could have rewritten is not run as the sandbox user', (t) => {
  for (const mode of [0o757, 0o775]) {
    const box = boxWith(t);
    chmodSync(box.cli, mode);
    assert.notEqual(box.check(), 0, `mode ${mode.toString(8)}`);
    assert.equal(existsSync(box.ran), false, `mode ${mode.toString(8)} ran`);
  }
});

test('a CLI whose directory or whose dependencies are open to the group or the world is not run', (t) => {
  const dir = boxWith(t);
  chmodSync(dir.bin, 0o777);
  assert.notEqual(dir.check(), 0);
  assert.equal(existsSync(dir.ran), false);

  const dep = boxWith(t);
  mkdirSync(join(dep.home, '.maka-cli', 'lib'));
  const lib = join(dep.home, '.maka-cli', 'lib', 'dep.js');
  writeFileSync(lib, '');
  chmodSync(lib, 0o666);
  assert.notEqual(dep.check(), 0);
  assert.equal(existsSync(dep.ran), false);
});

test('a CLI found outside ~/.maka-cli is not run', (t) => {
  const box = boxWith(t);
  const elsewhere = join(box.home, 'elsewhere');
  mkdirSync(elsewhere);
  const target = join(elsewhere, 'claude');
  writeFileSync(target, `#!/bin/sh\necho ran >> ${box.ran}\necho 9.9.9\n`, { mode: 0o755 });
  rmSync(box.cli);
  symlinkSync(target, box.cli);
  assert.notEqual(box.check(), 0);
  assert.equal(existsSync(box.ran), false);
});

test('the version must be the pinned one, not one that merely contains it', (t) => {
  const box = boxWith(t);
  const say = (version: string) =>
    writeFileSync(box.cli, `#!/bin/sh\necho "claude ${version} (Claude Code)"\n`, { mode: 0o755 });
  const check = (pinned: string): number => {
    try {
      execFileSync('sh', ['-c', cliCheckScript('claude', 'maka-agent')], {
        env: {
          PATH: `${box.shim}:${process.env.PATH ?? ''}`,
          HOME: box.home,
          MAKA_MARKER: join(box.home, 'marker.ok'),
          MAKA_VERSION: pinned,
        },
        stdio: 'ignore',
      });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? 1;
    }
  };
  say('2.0.10');
  assert.equal(check('2.0.1'), 1);
  say('12.0.1');
  assert.equal(check('2.0.1'), 1);
  say('2.0.1');
  assert.equal(check('2.0.1'), 0);
  // A dot in the pin is a dot, not any character.
  assert.equal(check('2x0x1'), 1);
});
