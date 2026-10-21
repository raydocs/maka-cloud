import type { InstaboxClient } from './client.js';
import { newMarker, parseFramed } from './scripts.js';

/**
 * What a box may not reach. The cloud metadata address (169.254.169.254) answers with the host's
 * credentials, the private ranges are the host's own network. Replies, the box's name servers and
 * IPv6 neighbour discovery are let through first, and so is the box talking to itself (a dev
 * server, a test that binds a port): 127/8 and ::1, out of the loopback interface only. Anything
 * else addressed to those ranges, and every other blocked range, is refused.
 */
export const EGRESS_BLOCKED_V4 = [
  '169.254.0.0/16',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '127.0.0.0/8',
] as const;

/** Unique local addresses (AWS keeps its IPv6 metadata service at fd00:ec2::254), link local and loopback. */
export const EGRESS_BLOCKED_V6 = ['fc00::/7', 'fe80::/10', '::1/128'] as const;

/** ICMPv6 that IPv6 itself needs to find the router and its neighbours: all link-local, all allowed. */
export const EGRESS_ICMPV6_ALLOWED = [
  'neighbour-solicitation',
  'neighbour-advertisement',
  'router-solicitation',
] as const;

/** What the box may reach on itself, through the loopback interface (the owner's decision, 2026-10-21). */
export const EGRESS_LOOPBACK_V4 = '127.0.0.0/8';
export const EGRESS_LOOPBACK_V6 = '::1/128';

export const EGRESS_CHAIN = 'MAKA_EGRESS';

/** Held while the rules are checked or rebuilt, so that two callers on one box do not trip over each other. */
const EGRESS_LOCK = '/tmp/.maka-egress.lock';

const HELPER_TIMEOUT_SECONDS = 60;

/**
 * Installs the egress rules in a box and checks that they are there. Parameters travel in `envs`.
 *
 * - One chain of our own. Rules that read back right are left alone, so running it again changes
 *   nothing and opens no gap; otherwise the chain is flushed and refilled, never added to.
 * - Replies to connections the box did not start (the instabox control plane reaching in), the
 *   box's own name servers and, for IPv6, neighbour discovery are let through first; without them
 *   the box would cut itself off.
 * - Anything it cannot do is an error, never a skipped rule: the box is not used unguarded.
 * - IPv6 is guarded only when the box has IPv6 at all.
 */
export const EGRESS_GUARD_SCRIPT = `
M="$MAKA_M"
fail() { printf '%s' "$M"; printf 'ERR\\0%s\\0' "$1"; printf '%s' "$M"; exit 0; }
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }
# What the tool prints for a chain, with the chain's own name made generic so that two chains with
# the same rules print the same.
render() {
  as_root "$tool" -w -S "$1" 2>/dev/null | awk -v c="$1" '{ for (i = 1; i <= NF; i++) if ($i == c) $i = "CHAIN"; print }'
}
first_output_rule() {
  as_root "$tool" -w -S OUTPUT 2>/dev/null | awk '$1 == "-A" { print $0; exit }'
}
# Fills a chain with the policy: replies, this box's name servers (now), neighbour discovery, then
# the blocked nets.
build() {
  chain="$1"; shift
  as_root "$tool" -w -N "$chain" 2>/dev/null
  as_root "$tool" -w -F "$chain" || fail "$tool: cannot reset $chain (needs root or sudo -n)"
  as_root "$tool" -w -A "$chain" -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN \\
    || fail "$tool: cannot add the reply rule"
  for ns in $(awk '$1 == "nameserver" { print $2 }' "$MAKA_RESOLV_CONF" 2>/dev/null); do
    case "$ns" in *:*) fam=6 ;; *) fam=4 ;; esac
    [ "$fam" = "$FAMILY" ] || continue
    for proto in udp tcp; do
      as_root "$tool" -w -A "$chain" -d "$ns" -p "$proto" --dport 53 -j RETURN \\
        || fail "$tool: cannot add the name server rule"
    done
  done
  if [ "$FAMILY" = 6 ]; then
    for kind in $MAKA_ICMPV6; do
      as_root "$tool" -w -A "$chain" -p ipv6-icmp --icmpv6-type "$kind" -j RETURN \\
        || fail "$tool: cannot add the $kind rule"
    done
  fi
  # The box talking to itself, through the loopback interface and nowhere else.
  as_root "$tool" -w -A "$chain" -d "$LOOPBACK" -o lo -j RETURN \\
    || fail "$tool: cannot add the loopback rule"
  for net in "$@"; do
    as_root "$tool" -w -A "$chain" -d "$net" -j REJECT || fail "$tool: cannot block $net"
  done
}
# Whatever the rules say, the chain must open with the reply rule and reject every net. Sets WHY.
sane() {
  listed=$(as_root "$tool" -w -S "$MAKA_CHAIN" 2>/dev/null) || { WHY="cannot read $MAKA_CHAIN back"; return 1; }
  opener=$(printf '%s\\n' "$listed" | awk '$1 == "-A" { print $0; exit }')
  # iptables prints the states in its own order (RELATED,ESTABLISHED), whatever order they were given in.
  case "$opener" in
    "-A $MAKA_CHAIN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN" | "-A $MAKA_CHAIN -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN") ;;
    *) WHY="$MAKA_CHAIN does not open with the reply rule"; return 1 ;;
  esac
  for net in "$@"; do
    printf '%s\\n' "$listed" | grep -Fq -- "-d $net -j REJECT" || { WHY="$net is not blocked"; return 1; }
  done
  # The one exception to loopback, exactly: out of lo only, and before the reject of that range.
  pass=$(printf '%s\\n' "$listed" | awk -v n="-A $MAKA_CHAIN -d $LOOPBACK -o lo -j RETURN" '$0 == n { print NR; exit }')
  stop=$(printf '%s\\n' "$listed" | awk -v n="-A $MAKA_CHAIN -d $LOOPBACK -j REJECT" 'index($0, n) == 1 { print NR; exit }')
  [ -n "$pass" ] || { WHY="loopback is not allowed to the box itself"; return 1; }
  [ -n "$stop" ] && [ "$pass" -lt "$stop" ] || { WHY="loopback is not refused from anything but lo"; return 1; }
}
unhook() {
  n=0
  while [ "$n" -lt 20 ] && as_root "$tool" -w -C OUTPUT -j "$1" 2>/dev/null; do
    as_root "$tool" -w -D OUTPUT -j "$1" || fail "$tool: cannot unhook $1"
    n=$((n + 1))
  done
}
guard() {
  tool="$1"; shift
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed"
  # The policy as it should be now is built in a chain nothing uses, and the live chain is compared
  # with it as the tool prints both: a name server that changed (a box restored elsewhere) or a rule
  # added or lost shows as a difference, whatever the order or form the tool prints.
  next="$MAKA_CHAIN"_NEW
  unhook "$next"
  build "$next" "$@"
  want=$(render "$next")
  [ -n "$want" ] || fail "$tool: cannot read $next back"
  have=$(render "$MAKA_CHAIN")
  if [ "$(first_output_rule)" = "-A OUTPUT -j $MAKA_CHAIN" ] && [ "$have" = "$want" ] && sane "$@"; then
    # Right already: nothing live is touched, so no gap opens for the tasks running in the box.
    as_root "$tool" -w -F "$next"; as_root "$tool" -w -X "$next"
    return 0
  fi
  # Otherwise the new chain takes over before the old one goes: the box is never without a hook.
  as_root "$tool" -w -I OUTPUT 1 -j "$next" || fail "$tool: cannot hook $next into OUTPUT"
  unhook "$MAKA_CHAIN"
  as_root "$tool" -w -F "$MAKA_CHAIN" 2>/dev/null
  as_root "$tool" -w -X "$MAKA_CHAIN" 2>/dev/null
  as_root "$tool" -w -E "$next" "$MAKA_CHAIN" || fail "$tool: cannot put $MAKA_CHAIN in place"
  [ "$(first_output_rule)" = "-A OUTPUT -j $MAKA_CHAIN" ] || fail "$tool: $MAKA_CHAIN is not the first OUTPUT rule"
  [ "$(render "$MAKA_CHAIN")" = "$want" ] || fail "$tool: $MAKA_CHAIN does not read back as written"
  sane "$@" || fail "$tool: $WHY"
}
# Several server processes can guard the same box at once; one at a time, so that no one reads
# back the rules while another is refilling them.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$MAKA_LOCK"
  flock -w 30 9 || fail "cannot take $MAKA_LOCK"
fi
FAMILY=4 LOOPBACK="$MAKA_LO4" guard iptables $MAKA_V4
# procfs files report size 0, so [ -s ] cannot tell: read the content.
if [ -n "$(cat "$MAKA_IF_INET6" 2>/dev/null)" ]; then FAMILY=6 LOOPBACK="$MAKA_LO6" guard ip6tables $MAKA_V6; fi
printf '%s' "$M"; printf 'OK\\0'; printf '%s' "$M"
`;

export class EgressGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EgressGuardError';
  }
}

export interface EgressGuardOptions {
  /** Where the box lists its name servers. Tests point it elsewhere. */
  resolvConf?: string;
  /** The file whose content is empty when the box has no IPv6. Tests point it elsewhere. */
  ifInet6?: string;
  signal?: AbortSignal;
}

/**
 * Blocks the box's egress to link-local (the cloud metadata address) and private ranges, then
 * reads the rules back. It throws when it cannot: the caller must not start a task in a box that
 * did not pass. Whether instabox lets the sandbox's user change firewall rules at all is not known
 * until `egress.live.test.ts` has run against a real sandbox.
 */
export async function applyEgressGuard(
  client: InstaboxClient,
  machineId: string,
  options: EgressGuardOptions = {},
): Promise<void> {
  const marker = newMarker();
  const result = await client.exec(
    machineId,
    {
      cmd: EGRESS_GUARD_SCRIPT,
      timeoutSeconds: HELPER_TIMEOUT_SECONDS,
      envs: {
        MAKA_M: marker,
        MAKA_CHAIN: EGRESS_CHAIN,
        MAKA_V4: EGRESS_BLOCKED_V4.join(' '),
        MAKA_V6: EGRESS_BLOCKED_V6.join(' '),
        MAKA_ICMPV6: EGRESS_ICMPV6_ALLOWED.join(' '),
        MAKA_LO4: EGRESS_LOOPBACK_V4,
        MAKA_LO6: EGRESS_LOOPBACK_V6,
        MAKA_LOCK: EGRESS_LOCK,
        MAKA_RESOLV_CONF: options.resolvConf ?? '/etc/resolv.conf',
        MAKA_IF_INET6: options.ifInet6 ?? '/proc/net/if_inet6',
      },
    },
    options.signal ? { signal: options.signal } : {},
  );
  const fields = parseFramed(result.stdout, marker);
  if (!fields || result.timedOut) {
    throw new EgressGuardError(
      `the egress guard did not finish (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''})`,
    );
  }
  if (fields[0] !== 'OK') {
    throw new EgressGuardError(`the egress guard was refused: ${fields[1] ?? 'unknown reason'}`);
  }
}
