import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPublicAddress } from './address.js';
import { type Transport, type TransportResponse, nodeTransport } from './transport.js';

/**
 * Fetches a page an agent cited, from the server. The URL was chosen by an
 * agent that read untrusted pages, so the fetch is the server's one outbound
 * request to an address it did not choose. Everything that makes that safe is
 * here: https only, no credentials or cookies, the host resolved once and the
 * connection pinned to that checked address, public addresses only (on the
 * first request and on every redirect), and caps on time, size and type.
 */

export type FetchRefusal =
  /** The URL or an address it resolves to is not allowed. */
  | 'blocked'
  | 'bad_url'
  | 'too_many_redirects'
  | 'unsupported_type'
  | 'too_large'
  /** The source answered with an error status. */
  | 'http_status'
  | 'timeout'
  | 'aborted'
  /** DNS or the connection failed. */
  | 'unreachable';

export type FetchOutcome =
  | { ok: true; text: string; finalUrl: string; contentType: string; bytes: number }
  | { ok: false; reason: FetchRefusal; detail: string };

export interface SourceFetcher {
  fetchText(url: string, signal: AbortSignal): Promise<FetchOutcome>;
}

export interface FetcherOptions {
  /** All addresses of a host name. Default: the system resolver. */
  resolve?: (hostname: string) => Promise<string[]>;
  transport?: Transport;
  maxBytes?: number;
  /** For the whole fetch, redirects included. */
  timeoutMs?: number;
  maxRedirects?: number;
}

const DEFAULTS = { maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000, maxRedirects: 3 };
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TEXT_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain']);

async function systemResolve(hostname: string): Promise<string[]> {
  const found = await lookup(hostname, { all: true, verbatim: true });
  return found.map((entry) => entry.address);
}

/** Rejects when `signal` aborts, even if `work` ignores it. A value that arrives after that is handed to `late`. */
function raceAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
  late?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      settled = true;
      reject(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (settled) late?.(value);
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        if (!settled) reject(error);
      },
    );
  });
}

class Refused extends Error {
  constructor(
    readonly reason: FetchRefusal,
    detail: string,
  ) {
    super(detail);
  }
}

export function createSourceFetcher(options: FetcherOptions = {}): SourceFetcher {
  const resolve = options.resolve ?? systemResolve;
  const transport = options.transport ?? nodeTransport();
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;

  /** Checks a URL and the addresses behind it. Returns the one address to connect to. */
  async function admit(raw: string, base?: URL): Promise<{ url: URL; address: string }> {
    let url: URL;
    try {
      url = new URL(raw, base);
    } catch {
      throw new Refused('bad_url', 'not a URL');
    }
    if (url.protocol !== 'https:') throw new Refused('blocked', 'only https is fetched');
    if (url.username !== '' || url.password !== '') {
      throw new Refused('blocked', 'a URL with credentials is not fetched');
    }
    if (url.port !== '' && url.port !== '443')
      throw new Refused('blocked', 'only port 443 is fetched');
    const host = url.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
    if (host === '') throw new Refused('bad_url', 'no host');
    if (isIP(host) !== 0) {
      if (!isPublicAddress(host)) throw new Refused('blocked', 'the address is not public');
      return { url, address: host };
    }
    let addresses: string[];
    try {
      addresses = await resolve(host);
    } catch {
      throw new Refused('unreachable', 'the host name did not resolve');
    }
    if (addresses.length === 0) throw new Refused('unreachable', 'the host name has no address');
    // One private answer among public ones is still refused: the connection must not be able to pick it.
    if (!addresses.every(isPublicAddress)) {
      throw new Refused('blocked', 'the host name resolves to an address that is not public');
    }
    return { url, address: addresses[0] as string };
  }

  async function readBody(response: TransportResponse, signal: AbortSignal): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const iterator = response.body[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await raceAbort(iterator.next(), signal);
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxBytes) throw new Refused('too_large', `the page is over ${maxBytes} bytes`);
        chunks.push(next.value);
      }
    } finally {
      void iterator.return?.(undefined)?.catch(() => {});
    }
    return Buffer.concat(chunks, total);
  }

  async function run(start: string, signal: AbortSignal): Promise<FetchOutcome> {
    let current: URL | undefined;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const { url, address } = await admit(hop === 0 ? start : (current as URL).href, undefined);
      current = url;
      let response: TransportResponse;
      try {
        response = await raceAbort(
          transport.get({
            url,
            address,
            headers: {
              accept: 'text/html, application/xhtml+xml, text/plain;q=0.9',
              'accept-encoding': 'identity',
              'user-agent': 'maka-cloud-source-check',
            },
            signal,
          }),
          signal,
          (late) => late.close(),
        );
      } catch (error) {
        if (signal.aborted) throw error;
        throw new Refused('unreachable', 'the connection failed');
      }
      try {
        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.location;
          if (location === undefined || location === '') {
            throw new Refused('http_status', 'a redirect without a location');
          }
          if (hop === maxRedirects) throw new Refused('too_many_redirects', 'too many redirects');
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            throw new Refused('bad_url', 'the redirect target is not a URL');
          }
          current = next;
          continue;
        }
        if (response.status < 200 || response.status >= 300) {
          throw new Refused('http_status', `the source answered ${response.status}`);
        }
        const encoding = (response.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
        if (encoding !== 'identity') throw new Refused('unsupported_type', 'an encoded body');
        const contentType =
          (response.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
        if (!TEXT_TYPES.has(contentType)) {
          throw new Refused(
            'unsupported_type',
            `the content type ${contentType || '(none)'} is not text`,
          );
        }
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          throw new Refused('too_large', `the page is ${declared} bytes`);
        }
        const bytes = await readBody(response, signal);
        return {
          ok: true,
          text: new TextDecoder('utf-8').decode(bytes),
          finalUrl: url.href,
          contentType,
          bytes: bytes.byteLength,
        };
      } finally {
        response.close();
      }
    }
    throw new Refused('too_many_redirects', 'too many redirects');
  }

  return {
    async fetchText(url, signal) {
      const deadline = new AbortController();
      const timer = setTimeout(
        () => deadline.abort(new Refused('timeout', 'the source took too long')),
        timeoutMs,
      );
      const combined = AbortSignal.any([signal, deadline.signal]);
      try {
        return await run(url, combined);
      } catch (error) {
        if (error instanceof Refused)
          return { ok: false, reason: error.reason, detail: error.message };
        if (deadline.signal.aborted)
          return { ok: false, reason: 'timeout', detail: 'the source took too long' };
        if (signal.aborted)
          return { ok: false, reason: 'aborted', detail: 'the check was stopped' };
        return { ok: false, reason: 'unreachable', detail: 'the connection failed' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
