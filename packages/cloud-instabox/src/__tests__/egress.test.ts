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
  // The rules as `iptables -S` prints them, which is not the order or the form they were given in.
  const replies = `-A ${EGRESS_CHAIN} -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN`;
  const reject4 = (net: string) =>
    `-A ${EGRESS_CHAIN} -d ${net} -j REJECT --reject-with icmp-port-unreachable`;
  const reject6 = (net: string) =>
    `-A ${EGRESS_CHAIN} -d ${net} -j REJECT --reject-with icmp6-port-unreachable`;
  const ICMPV6_TYPE = {
    'neighbour-solicitation': 135,
    'neighbour-advertisement': 136,
    'router-solicitation': 133,
  } as const;

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
      `-A ${EGRESS_CHAIN} -d 127.0.0.53/32 -p udp -m udp --dport 53 -j RETURN`,
      `-A ${EGRESS_CHAIN} -d 127.0.0.53/32 -p tcp -m tcp --dport 53 -j RETURN`,
      ...EGRESS_BLOCKED_V4.map(reject4),
    ]);
    for (const net of ['169.254.0.0/16', '127.0.0.0/8', '10.0.0.0/8']) {
      assert.ok(v4().includes(reject4(net)), net);
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
      `-A ${EGRESS_CHAIN} -d fd00::53/128 -p udp -m udp --dport 53 -j RETURN`,
      `-A ${EGRESS_CHAIN} -d fd00::53/128 -p tcp -m tcp --dport 53 -j RETURN`,
      ...EGRESS_ICMPV6_ALLOWED.map(
        (kind) =>
          `-A ${EGRESS_CHAIN} -p ipv6-icmp -m icmp6 --icmpv6-type ${ICMPV6_TYPE[kind]} -j RETURN`,
      ),
      ...EGRESS_BLOCKED_V6.map(reject6),
    ]);
    for (const net of ['::1/128', 'fe80::/10', 'fc00::/7']) {
      assert.ok(v6().includes(reject6(net)), net);
    }
  });

  it('sees IPv6 through a procfs file, which reports size 0', async (t) => {
    if (process.platform !== 'linux') return t.skip('needs /proc');
    const stat = await fs.stat(PROCFS_WITH_CONTENT);
    assert.equal(stat.size, 0, 'the stand-in for procfs really has size 0');
    assert.ok((await fs.readFile(PROCFS_WITH_CONTENT, 'utf8')).length > 0);
    await make();
    await run(PROCFS_WITH_CONTENT);
    assert.ok(v6().includes(reject6('fc00::/7')));
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

  const isMutation = (call: string) => /(^| )-(N|F|A|I|D|X|E) /u.test(call);
  const live = (calls: string[]) => calls.filter((call) => !call.includes(`${EGRESS_CHAIN}_NEW`));

  it('leaves the live chain and its hook alone when the policy is already in place', async () => {
    await make();
    await run();
    const before = h.fake.firewall.calls().length;
    await run();
    const second = h.fake.firewall.calls().slice(before);
    assert.deepEqual(live(second).filter(isMutation), [], 'only the scratch chain was touched');
  });

  it('follows a name server that changed, and drops the exception for the old one', async () => {
    await make();
    await run();
    await fs.writeFile(resolv, 'nameserver 10.0.0.53\nsearch example\n');
    await run();
    const rules = v4();
    assert.ok(
      rules.includes(`-A ${EGRESS_CHAIN} -d 10.0.0.53/32 -p udp -m udp --dport 53 -j RETURN`),
    );
    assert.ok(!rules.some((rule) => rule.includes('127.0.0.53')), 'the old exception is gone');
    const firstReject = rules.findIndex((rule) => rule.includes('-j REJECT'));
    assert.ok(rules.findIndex((rule) => rule.includes('10.0.0.53')) < firstReject);
  });

  it('puts the policy back when a rule was added or lost', async () => {
    await make();
    await run();
    await h.client.exec(h.fake.machineId, {
      cmd: `iptables -w -A ${EGRESS_CHAIN} -d 10.1.2.3 -j ACCEPT`,
    });
    assert.ok(v4().some((rule) => rule.includes('10.1.2.3')));
    await run();
    assert.ok(
      !v4().some((rule) => rule.includes('10.1.2.3')),
      'an exception nobody wrote is removed',
    );
  });

  it('never takes the hook away before the new chain has one', async () => {
    await make();
    await run();
    await fs.writeFile(resolv, 'nameserver 10.0.0.54\n');
    const before = h.fake.firewall.calls().length;
    await run();
    const calls = h.fake.firewall
      .calls()
      .slice(before)
      .filter((call) => call.includes('OUTPUT'));
    const hookNew = calls.findIndex((call) => call.includes(`-I OUTPUT 1 -j ${EGRESS_CHAIN}_NEW`));
    const unhookOld = calls.findIndex((call) => call.includes(`-D OUTPUT -j ${EGRESS_CHAIN}`));
    assert.ok(hookNew >= 0 && unhookOld > hookNew, `${calls.join(' | ')}`);
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
    await assert.rejects(run(), /cannot hook MAKA_EGRESS_NEW into OUTPUT/u);
  });

  it('refuses when the rules read back are not the ones it wrote', async () => {
    await make({ env: { SHIM_LIE: '1' } });
    await assert.rejects(run(), /cannot read MAKA_EGRESS_NEW back/u);
  });

  it('refuses when the IPv6 half fails on a box that has IPv6', async () => {
    await make({ env: { SHIM_FAIL: 'fc00::/7' } });
    await assert.rejects(run(), /ip6tables: cannot block fc00::\/7/u);
  });
});
