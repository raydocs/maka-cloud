import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FILE_CAPS_PROBE } from '../agent-user.js';

/**
 * How the agent account answers "can you execute this?": as the file really is, yes to anything,
 * or nothing at all (sudo itself refused).
 */
type Agent = 'real' | 'always' | 'refused';
const AGENT: Record<Agent, string> = {
  real: 'as_agent() { "$@"; }',
  always: 'as_agent() { echo x; }',
  refused: 'as_agent() { return 1; }',
};

interface Box {
  /** A scan root standing in for a directory under `/`. */
  root: string;
  /** A second one, standing in for a mount such as `/data`. */
  data: string;
  /** The task root. */
  tasks: string;
  /** Adds a file under `dir`; `caps` is the line the fake `getcap` prints for it. */
  file(dir: string, name: string, options?: { mode?: number; caps?: string }): string;
}

interface Probe {
  agent?: Agent;
  /** The exit status of the fake `getcap`. */
  status?: number;
  /** The account the probe is told is the agent's (default: another one than the test's). */
  agentUser?: string;
  /** Extra scan roots, such as one that does not exist. */
  extraRoots?: string[];
  /** What the fake `getcap` says on stderr. */
  stderr?: string;
  /** The groups the agent account answers with (default: the test account's own). */
  agentGroups?: string;
  /** Run as in production, without scan roots, and only record how `find` is called. */
  production?: boolean;
}

/** Runs the privileged-file part of the probe over a scratch tree laid out by `setup`. */
function probe(setup: (box: Box) => void, options: Probe = {}): Record<string, string> {
  return probeWith(setup, options).facts;
}

function probeWith(
  setup: (box: Box) => void,
  options: Probe = {},
): { facts: Record<string, string>; finds: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'filecaps-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    // The line the fake getcap prints for a file, kept by inode: any file name works.
    const caps = join(dir, 'caps');
    mkdirSync(caps);
    const box: Box = {
      root: join(dir, 'root'),
      data: join(dir, 'data'),
      tasks: join(dir, 'data', 'work'),
      file(parent, name, { mode = 0o755, caps: line } = {}) {
        const path = join(parent, name);
        writeFileSync(path, '#!/bin/sh\n');
        chmodSync(path, mode);
        if (line !== undefined) writeFileSync(join(caps, String(statSync(path).ino)), `${line}\n`);
        return path;
      },
    };
    for (const d of [box.root, box.data, box.tasks]) mkdirSync(d, { recursive: true });
    setup(box);
    // A getcap that prints, for each file it is given, the line the test set for it.
    writeFileSync(
      join(bin, 'getcap'),
      `#!/bin/sh
for f in "$@"; do
  i=$(ls -di "$f" | head -n 1 | awk '{ print $1 }')
  if [ -f '${caps}'/"$i" ]; then cat '${caps}'/"$i"; fi
done
${options.stderr === undefined ? '' : `echo '${options.stderr}' >&2`}
exit ${options.status ?? 0}
`,
    );
    chmodSync(join(bin, 'getcap'), 0o755);
    const roots = [box.root, box.data, ...(options.extraRoots ?? [])].join('\n');
    const finds = join(dir, 'finds');
    const root = options.production
      ? `root() { if [ "$1" = find ]; then printf '%s\\n' "$*" >> '${finds}'; else "$@"; fi; }`
      : 'root() { "$@"; }';
    const agent =
      options.agentGroups === undefined
        ? AGENT[options.agent ?? 'real']
        : `as_agent() { if [ "$1" = id ]; then echo '${options.agentGroups}'; else "$@"; fi; }`;
    const run = spawnSync(
      'bash',
      ['-c', `tool_bin() { command -v "$1" || true; }\n${root}\n${agent}\n${FILE_CAPS_PROBE}`],
      {
        env: {
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          ...(options.production ? {} : { MAKA_SCAN_ROOTS: roots }),
          MAKA_ROOT: box.tasks,
          MAKA_AGENT_USER: options.agentUser ?? 'nobody',
        },
        encoding: 'utf8',
      },
    );
    const facts: Record<string, string> = {};
    for (const line of run.stdout.split('\n')) {
      const match = /^FACT ([a-z_]+)=(.*)$/u.exec(line.trim());
      if (match) facts[match[1] as string] = match[2] as string;
    }
    let found: string[] = [];
    try {
      // One call per entry; a test in a call may hold a line break itself.
      found = readFileSync(finds, 'utf8')
        .split(/\n(?=find )/u)
        .map((call) => call.trim())
        .filter(Boolean);
    } catch {}
    return { facts, finds: found };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a scan that finds nothing is clean', () => {
  const facts = probe((box) => {
    box.file(box.root, 'plain');
  });
  assert.equal(facts.agent_filecaps, 'none');
  assert.equal(facts.agent_setid, 'none');
});

test('a capability scan that failed is not a clean one, whatever it printed before it failed', () => {
  const setup = (box: Box) => {
    box.file(box.root, 'x', { caps: 'X cap_net_admin=ep' });
  };
  assert.equal(probe(setup, { status: 2 }).agent_filecaps, 'unchecked');
  assert.equal(
    probe((box) => box.file(box.root, 'y'), { status: 2 }).agent_filecaps,
    'unchecked',
    'a failure with nothing printed',
  );
});

test('a scan root that cannot be walked leaves both answers unchecked', () => {
  const facts = probe(() => {}, { extraRoots: ['/nonexistent-scan-root'] });
  assert.equal(facts.agent_filecaps, 'unchecked');
  assert.equal(facts.agent_setid, 'unchecked');
});

test('any capability on a program the agent can run fails, not only a list of known dangerous ones', () => {
  for (const cap of ['cap_chown', 'cap_fowner', 'cap_setfcap', 'cap_net_admin', 'cap_kill']) {
    assert.equal(
      probe((box) => {
        box.file(box.root, 'helper', { caps: `${join(box.root, 'helper')} ${cap}=ep` });
      }).agent_filecaps,
      'found',
      cap,
    );
  }
  assert.equal(
    probe((box) => {
      box.file(box.root, 'x', { caps: `${join(box.root, 'x')} =ep` });
    }).agent_filecaps,
    'found',
  );
});

test('a program on another mount, such as /data, is scanned too', () => {
  assert.equal(
    probe((box) => {
      box.file(box.data, 'tool', { caps: `${join(box.data, 'tool')} cap_chown=ep` });
    }).agent_filecaps,
    'found',
  );
});

test('a file name that holds " cap_" cannot hide its capability', () => {
  // getcap prints the name and then the capability; a parser that cut at the first " cap_"
  // checked "<root>/my", which does not exist, and reported nothing.
  assert.equal(
    probe((box) => {
      box.file(box.root, 'my cap_helper', {
        caps: `${join(box.root, 'my cap_helper')} cap_net_admin=ep`,
      });
    }).agent_filecaps,
    'found',
  );
  assert.equal(
    probe((box) => {
      box.file(box.root, 'my tool', { caps: `${join(box.root, 'my tool')} = cap_chown+ep` });
    }).agent_filecaps,
    'found',
  );
});

test('a capability on a program the agent cannot run is not a finding', () => {
  // The test's stand-in agent is the test's own account: a file nobody may execute stands in for
  // one the agent may not.
  assert.equal(
    probe((box) => {
      box.file(box.root, 'helper', {
        mode: 0o600,
        caps: `${join(box.root, 'helper')} cap_chown=ep`,
      });
    }).agent_filecaps,
    'none',
  );
});

test('an agent account that does not answer is not an answer of "no"', () => {
  assert.equal(
    probe(
      (box) => {
        box.file(box.root, 'helper', { caps: `${join(box.root, 'helper')} cap_chown=ep` });
      },
      { agent: 'refused' },
    ).agent_filecaps,
    'unchecked',
  );
});

test('the stock raw-socket and id-mapping helpers are allowed under their stock paths, nothing else', () => {
  assert.equal(
    probe((box) => {
      box.file(box.root, 'a', { caps: '/usr/bin/ping cap_net_raw=ep' });
      box.file(box.root, 'b', { caps: '/bin/ping6 cap_net_raw=ep' });
      box.file(box.root, 'c', { caps: '/usr/bin/newuidmap cap_setuid=ep' });
      box.file(box.root, 'd', { caps: '/usr/bin/newgidmap = cap_setgid+ep' });
    }).agent_filecaps,
    'none',
  );
  // Same name, more than raw sockets (the stand-in agent can run anything: /usr/bin/ping need not exist here).
  assert.equal(
    probe(
      (box) => {
        box.file(box.root, 'a', { caps: '/usr/bin/ping cap_net_raw,cap_net_admin=ep' });
      },
      { agent: 'always' },
    ).agent_filecaps,
    'found',
  );
});

test('the task root is scanned too: a privileged program put there by the image or a mount counts', () => {
  assert.equal(
    probe((box) => {
      box.file(box.tasks, 'tool', { caps: `${join(box.tasks, 'tool')} cap_chown=ep` });
    }).agent_filecaps,
    'found',
  );
  assert.equal(
    probe((box) => {
      box.file(box.tasks, 'su-like', { mode: 0o4755 });
    }).agent_setid,
    'found',
  );
});

test('the walk starts at / itself, so hidden directories and files at the top are in it', () => {
  const { finds } = probeWith(() => {}, { production: true });
  assert.ok(finds.length > 0, 'nothing was walked');
  for (const call of finds) {
    assert.ok(
      call.startsWith(
        'find / -ignore_readdir_race ( -path /proc -o -path /sys -o -path /dev ) -prune -o ',
      ),
      call,
    );
  }
});

test('a line break in a path cannot split a capability line into harmless ones', () => {
  // getcap prints "<path> <caps>": with this path, the old parser read two lines naming
  // "<data>/nonexistent" and "/nonexistent", neither of which exists.
  assert.equal(
    probe((box) => {
      const dir = join(box.data, 'nonexistent cap_net_admin=ep\n');
      mkdirSync(dir);
      box.file(dir, 'nonexistent', { caps: `${join(dir, 'nonexistent')} cap_chown=ep` });
    }).agent_filecaps,
    'found',
  );
});

test('a getcap that complains on stderr but exits 0 is not a clean scan', () => {
  assert.equal(
    probe((box) => box.file(box.root, 'x'), { stderr: "Failed to get capabilities of file 'x'" })
      .agent_filecaps,
    'unchecked',
  );
});

test('a program setuid or setgid to another account that the agent can run fails', () => {
  assert.equal(
    probe((box) => {
      box.file(box.data, 'su-like', { mode: 0o4755 });
    }).agent_setid,
    'found',
  );
  assert.equal(
    probe(
      (box) => {
        box.file(box.root, 'sg-like', { mode: 0o2755 });
      },
      { agentGroups: '999999' },
    ).agent_setid,
    'found',
  );
  // One the agent cannot execute is not a finding.
  assert.equal(
    probe((box) => {
      box.file(box.root, 'locked', { mode: 0o4600 });
    }).agent_setid,
    'none',
  );
});

test('the stock setuid tools are allowed by their whole path, not by one line of it', () => {
  assert.equal(
    probe((box) => {
      const dir = join(box.data, 'payload\n', 'usr', 'bin');
      mkdirSync(dir, { recursive: true });
      box.file(dir, 'sudo', { mode: 0o4755 });
    }).agent_setid,
    'found',
  );
});

test('a setgid program counts by its group, whoever owns it', () => {
  // Owned by the agent, but setgid to a group it is not in (say disk): running it gives that group.
  assert.equal(
    probe(
      (box) => {
        box.file(box.root, 'sg', { mode: 0o2755 });
      },
      { agentUser: userInfo().username, agentGroups: '999999' },
    ).agent_setid,
    'found',
  );
  // Setgid to a group the agent already has gives it nothing.
  assert.equal(
    probe(
      (box) => {
        box.file(box.root, 'sg', { mode: 0o2755 });
      },
      { agentUser: userInfo().username },
    ).agent_setid,
    'none',
  );
});

test('a setuid program owned by the agent itself is not a finding', () => {
  assert.equal(
    probe(
      (box) => {
        box.file(box.root, 'mine', { mode: 0o4755 });
      },
      { agentUser: userInfo().username },
    ).agent_setid,
    'none',
  );
});
