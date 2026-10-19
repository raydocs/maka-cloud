import { isIP } from 'node:net';

type Cidr4 = readonly [number, number, number];

/** [first byte, second byte mask start, prefix bits]: written as dotted base and prefix for readability. */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including the cloud metadata address
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including broadcast
];

const BLOCKED_V4_NUMERIC: Cidr4[] = BLOCKED_V4.map(([base, bits]) => {
  const value = v4ToNumber(base.split('.').map(Number));
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [(value & mask) >>> 0, mask, bits] as const;
});

function v4ToNumber(bytes: readonly number[]): number {
  return (
    (((bytes[0] ?? 0) << 24) |
      ((bytes[1] ?? 0) << 16) |
      ((bytes[2] ?? 0) << 8) |
      (bytes[3] ?? 0)) >>>
    0
  );
}

function publicV4(bytes: readonly number[]): boolean {
  const value = v4ToNumber(bytes);
  return !BLOCKED_V4_NUMERIC.some(([base, mask]) => (value & mask) >>> 0 === base);
}

/** The 16 bytes of an IPv6 address, or undefined if it does not parse. Handles `::` and a trailing dotted IPv4. */
export function parseIPv6(address: string): number[] | undefined {
  let text = address;
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (isIP(text) !== 6) return undefined;
  let tail: number[] = [];
  const dotted = text.lastIndexOf('.');
  if (dotted >= 0) {
    const colon = text.lastIndexOf(':');
    const v4 = text
      .slice(colon + 1)
      .split('.')
      .map(Number);
    if (v4.length !== 4 || v4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return undefined;
    }
    tail = v4;
    text = `${text.slice(0, colon + 1)}0:0`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0] ?? '');
  const rest = halves.length === 2 ? groups(halves[1] ?? '') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return undefined;
  const all = halves.length === 1 ? head : [...head, ...Array(missing).fill('0'), ...rest];
  const bytes: number[] = [];
  for (const group of all) {
    const value = Number.parseInt(group, 16);
    if (!/^[0-9a-f]{1,4}$/iu.test(group) || Number.isNaN(value)) return undefined;
    bytes.push(value >> 8, value & 0xff);
  }
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes.length === 16 ? bytes : undefined;
}

function startsWith(bytes: readonly number[], prefix: readonly number[], bits: number): boolean {
  for (let bit = 0; bit < bits; bit += 8) {
    const remaining = Math.min(8, bits - bit);
    const mask = (0xff << (8 - remaining)) & 0xff;
    const index = bit / 8;
    if (((bytes[index] ?? 0) & mask) !== ((prefix[index] ?? 0) & mask)) return false;
  }
  return true;
}

function publicV6(bytes: readonly number[]): boolean {
  const embedded = (offset: number) => bytes.slice(offset, offset + 4);
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judged by the IPv4 address inside.
  if (startsWith(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96))
    return publicV4(embedded(12));
  if (startsWith(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 96)) return false;
  // NAT64 (64:ff9b::/96) carries an IPv4 address; the local-use block 64:ff9b:1::/48 is never public.
  if (startsWith(bytes, [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96))
    return publicV4(embedded(12));
  // 6to4 (2002::/16) carries the IPv4 address in bytes 2 to 5.
  if (startsWith(bytes, [0x20, 0x02], 16)) return publicV4(embedded(2));
  // Only global unicast (2000::/3) can be public; the special blocks inside it are not.
  if (!startsWith(bytes, [0x20], 3)) return false;
  const special: ReadonlyArray<readonly [number[], number]> = [
    [[0x20, 0x01, 0x00, 0x00], 32], // Teredo
    [[0x20, 0x01, 0x00, 0x02], 48], // benchmarking
    [[0x20, 0x01, 0x0d, 0xb8], 32], // documentation
    [[0x20, 0x01, 0x00, 0x10], 28], // deprecated ORCHID
    [[0x20, 0x01, 0x00, 0x20], 28], // ORCHIDv2
    [[0x3f, 0xff], 20], // documentation
  ];
  return !special.some(([prefix, bits]) => startsWith(bytes, prefix, bits));
}

/**
 * True only for an address that is routable on the public internet. Anything
 * that does not parse is not public. Loopback, private, link-local (including
 * the metadata address), carrier-grade NAT, multicast, reserved and documentation
 * ranges are refused, and IPv6 forms that carry an IPv4 address are judged by it.
 */
export function isPublicAddress(address: string): boolean {
  const bare = address.startsWith('[') ? address.slice(1, -1) : address;
  const kind = isIP(bare);
  if (kind === 4) return publicV4(bare.split('.').map(Number));
  if (kind === 6) {
    const bytes = parseIPv6(bare);
    return bytes !== undefined && publicV6(bytes);
  }
  return false;
}
