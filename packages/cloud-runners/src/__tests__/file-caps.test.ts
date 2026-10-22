import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FILE_CAPS_PROBE } from '../agent-user.js';

/** What the agent account answers to "can you execute this?": yes, no, or nothing at all (sudo itself refused). */
type Agent = 'x' | '-' | 'refused';
const AGENT: Record<Agent, string> = {
  x: 'as_agent() { echo x; }',
  '-': 'as_agent() { echo -; }',
  refused: 'as_agent() { return 1; }',
};

interface Probed {
  out: string;
  /** The directories `getcap -r` was asked about. */
  dirs: string[];
}

/** Runs the file-capability part of the probe with a `getcap` that prints `listing` and exits `status`. */
function probeWith(listing: string, status: number, agent: Agent = 'x'): Probed {
  const dir = mkdtempSync(join(tmpdir(), 'filecaps-'));
  try {
    writeFileSync(join(dir, 'listing'), listing);
    writeFileSync(
      join(dir, 'getcap'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${join(dir, 'args')}'\ncat '${join(dir, 'listing')}'\nexit ${status}\n`,
    );
    chmodSync(join(dir, 'getcap'), 0o755);
    const run = spawnSync(
      'bash',
      ['-c', `tool_bin() { command -v "$1" || true; }\n${AGENT[agent]}\n${FILE_CAPS_PROBE}`],
      { env: { PATH: `${dir}:${process.env.PATH ?? ''}` }, encoding: 'utf8' },
    );
    let dirs: string[] = [];
    try {
      dirs = readFileSync(join(dir, 'args'), 'utf8').split('\n').filter(Boolean);
    } catch {}
    return { out: run.stdout.trim(), dirs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const probe = (listing: string, status: number, agent: Agent = 'x'): string =>
  probeWith(listing, status, agent).out;

test('a capability scan that failed is not a clean one, whatever it printed before it failed', () => {
  assert.equal(probe('', 2), 'FACT agent_filecaps=unchecked');
  assert.equal(probe('/usr/bin/x cap_net_admin=ep\n', 2), 'FACT agent_filecaps=unchecked');
});

test('a scan that finds nothing is clean', () => {
  assert.equal(probe('', 0), 'FACT agent_filecaps=none');
});

test('every directory a program can live in is scanned, and the root is not', () => {
  const { dirs } = probeWith('', 0);
  for (const wanted of ['/usr', '/opt', '/etc', '/var']) {
    if (existsDir(wanted)) assert.ok(dirs.includes(wanted), `${wanted} not scanned: ${dirs}`);
  }
  assert.ok(!dirs.includes('/'), 'the root must not be scanned');
});

const existsDir = (path: string): boolean => spawnSync('test', ['-d', path]).status === 0;

test('any capability on a program the agent can run fails, not only a list of known dangerous ones', () => {
  for (const cap of ['cap_chown', 'cap_fowner', 'cap_setfcap', 'cap_net_admin', 'cap_kill']) {
    assert.equal(probe(`/usr/lib/x/helper ${cap}=ep\n`, 0), 'FACT agent_filecaps=found', cap);
  }
  // Out of the bin directories, and with a space in its name.
  assert.equal(probe('/opt/x/gst-ptp-helper cap_net_admin=ep\n', 0), 'FACT agent_filecaps=found');
  assert.equal(probe('/usr/local/bin/my tool cap_chown=ep\n', 0), 'FACT agent_filecaps=found');
  assert.equal(probe('/usr/bin/x =ep\n', 0), 'FACT agent_filecaps=found');
});

test('a capability on a program the agent cannot run is not a finding', () => {
  assert.equal(probe('/usr/lib/x/helper cap_chown=ep\n', 0, '-'), 'FACT agent_filecaps=none');
});

test('an agent account that does not answer is not an answer of "no"', () => {
  assert.equal(
    probe('/usr/lib/x/helper cap_chown=ep\n', 0, 'refused'),
    'FACT agent_filecaps=unchecked',
  );
});

test('the stock raw-socket and id-mapping helpers are allowed under their stock paths, nothing else', () => {
  assert.equal(
    probe(
      '/usr/bin/ping cap_net_raw=ep\n/bin/ping6 cap_net_raw=ep\n/usr/bin/newuidmap cap_setuid=ep\n/usr/bin/newgidmap = cap_setgid+ep\n',
      0,
    ),
    'FACT agent_filecaps=none',
  );
  // Same name, more than raw sockets.
  assert.equal(
    probe('/usr/bin/ping cap_net_raw,cap_net_admin=ep\n', 0),
    'FACT agent_filecaps=found',
  );
  // Same name, not under a stock path: raw sockets leave below the firewall, so it is a finding.
  assert.equal(probe('/usr/local/bin/ping cap_net_raw=ep\n', 0), 'FACT agent_filecaps=found');
  assert.equal(probe('/opt/x/ping cap_net_raw=ep\n', 0), 'FACT agent_filecaps=found');
});
