import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  applyEgressGuard,
  EGRESS_BLOCKED_V4,
  EGRESS_BLOCKED_V6,
  EGRESS_CHAIN,
  EGRESS_ICMPV6_ALLOWED,
  EgressGuardError,
} from '../egress.js';
import { type FakeInstaboxOptions, isAlive } from './fake-instabox.js';
import { setup, type Harness } from './harness.js';

/** procfs reports every file with size 0 and has content: what /proc/net/if_inet6 looks like. */
const PROCFS_WITH_CONTENT = '/proc/version';

describe('applyEgressGuard', () => {
  let h: Harness;
  let state: string;
  let resolv: string;
  let inet6: string;

  const make = async (options: FakeInstaboxOptions = {}) => {
    h = await setup(options);
  };
  const run = (ifInet6 = inet6) =>
    applyEgressGuard(h.client, h.fake.machineId, { resolvConf: resolv, ifInet6 });
  const v4 = () => h.fake.firewall.rules('iptables', EGRESS_CHAIN);
  const v6 = () => h.fake.firewall.rules('ip6tables', EGRESS_CHAIN);
  const replies = `-A ${EGRESS_CHAIN} -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN`;

  beforeEach(async () => {
    state = await fs.mkdtemp(join(tmpdir(), 'egress-test-'));
    resolv = join(state, 'resolv.conf');
    inet6 = join(state, 'if_inet6');
    await fs.writeFile(resolv, 'nameserver 127.0.0.53\nnameserver fd00::53\nsearch example\n');
    await fs.writeFile(inet6, 'fe80000000000000 02 40 20 80 eth0\n');
  });
  afterEach(async () => {
    await h?.cleanup();
    await fs.rm(state, { recursive: true, force: true });
  });

  it('blocks metadata, private and loopback ranges; replies and name servers come first', async () => {
    await make();
    await run();
    assert.deepEqual(v4(), [
      replies,
      `-A ${EGRESS_CHAIN} -d 127.0.0.53 -p udp --dport 53 -j RETURN`,
      `-A ${EGRESS_CHAIN} -d 127.0.0.53 -p tcp --dport 53 -j RETURN`,
      ...EGRESS_BLOCKED_V4.map((net) => `-A ${EGRESS_CHAIN} -d ${net} -j REJECT`),
    ]);
    for (const net of ['169.254.0.0/16', '127.0.0.0/8', '10.0.0.0/8']) {
      assert.ok(v4().includes(`-A ${EGRESS_CHAIN} -d ${net} -j REJECT`), net);
    }
    assert.equal(
      h.fake.firewall.rules('iptables', 'OUTPUT').join('\n'),
      `-A OUTPUT -j ${EGRESS_CHAIN}`,
    );
  });

  it('blocks IPv6 loopback, link-local and unique-local, with neighbour discovery let through', async () => {
    await make();
    await run();
    assert.deepEqual(v6(), [
      replies,
      `-A ${EGRESS_CHAIN} -d fd00::53 -p udp --dport 53 -j RETURN`,
      `-A ${EGRESS_CHAIN} -d fd00::53 -p tcp --dport 53 -j RETURN`,
      ...EGRESS_ICMPV6_ALLOWED.map(
        (kind) => `-A ${EGRESS_CHAIN} -p ipv6-icmp --icmpv6-type ${kind} -j RETURN`,
      ),
      ...EGRESS_BLOCKED_V6.map((net) => `-A ${EGRESS_CHAIN} -d ${net} -j REJECT`),
    ]);
    for (const net of ['::1/128', 'fe80::/10', 'fc00::/7']) {
      assert.ok(v6().includes(`-A ${EGRESS_CHAIN} -d ${net} -j REJECT`), net);
    }
  });

  it('sees IPv6 through a procfs file, which reports size 0', async (t) => {
    if (process.platform !== 'linux') return t.skip('needs /proc');
    const stat = await fs.stat(PROCFS_WITH_CONTENT);
    assert.equal(stat.size, 0, 'the stand-in for procfs really has size 0');
    assert.ok((await fs.readFile(PROCFS_WITH_CONTENT, 'utf8')).length > 0);
    await make();
    await run(PROCFS_WITH_CONTENT);
    assert.ok(v6().includes(`-A ${EGRESS_CHAIN} -d fc00::/7 -j REJECT`));
  });

  it('leaves one copy of every rule when it runs twice', async () => {
    await make();
    await run();
    const first = v4();
    await run();
    assert.deepEqual(v4(), first);
    assert.equal(h.fake.firewall.rules('iptables', 'OUTPUT').length, 1);
  });

  it('does not touch IPv6 on a box without it', async () => {
    await make();
    await fs.writeFile(inet6, '');
    await run();
    assert.deepEqual(v6(), []);
    assert.doesNotMatch(h.fake.firewall.calls().join('\n'), /ip6tables/u);
  });

  it('lets several callers guard one box at once, each reading back what it needs', async () => {
    await make();
    for (let round = 0; round < 5; round++) {
      h.fake.firewall.reset();
      await Promise.all([run(), run(), run(), run()]);
      assert.equal(v4().filter((rule) => rule === replies).length, 1);
    }
  });

  it('stops a command still running when the fake closes, before its stand-ins are removed', async () => {
    await make();
    const pending = h.client.exec(h.fake.machineId, { cmd: 'sleep 30' }).catch(() => undefined);
    while (h.fake.spawnedPids.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const pid = h.fake.spawnedPids[0] as number;
    assert.ok(isAlive(pid));
    await h.fake.close();
    assert.equal(isAlive(pid), false, 'a late command would reach the real firewall');
    await pending;
  });

  it('keeps the stand-ins in front when a test sets its own PATH', async () => {
    await make({ env: { PATH: '/usr/sbin:/usr/bin:/bin' } });
    await run();
    assert.ok(v4().length > 0, 'the rules went to the stand-in, not to the real firewall');
  });

  it('refuses when there is no firewall tool', async () => {
    await make({ firewall: 'none', execPath: '/usr/bin:/bin' });
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof EgressGuardError);
      assert.match(error.message, /iptables is not installed/u);
      return true;
    });
  });

  it('refuses when a rule cannot be added, and says which', async () => {
    await make({ env: { SHIM_FAIL: '169\\.254\\.0\\.0/16' } });
    await assert.rejects(run(), /cannot block 169\.254\.0\.0\/16/u);
  });

  it('refuses when loopback cannot be blocked', async () => {
    await make({ env: { SHIM_FAIL: '127\\.0\\.0\\.0/8' } });
    await assert.rejects(run(), /cannot block 127\.0\.0\.0\/8/u);
  });

  it('refuses when the hook cannot be installed', async () => {
    await make({ env: { SHIM_FAIL: '-I OUTPUT' } });
    await assert.rejects(run(), /cannot hook MAKA_EGRESS into OUTPUT/u);
  });

  it('refuses when the rules read back are not the ones it wrote', async () => {
    await make({ env: { SHIM_LIE: '1' } });
    await assert.rejects(run(), /is not the first OUTPUT rule/u);
  });

  it('refuses when the IPv6 half fails on a box that has IPv6', async () => {
    await make({ env: { SHIM_FAIL: 'fc00::/7' } });
    await assert.rejects(run(), /ip6tables: cannot block fc00::\/7/u);
  });
});
