import { isIP } from 'node:net';
import { type LookupAddress, type LookupOptions, lookup } from 'node:dns';
import { Agent, request } from 'node:https';
import { isPublicAddress } from './public-address.js';

export interface PushRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: Buffer;
}

/** Delivers one encrypted push message. Rejects on a network error, timeout or abort. */
export type PushTransport = (
  request: PushRequest,
  signal: AbortSignal,
) => Promise<{ status: number }>;

const MAX_RESPONSE_BYTES = 4096;

/**
 * True for every address a push service is not: loopback, private, link-local (the cloud metadata
 * address among them), multicast, reserved, unspecified, an IPv4 address in an IPv6 disguise
 * (mapped, NAT64, 6to4) that would reach one of those, and anything that is not an IP at all.
 * It is the one rule `public-address.ts` states, so the push path cannot drift from the fetcher's.
 */
export function isNonPublicAddress(address: string): boolean {
  return !isPublicAddress(address);
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `dns.lookup` that refuses to hand back a non-public address. The check is
 * on the address the socket will connect to, so it holds against a name that
 * resolves differently the second time.
 */
export function publicOnlyLookup(
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
): void {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    const list = addresses;
    const allowed = list.filter((entry) => !isNonPublicAddress(entry.address));
    if (allowed.length === 0 || allowed.length !== list.length) {
      const refused = Object.assign(new Error(`${hostname} does not resolve to a public address`), {
        code: 'EPUSHADDR',
      }) as NodeJS.ErrnoException;
      return callback(refused, '');
    }
    if (options.all) return callback(null, allowed);
    const [first] = allowed;
    callback(null, first?.address ?? '', first?.family);
  });
}

/**
 * HTTPS to the push service: no redirect is followed (`https.request` never
 * does), the address is checked at connect time, the response body is read to at
 * most 4 KiB, and the request ends when the signal aborts.
 */
export function createHttpsTransport(): PushTransport & { close(): void } {
  const agent = new Agent({ keepAlive: false, lookup: publicOnlyLookup, maxSockets: 16 });
  const send: PushTransport = (message, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason ?? new Error('aborted'));
      // An IP literal never reaches `lookup`, so it is checked here.
      const host = new URL(message.endpoint).hostname.replace(/^\[|\]$/gu, '');
      if (isIP(host) !== 0 && isNonPublicAddress(host)) {
        return reject(Object.assign(new Error('not a public address'), { code: 'EPUSHADDR' }));
      }
      const req = request(
        message.endpoint,
        { method: 'POST', headers: message.headers, agent, signal },
        (res) => {
          let seen = 0;
          res.on('data', (chunk: Buffer) => {
            seen += chunk.length;
            if (seen > MAX_RESPONSE_BYTES) res.destroy();
          });
          res.on('error', () => undefined);
          res.on('close', () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on('error', reject);
      req.end(message.body);
    });
  return Object.assign(send, { close: () => agent.destroy() });
}
