import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
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
  writeFileSync(cli, `#!/bin/sh\necho ran >> ${ran}\necho 9.9.9\n`, { mode: 0o755 });
  const marker = join(home, 'marker.ok');
  writeFileSync(marker, '');
  const check = (): number => {
    try {
      execFileSync('sh', ['-c', cliCheckScript('claude')], {
        env: {
          PATH: process.env.PATH ?? '',
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
  return { home, bin, cli, ran, check };
}

test("a CLI that is the sandbox user's own and closed to everyone else passes the check", (t) => {
  const box = boxWith(t);
  assert.equal(box.check(), 0);
  assert.equal(existsSync(box.ran), true);
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
