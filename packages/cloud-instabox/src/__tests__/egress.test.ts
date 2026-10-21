import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { applyEgressGuard, EGRESS_BLOCKED_V4, EGRESS_CHAIN, EgressGuardError } from '../egress.js';
import { setup, type Harness } from './harness.js';

/**
 * A stand-in for iptables and ip6tables that keeps the rules in files under SHIM_STATE and
 * understands the few forms the guard uses. `SHIM_FAIL` is a pattern: a call whose arguments match
 * it fails. `SHIM_LIE` makes `-S` print nothing, as if the rules had not stuck.
 */
const SHIM = `#!/bin/bash
tool=$(basename "$0")
echo "$tool $*" >> "$SHIM_STATE/log"
if [ -n "\${SHIM_FAIL:-}" ] && [[ "$*" =~ $SHIM_FAIL ]]; then exit 3; fi
[ "$1" = -w ] && shift
op="$1"; shift
rules() { echo "$SHIM_STATE/$tool.$1"; }
case "$op" in
  -N) [ -e "$(rules "$1")" ] && exit 1; : > "$(rules "$1")" ;;
  -F) : > "$(rules "$1")" ;;
  -A) chain="$1"; shift; echo "-A $chain $*" >> "$(rules "$chain")" ;;
  -I) chain="$1"; shift 2; { echo "-A $chain $*"; cat "$(rules "$chain")" 2>/dev/null; true; } > "$SHIM_STATE/tmp" \\
        && mv "$SHIM_STATE/tmp" "$(rules "$chain")" ;;
  -C) chain="$1"; shift; grep -Fxq -- "-A $chain $*" "$(rules "$chain")" 2>/dev/null ;;
  -S) [ -n "\${SHIM_LIE:-}" ] && exit 0; echo "-P $1 ACCEPT"; cat "$(rules "$1")" 2>/dev/null ;;
  *) exit 2 ;;
esac
`;

describe('applyEgressGuard', () => {
  let h: Harness;
  let state: string;
  let resolv: string;
  let inet6: string;

  const make = async (
    extraEnv: Record<string, string> = {},
    tools: string[] = ['iptables', 'ip6tables', 'sudo'],
  ) => {
    const bin = join(state, 'bin');
    await fs.mkdir(bin, { recursive: true });
    for (const tool of tools) {
      await fs.writeFile(
        join(bin, tool),
        tool === 'sudo' ? '#!/bin/bash\n[ "$1" = -n ] && shift\nexec "$@"\n' : SHIM,
        {
          mode: 0o755,
        },
      );
    }
    h = await setup({
      execPath: `${bin}:/usr/bin:/bin`,
      env: { SHIM_STATE: state, ...extraEnv },
    });
  };
  const run = () =>
    applyEgressGuard(h.client, h.fake.machineId, { resolvConf: resolv, ifInet6: inet6 });
  const read = async (name: string) => await fs.readFile(join(state, name), 'utf8').catch(() => '');

  beforeEach(async () => {
    state = await fs.mkdtemp(join(tmpdir(), 'egress-test-'));
    resolv = join(state, 'resolv.conf');
    inet6 = join(state, 'if_inet6');
    await fs.writeFile(resolv, 'nameserver 10.0.2.3\nnameserver fd00::53\nsearch example\n');
    await fs.writeFile(inet6, 'fe80000000000000 02 40 20 80 eth0\n');
  });
  afterEach(async () => {
    await h?.cleanup();
    await fs.rm(state, { recursive: true, force: true });
  });

  it('blocks the metadata address and the private ranges, replies and name servers first', async () => {
    await make();
    await run();
    const v4 = (await read('iptables.MAKA_EGRESS')).trim().split('\n');
    assert.deepEqual(v4, [
      `-A ${EGRESS_CHAIN} -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN`,
      `-A ${EGRESS_CHAIN} -d 10.0.2.3 -p udp --dport 53 -j RETURN`,
      `-A ${EGRESS_CHAIN} -d 10.0.2.3 -p tcp --dport 53 -j RETURN`,
      ...EGRESS_BLOCKED_V4.map((net) => `-A ${EGRESS_CHAIN} -d ${net} -j REJECT`),
    ]);
    assert.ok(v4.includes(`-A ${EGRESS_CHAIN} -d 169.254.0.0/16 -j REJECT`));
    assert.equal((await read('iptables.OUTPUT')).trim(), `-A OUTPUT -j ${EGRESS_CHAIN}`);
    const v6 = (await read('ip6tables.MAKA_EGRESS')).trim().split('\n');
    assert.deepEqual(v6, [
      `-A ${EGRESS_CHAIN} -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN`,
      `-A ${EGRESS_CHAIN} -d fd00::53 -p udp --dport 53 -j RETURN`,
      `-A ${EGRESS_CHAIN} -d fd00::53 -p tcp --dport 53 -j RETURN`,
      `-A ${EGRESS_CHAIN} -d fc00::/7 -j REJECT`,
    ]);
  });

  it('leaves one copy of every rule when it runs twice', async () => {
    await make();
    await run();
    const first = await read('iptables.MAKA_EGRESS');
    await run();
    assert.equal(await read('iptables.MAKA_EGRESS'), first);
    assert.equal((await read('iptables.OUTPUT')).trim().split('\n').length, 1);
  });

  it('does not touch IPv6 on a box without it', async () => {
    await make();
    await fs.writeFile(inet6, '');
    await run();
    assert.equal(await read('ip6tables.MAKA_EGRESS'), '');
    assert.doesNotMatch(await read('log'), /ip6tables/u);
  });

  it('refuses when there is no firewall tool', async () => {
    await make({}, ['sudo']);
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof EgressGuardError);
      assert.match(error.message, /iptables is not installed/u);
      return true;
    });
  });

  it('refuses when a rule cannot be added, and says which', async () => {
    await make({ SHIM_FAIL: '169\\.254\\.0\\.0/16' });
    await assert.rejects(run(), /cannot block 169\.254\.0\.0\/16/u);
  });

  it('refuses when the hook cannot be installed', async () => {
    await make({ SHIM_FAIL: '-I OUTPUT' });
    await assert.rejects(run(), /cannot hook MAKA_EGRESS into OUTPUT/u);
  });

  it('refuses when the rules read back are not the ones it wrote', async () => {
    await make({ SHIM_LIE: '1' });
    await assert.rejects(run(), /is not the first OUTPUT rule/u);
  });

  it('refuses when the IPv6 half fails on a box that has IPv6', async () => {
    await make({ SHIM_FAIL: 'fc00::/7' });
    await assert.rejects(run(), /ip6tables: cannot block fc00::\/7/u);
  });
});
