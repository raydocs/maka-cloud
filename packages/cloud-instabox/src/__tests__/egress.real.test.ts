import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { applyEgressGuard, EGRESS_BLOCKED_V4, EGRESS_BLOCKED_V6, EGRESS_CHAIN } from '../egress.js';
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
});
