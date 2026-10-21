import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FILE_CAPS_PROBE } from '../agent-user.js';

/** Runs the file-capability part of the probe with a `getcap` that prints `listing` and exits `status`. */
function probe(listing: string, status: number, executables: readonly string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'filecaps-'));
  try {
    writeFileSync(join(dir, 'listing'), listing);
    writeFileSync(
      join(dir, 'getcap'),
      `#!/bin/sh\ncat '${join(dir, 'listing')}'\nexit ${status}\n`,
    );
    chmodSync(join(dir, 'getcap'), 0o755);
    for (const name of executables) {
      writeFileSync(join(dir, name), '#!/bin/sh\n');
      chmodSync(join(dir, name), 0o755);
    }
    writeFileSync(join(dir, 'plain'), 'not executable');
    chmodSync(join(dir, 'plain'), 0o644);
    const run = spawnSync('bash', ['-c', `as_agent() { "$@"; }\n${FILE_CAPS_PROBE}`], {
      env: { PATH: `${dir}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });
    return run.stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a capability scan that failed is not a clean one, whatever it printed before it failed', () => {
  assert.equal(probe('', 2), 'FACT agent_filecaps=unchecked');
  assert.equal(probe('/usr/bin/x cap_net_admin=ep\n', 2), 'FACT agent_filecaps=unchecked');
});

test('a scan that finds nothing is clean', () => {
  assert.equal(probe('', 0), 'FACT agent_filecaps=none');
});

test('any capability on a program the agent can run fails, not only a list of known dangerous ones', () => {
  for (const cap of ['cap_chown', 'cap_fowner', 'cap_setfcap', 'cap_net_admin', 'cap_kill']) {
    // The listing names a file that exists here and that the agent (this process) can execute.
    const dir = mkdtempSync(join(tmpdir(), 'filecaps-bin-'));
    try {
      writeFileSync(join(dir, 'tool'), '#!/bin/sh\n');
      chmodSync(join(dir, 'tool'), 0o755);
      assert.equal(probe(`${join(dir, 'tool')} ${cap}=ep\n`, 0), 'FACT agent_filecaps=found', cap);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a capability on a program the agent cannot run is not a finding', () => {
  assert.equal(probe('/nonexistent/tool cap_chown=ep\n', 0), 'FACT agent_filecaps=none');
});

test('the stock raw-socket and id-mapping helpers are allowed, nothing else of the same name', () => {
  assert.equal(
    probe(
      '/usr/bin/ping cap_net_raw=ep\n/usr/bin/newuidmap cap_setuid=ep\n/usr/bin/newgidmap = cap_setgid+ep\n',
      0,
    ),
    'FACT agent_filecaps=none',
  );
  const dir = mkdtempSync(join(tmpdir(), 'filecaps-bin-'));
  try {
    writeFileSync(join(dir, 'ping'), '#!/bin/sh\n');
    chmodSync(join(dir, 'ping'), 0o755);
    // Same name, more than raw sockets: not the stock helper.
    assert.equal(
      probe(`${join(dir, 'ping')} cap_net_raw,cap_net_admin=ep\n`, 0),
      'FACT agent_filecaps=found',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
