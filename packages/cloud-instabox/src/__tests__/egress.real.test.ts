import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  applyEgressGuard,
  EGRESS_BLOCKED_V4,
  EGRESS_BLOCKED_V6,
  EGRESS_CHAIN,
  EGRESS_LOOPBACK_V4,
  EGRESS_LOOPBACK_V6,
} from '../egress.js';
import { setup, type Harness } from './harness.js';

/**
 * The guard against the real iptables, in a network namespace of its own, so nothing here touches
 * this machine's firewall. Skipped where the machine cannot make one (no root, no iptables): the
 * stand-ins in egress.test.ts cannot show how the real tool prints its rules back.
 */
function namespaceHolder(): { child: ChildProcess; pid: number } | undefined {
  try {
    const probe = spawn('unshare', ['-n', 'sleep', '600'], { stdio: 'ignore' });
    if (!probe.pid) return undefined;
    const pid = probe.pid;
    // The namespace exists once `unshare` has exec'd `sleep`; wait for it to differ from ours.
    const own = execFileSync('readlink', ['/proc/self/ns/net']).toString();
    for (let i = 0; i < 200; i++) {
      try {
        if (execFileSync('readlink', [`/proc/${pid}/ns/net`]).toString() !== own) break;
      } catch {}
      execFileSync('sleep', ['0.01']);
    }
    execFileSync('nsenter', [`--net=/proc/${pid}/ns/net`, 'iptables', '-w', '-S'], {
      stdio: 'ignore',
    });
    return { child: probe, pid };
  } catch {
    return undefined;
  }
}

/** Brings lo up and gives it a private alias, with ioctls (the machine may have no `ip`). */
const LO_SETUP = `
import fcntl, socket, struct
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
def ifreq(name, tail):
    return struct.pack('16s', name.encode()) + tail
flags = struct.unpack('16sH', fcntl.ioctl(s, 0x8913, ifreq('lo', b'\\0' * 24))[:18])[1]
fcntl.ioctl(s, 0x8914, ifreq('lo', struct.pack('H', flags | 1 | 0x40) + b'\\0' * 22))
def addr(ip):
    return struct.pack('H', socket.AF_INET) + b'\\0\\0' + socket.inet_aton(ip) + b'\\0' * 8
fcntl.ioctl(s, 0x8916, ifreq('lo:1', addr('10.9.9.9')))
fcntl.ioctl(s, 0x891c, ifreq('lo:1', addr('255.255.255.255')))
`;

describe('applyEgressGuard against the real iptables', () => {
  const holder = process.platform === 'linux' ? namespaceHolder() : undefined;
  let h: Harness;
  let state: string;
  let prefix: string[];
  const iptables = (tool: string, ...args: string[]): string =>
    execFileSync('nsenter', [`--net=/proc/${holder?.pid}/ns/net`, tool, '-w', ...args]).toString();

  before(async () => {
    if (!holder) return;
    state = await fs.mkdtemp(join(tmpdir(), 'egress-real-'));
    prefix = ['nsenter', `--net=/proc/${holder.pid}/ns/net`];
    h = await setup({ firewall: 'none', commandPrefix: prefix });
    await fs.writeFile(join(state, 'resolv.conf'), 'nameserver 10.0.0.53\nnameserver fd00::53\n');
    await fs.writeFile(join(state, 'if_inet6'), 'fe80000000000000 02 40 20 80 eth0\n');
  });
  after(async () => {
    await h?.cleanup();
    holder?.child.kill('SIGKILL');
    if (state) await fs.rm(state, { recursive: true, force: true });
  });

  const run = () =>
    applyEgressGuard(h.client, h.fake.machineId, {
      resolvConf: join(state, 'resolv.conf'),
      ifInet6: join(state, 'if_inet6'),
    });

  it('installs, reads back what the real tool prints, and leaves it alone the second time', async (t) => {
    if (!holder) return t.skip('no network namespace to try it in');
    await run();
    const rules = iptables('iptables', '-S', EGRESS_CHAIN);
    assert.match(
      rules,
      /--ctstate RELATED,ESTABLISHED -j RETURN/u,
      'the real tool reorders the states',
    );
    for (const net of EGRESS_BLOCKED_V4) assert.ok(rules.includes(`-d ${net} -j REJECT`), net);
    for (const net of EGRESS_BLOCKED_V6) {
      assert.ok(iptables('ip6tables', '-S', EGRESS_CHAIN).includes(`-d ${net} -j REJECT`), net);
    }
    assert.equal(
      iptables('iptables', '-S', 'OUTPUT').split('\n')[1],
      `-A OUTPUT -j ${EGRESS_CHAIN}`,
    );
    await run();
    assert.equal(iptables('iptables', '-S', EGRESS_CHAIN), rules);
  });

  it('puts back a rule that was taken out', async (t) => {
    if (!holder) return t.skip('no network namespace to try it in');
    await run();
    iptables('iptables', '-D', EGRESS_CHAIN, '-d', '10.0.0.0/8', '-j', 'REJECT');
    assert.ok(!iptables('iptables', '-S', EGRESS_CHAIN).includes('-d 10.0.0.0/8'));
    await run();
    assert.ok(iptables('iptables', '-S', EGRESS_CHAIN).includes('-d 10.0.0.0/8 -j REJECT'));
  });

  it('takes over from a rebuild that stopped after the old chain went, with a hook all the time', async (t) => {
    if (!holder) return t.skip('no network namespace to try it in');
    await run();
    // Stopped between deleting the old chain and renaming the new one: the only hook points at
    // the chain that has not been renamed yet.
    iptables('iptables', '-E', EGRESS_CHAIN, `${EGRESS_CHAIN}_NEW`);
    assert.equal(
      iptables('iptables', '-S', 'OUTPUT').split('\n')[1],
      `-A OUTPUT -j ${EGRESS_CHAIN}_NEW`,
    );
    await run();
    assert.equal(
      iptables('iptables', '-S', 'OUTPUT').split('\n')[1],
      `-A OUTPUT -j ${EGRESS_CHAIN}`,
    );
    assert.equal(
      iptables('iptables', '-S', 'OUTPUT')
        .split('\n')
        .filter((l) => l.startsWith('-A')).length,
      1,
    );
    assert.ok(!iptables('iptables', '-S').includes(`${EGRESS_CHAIN}_NEW`), 'no scratch chain left');
    assert.ok(iptables('iptables', '-S', EGRESS_CHAIN).includes('-d 169.254.0.0/16 -j REJECT'));
  });

  it('follows a name server that changed, and removes an exception nobody wrote', async (t) => {
    if (!holder) return t.skip('no network namespace to try it in');
    await run();
    await fs.writeFile(join(state, 'resolv.conf'), 'nameserver 10.0.0.99\nnameserver fd00::99\n');
    iptables('iptables', '-A', EGRESS_CHAIN, '-d', '10.1.2.3', '-j', 'ACCEPT');
    await run();
    const rules = iptables('iptables', '-S', EGRESS_CHAIN);
    assert.ok(rules.includes('-d 10.0.0.99/32 -p udp -m udp --dport 53 -j RETURN'), rules);
    assert.ok(!rules.includes('10.0.0.53') && !rules.includes('10.1.2.3'), rules);
    assert.ok(iptables('ip6tables', '-S', EGRESS_CHAIN).includes('-d fd00::99/128 -p udp'));
    assert.equal(
      iptables('iptables', '-S', 'OUTPUT').split('\n')[1],
      `-A OUTPUT -j ${EGRESS_CHAIN}`,
    );
    assert.ok(!iptables('iptables', '-S').includes(`${EGRESS_CHAIN}_NEW`), 'no scratch chain left');
  });

  it('does not keep a rule that lets traffic through, or rejects narrowed to one source', async (t) => {
    if (!holder) return t.skip('no network namespace to try it in');
    await run();
    const clean = iptables('iptables', '-S', EGRESS_CHAIN);
    iptables('iptables', '-I', EGRESS_CHAIN, '2', '-j', 'ACCEPT');
    await run();
    assert.equal(iptables('iptables', '-S', EGRESS_CHAIN), clean);
    for (const net of EGRESS_BLOCKED_V4) {
      iptables('iptables', '-D', EGRESS_CHAIN, '-d', net, '-j', 'REJECT');
      iptables('iptables', '-A', EGRESS_CHAIN, '-s', '192.0.2.7/32', '-d', net, '-j', 'REJECT');
    }
    assert.ok(iptables('iptables', '-S', EGRESS_CHAIN).includes('-s 192.0.2.7/32'));
    await run();
    assert.equal(iptables('iptables', '-S', EGRESS_CHAIN), clean);
  });

  it('lets the box connect to itself on loopback while a private address on the same interface stays refused', async (t) => {
    if (!holder) return t.skip('no network namespace to try it in');
    const ns = `--net=/proc/${holder.pid}/ns/net`;
    // lo is down in a fresh namespace. A private address the box owns sits on it: without the
    // guard a connection to it would succeed too.
    execFileSync('nsenter', [ns, 'python3', '-I', '-c', LO_SETUP]);
    await run();
    const rules = iptables('iptables', '-S', EGRESS_CHAIN);
    assert.ok(rules.includes(`-d ${EGRESS_LOOPBACK_V4} -o lo -j RETURN`), rules);
    assert.ok(
      iptables('ip6tables', '-S', EGRESS_CHAIN).includes(
        `-d ${EGRESS_LOOPBACK_V6} -o lo -j RETURN`,
      ),
    );
    const script = `
      const net = require('node:net');
      const reach = (host) => new Promise((resolve) => {
        const server = net.createServer((socket) => socket.end());
        server.on('error', () => resolve('unavailable'));
        server.listen(0, host, () => {
          const socket = net.connect(server.address().port, host);
          socket.on('connect', () => { socket.destroy(); server.close(); resolve('connected'); });
          socket.on('error', (error) => { server.close(); resolve(error.code); });
        });
      });
      (async () => {
        const out = {};
        for (const host of ['127.0.0.1', '::1', '10.9.9.9']) out[host] = await reach(host);
        console.log(JSON.stringify(out));
      })();
    `;
    const outcome = JSON.parse(
      execFileSync('nsenter', [ns, process.execPath, '-e', script]).toString(),
    ) as Record<string, string>;
    assert.equal(outcome['127.0.0.1'], 'connected');
    // A namespace without IPv6 has no ::1 to try.
    assert.ok(['connected', 'unavailable'].includes(outcome['::1'] ?? ''), JSON.stringify(outcome));
    assert.equal(outcome['10.9.9.9'], 'ECONNREFUSED', 'a private range is refused even on lo');
  });
});
