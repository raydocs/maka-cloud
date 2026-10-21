import type { InstaboxClient } from './client.js';
import { newMarker, parseFramed } from './scripts.js';

/**
 * What a box may not reach. The cloud metadata address (169.254.169.254) answers with the host's
 * credentials, the private ranges are the host's own network, and loopback is where the sandbox's
 * own services listen (the agent runs as a user of the machine, not in a box of its own). Replies,
 * the box's name servers and IPv6 neighbour discovery are let through first; nothing else is.
 * A program that serves itself on loopback (a dev server, a test that binds a port) cannot reach
 * it either, until an explicit exception is made.
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
# Whether the rules are already in place: the reply rule opens the chain, the chain is the first
# OUTPUT rule and every net is blocked. Sets WHY when not.
verify() {
  tool="$1"; shift
  first=$(as_root "$tool" -w -S OUTPUT 2>/dev/null | awk '$1 == "-A" { print $0; exit }')
  [ "$first" = "-A OUTPUT -j $MAKA_CHAIN" ] || { WHY="$MAKA_CHAIN is not the first OUTPUT rule"; return 1; }
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
}
guard() {
  tool="$1"; shift
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed"
  # Rules that are already right are left alone: rebuilding the chain opens a gap for the tasks
  # that are running in the box.
  verify "$tool" "$@" && return 0
  as_root "$tool" -w -N "$MAKA_CHAIN" 2>/dev/null
  as_root "$tool" -w -F "$MAKA_CHAIN" || fail "$tool: cannot reset $MAKA_CHAIN (needs root or sudo -n)"
  as_root "$tool" -w -A "$MAKA_CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN \\
    || fail "$tool: cannot add the reply rule"
  for ns in $(awk '$1 == "nameserver" { print $2 }' "$MAKA_RESOLV_CONF" 2>/dev/null); do
    case "$ns" in *:*) fam=6 ;; *) fam=4 ;; esac
    [ "$fam" = "$FAMILY" ] || continue
    for proto in udp tcp; do
      as_root "$tool" -w -A "$MAKA_CHAIN" -d "$ns" -p "$proto" --dport 53 -j RETURN \\
        || fail "$tool: cannot add the name server rule"
    done
  done
  if [ "$FAMILY" = 6 ]; then
    for kind in $MAKA_ICMPV6; do
      as_root "$tool" -w -A "$MAKA_CHAIN" -p ipv6-icmp --icmpv6-type "$kind" -j RETURN \\
        || fail "$tool: cannot add the $kind rule"
    done
  fi
  for net in "$@"; do
    as_root "$tool" -w -A "$MAKA_CHAIN" -d "$net" -j REJECT || fail "$tool: cannot block $net"
  done
  as_root "$tool" -w -C OUTPUT -j "$MAKA_CHAIN" 2>/dev/null \\
    || as_root "$tool" -w -I OUTPUT 1 -j "$MAKA_CHAIN" || fail "$tool: cannot hook $MAKA_CHAIN into OUTPUT"
  # Read it back.
  verify "$tool" "$@" || fail "$tool: $WHY"
}
# Several server processes can guard the same box at once; one at a time, so that no one reads
# back the rules while another is refilling them.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$MAKA_LOCK"
  flock -w 30 9 || fail "cannot take $MAKA_LOCK"
fi
FAMILY=4 guard iptables $MAKA_V4
# procfs files report size 0, so [ -s ] cannot tell: read the content.
if [ -n "$(cat "$MAKA_IF_INET6" 2>/dev/null)" ]; then FAMILY=6 guard ip6tables $MAKA_V6; fi
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
