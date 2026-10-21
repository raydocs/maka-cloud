import { isIP } from 'node:net';

/**
 * Whether an IP address is one a server may connect to on a stranger's say-so. It is an allowlist
 * for IPv6 (global unicast only) and a denylist of every special-purpose range for IPv4, and
 * anything it cannot read is refused. An address with an IPv4 address inside it (mapped, NAT64,
 * 6to4) is judged by the address that would be reached, or refused.
 */
const V4_BLOCKED: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
];

function v4Bytes(address: string): number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/u.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    bytes.push(value);
  }
  return bytes;
}

function v4Number(bytes: readonly number[]): number {
  return (
    ((bytes[0] ?? 0) * 0x1000000 +
      ((bytes[1] ?? 0) << 16) +
      ((bytes[2] ?? 0) << 8) +
      (bytes[3] ?? 0)) >>>
    0
  );
}

const V4_RANGES = V4_BLOCKED.map(([net, bits]) => ({
  prefix: v4Number(v4Bytes(net) ?? []),
  shift: 32 - bits,
}));

function v4Public(bytes: readonly number[]): boolean {
  const value = v4Number(bytes);
  return !V4_RANGES.some(
    ({ prefix, shift }) => Math.floor(value / 2 ** shift) === Math.floor(prefix / 2 ** shift),
  );
}

/** The 16 bytes of an IPv6 address, or nothing for text that is not exactly one (a zone id is refused). */
function v6Bytes(address: string): number[] | undefined {
  if (address.includes('%')) return undefined;
  let text = address.toLowerCase();
  let tail: number[] = [];
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/u.exec(text);
  if (dotted) {
    const v4 = v4Bytes(dotted[2] ?? '');
    if (!v4) return undefined;
    tail = v4;
    text = `${dotted[1] ?? ''}0:0`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const groups = (part: string): number[] | undefined => {
    if (part === '') return [];
    const out: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/u.test(group)) return undefined;
      const value = Number.parseInt(group, 16);
      out.push(value >> 8, value & 0xff);
    }
    return out;
  };
  const head = groups(halves[0] ?? '');
  const rest = halves.length === 2 ? groups(halves[1] ?? '') : [];
  if (!head || !rest) return undefined;
  let bytes: number[];
  if (halves.length === 2) {
    const fill = 16 - head.length - rest.length;
    if (fill < 2) return undefined;
    bytes = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    bytes = head;
  }
  if (bytes.length !== 16) return undefined;
  if (tail.length === 4) {
    // The dotted tail was swapped for two zero groups above: put the real bytes back.
    bytes.splice(12, 4, ...tail);
  }
  return bytes;
}

function startsWith(bytes: readonly number[], prefix: readonly number[], bits: number): boolean {
  for (let i = 0; i < bits; i += 1) {
    const byte = Math.floor(i / 8);
    const mask = 0x80 >> (i % 8);
    const want = ((prefix[byte] ?? 0) & mask) !== 0;
    const have = ((bytes[byte] ?? 0) & mask) !== 0;
    if (want !== have) return false;
  }
  return true;
}

function v6Public(bytes: readonly number[]): boolean {
  // ::ffff:a.b.c.d (and its hex spelling) is the IPv4 address inside it.
  if (startsWith(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96))
    return v4Public(bytes.slice(12));
  // Only global unicast, 2000::/3, is ever a public peer; the rest (NAT64, loopback, unique local,
  // link local, multicast, deprecated compatible and site-local forms) is refused.
  if (!startsWith(bytes, [0x20], 3)) return false;
  for (const [prefix, bits] of [
    [[0x20, 0x01, 0x00, 0x00], 23], // IETF protocol assignments: Teredo, ORCHID, benchmarking
    [[0x20, 0x01, 0x0d, 0xb8], 32], // documentation
    [[0x20, 0x02], 16], // 6to4: an IPv4 address in disguise
    [[0x3f, 0xff], 20], // documentation
  ] as const) {
    if (startsWith(bytes, prefix, bits)) return false;
  }
  return true;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const bytes = v4Bytes(address);
    return bytes !== undefined && v4Public(bytes);
  }
  if (family === 6) {
    const bytes = v6Bytes(address);
    return bytes !== undefined && v6Public(bytes);
  }
  return false;
}
