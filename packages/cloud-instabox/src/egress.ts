import type { InstaboxClient } from './client.js';
import { newMarker, parseFramed } from './scripts.js';

/**
 * What a box may not reach. The cloud metadata address (169.254.169.254) answers with the host's
 * credentials, and the private ranges are the host's own network. Loopback stays open: the box's
 * own tools talk to each other over it.
 */
export const EGRESS_BLOCKED_V4 = [
  '169.254.0.0/16',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
] as const;

/** Unique local addresses, where IPv6 metadata services live (AWS: fd00:ec2::254). */
export const EGRESS_BLOCKED_V6 = ['fc00::/7'] as const;

export const EGRESS_CHAIN = 'MAKA_EGRESS';

const HELPER_TIMEOUT_SECONDS = 60;

/**
 * Installs the egress rules in a box and checks that they are there. Parameters travel in `envs`.
 *
 * - One chain of our own, flushed and refilled on every run, so running it twice leaves one copy.
 * - Replies to connections the box did not start (the instabox control plane reaching in) and the
 *   box's own name servers are let through first; without them the box would cut itself off.
 * - Anything it cannot do is an error, never a skipped rule: the box is not used unguarded.
 * - IPv6 is guarded only when the box has IPv6 at all.
 */
export const EGRESS_GUARD_SCRIPT = `
M="$MAKA_M"
fail() { printf '%s' "$M"; printf 'ERR\\0%s\\0' "$1"; printf '%s' "$M"; exit 0; }
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }
guard() {
  tool="$1"; shift
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed"
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
  for net in "$@"; do
    as_root "$tool" -w -A "$MAKA_CHAIN" -d "$net" -j REJECT || fail "$tool: cannot block $net"
  done
  as_root "$tool" -w -C OUTPUT -j "$MAKA_CHAIN" 2>/dev/null \\
    || as_root "$tool" -w -I OUTPUT 1 -j "$MAKA_CHAIN" || fail "$tool: cannot hook $MAKA_CHAIN into OUTPUT"
  # Read it back: the hook is the first OUTPUT rule and every net is blocked.
  first=$(as_root "$tool" -w -S OUTPUT | awk '$1 == "-A" { print $0; exit }')
  [ "$first" = "-A OUTPUT -j $MAKA_CHAIN" ] || fail "$tool: $MAKA_CHAIN is not the first OUTPUT rule"
  listed=$(as_root "$tool" -w -S "$MAKA_CHAIN") || fail "$tool: cannot read $MAKA_CHAIN back"
  for net in "$@"; do
    printf '%s\\n' "$listed" | grep -Fq -- "-d $net -j REJECT" || fail "$tool: $net is not blocked"
  done
}
FAMILY=4 guard iptables $MAKA_V4
if [ -e "$MAKA_IF_INET6" ] && [ -s "$MAKA_IF_INET6" ]; then FAMILY=6 guard ip6tables $MAKA_V6; fi
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
  /** The file that is non-empty when the box has IPv6. Tests point it elsewhere. */
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
