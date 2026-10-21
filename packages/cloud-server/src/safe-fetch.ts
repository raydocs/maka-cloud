import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import type { ConnectionOptions } from 'node:tls';
import { isIP } from 'node:net';
import { isPublicAddress } from './public-address.js';

/**
 * Fetches a page or an image from the public internet for a server that must not become a way
 * into its own network (T24 preview proxy). What it holds to, whatever the caller passes:
 * - https on port 443 only, no credentials in the URL, no address literals, no single-label or
 *   local names, a URL of at most 2048 characters;
 * - every address the name resolves to is public (see `isPublicAddress`), or nothing is fetched;
 * - the socket connects to the address that was checked, not to a second lookup, so a name that
 *   answers differently the next time cannot move it;
 * - a redirect is followed by hand, at most `maxRedirects` times, and each hop is checked like the
 *   first request (a redirect to http, to a literal or to a private name is refused);
 * - the whole request (lookup, connect, headers, body) ends at one deadline and at the caller's
 *   signal, and the body is read to at most `maxBytes`; a response over it is refused whole, unless
 *   the caller says it wants only the start of a page (`startOnly`), and then it is cut there;
 * - nothing of ours is sent: no cookie, no authorization, no referer, no compression;
 * - only the content types the caller listed are read, and only a plain 200.
 * A refusal is a reason code and never carries the URL, an address or the network's error text.
 */
export type SafeFetchRefusal =
  | 'bad_url'
  | 'blocked_address'
  | 'resolve_failed'
  | 'too_many_redirects'
  | 'bad_redirect'
  | 'bad_status'
  | 'bad_type'
  | 'too_large'
  | 'timeout'
  | 'aborted'
  | 'network';

export type SafeFetchResult =
  | { ok: true; url: string; contentType: string; body: Buffer }
  | { ok: false; reason: SafeFetchRefusal };

export interface SafeFetchRequest {
  /** The content types (without parameters, lower case) that may be read; a prefix ending in `/` matches a family. */
  accept: readonly string[];
  maxBytes: number;
  /** For a page whose head is all that is wanted: a body over `maxBytes` is cut there instead of refused. */
  startOnly?: boolean;
  timeoutMs: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface TransportRequest {
  url: URL;
  /** The only address the socket may connect to. */
  address: ResolvedAddress;
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: AsyncIterable<Uint8Array>;
  /** Ends the request and its socket. Called on every exit, and may be called twice. */
  destroy(): void;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface SafeFetchDeps {
  resolve?: Resolver;
  transport?: Transport;
  /** Tests only: the production check is `isPublicAddress`. */
  isPublic?: (address: string) => boolean;
}

const MAX_URL_LENGTH = 2048;
const DEFAULT_REDIRECTS = 3;
const MAX_HEADER_BYTES = 16 * 1024;
const REQUEST_HEADERS: Readonly<Record<string, string>> = {
  'user-agent': 'maka-preview/1',
  accept: '*/*',
  'accept-encoding': 'identity',
  connection: 'close',
};

const defaultResolve: Resolver = async (hostname) => {
  const found = await lookup(hostname, { all: true, verbatim: true });
  return found.map(({ address, family }) => ({ address, family }));
};

/** The page's own part of a content type: no parameters, lower case. */
export function contentTypeEssence(value: string | undefined): string {
  return (value ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function acceptable(type: string, accept: readonly string[]): boolean {
  return (
    type !== '' &&
    accept.some((rule) => (rule.endsWith('/') ? type.startsWith(rule) : type === rule))
  );
}

/** The URL to fetch, or nothing when it is not a plain public https URL. */
export function publicHttpsUrl(value: string, base?: URL): URL | undefined {
  if (value.length > MAX_URL_LENGTH) return undefined;
  let url: URL;
  try {
    url = base ? new URL(value, base) : new URL(value);
  } catch {
    return undefined;
  }
  if (url.href.length > MAX_URL_LENGTH) return undefined;
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
  if (url.port !== '' && url.port !== '443') return undefined;
  const host = url.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  // A literal address (the URL parser has turned "0x7f.1" and "2130706433" into one) is never a
  // public site name, and a name with no dot is a local one.
  if (host === '' || isIP(host) !== 0 || !host.includes('.')) return undefined;
  if (/\.(local|localhost|internal|lan|home|corp|intranet|arpa)$/u.test(host)) return undefined;
  if (/^\d+(\.\d+)*$/u.test(host)) return undefined;
  return url;
}

export function createSafeFetch(deps: SafeFetchDeps = {}) {
  const resolve = deps.resolve ?? defaultResolve;
  const transport = deps.transport ?? httpsTransport();
  const isPublic = deps.isPublic ?? isPublicAddress;

  return async function safeFetch(
    rawUrl: string,
    options: SafeFetchRequest,
  ): Promise<SafeFetchResult> {
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new RefusalError('timeout')),
      Math.max(1, options.timeoutMs),
    );
    const onCallerAbort = () => deadline.abort(new RefusalError('aborted'));
    if (options.signal?.aborted) onCallerAbort();
    options.signal?.addEventListener('abort', onCallerAbort, { once: true });
    try {
      return await run(rawUrl, options, deadline.signal);
    } catch (error) {
      if (error instanceof RefusalError) return { ok: false, reason: error.reason };
      // The deadline aborts the in-flight step with its own reason; anything else is the network.
      const reason = deadline.signal.reason;
      if (deadline.signal.aborted && reason instanceof RefusalError)
        return { ok: false, reason: reason.reason };
      return { ok: false, reason: 'network' };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onCallerAbort);
    }
  };

  async function run(
    rawUrl: string,
    options: SafeFetchRequest,
    signal: AbortSignal,
  ): Promise<SafeFetchResult> {
    const maxRedirects = options.maxRedirects ?? DEFAULT_REDIRECTS;
    const first = publicHttpsUrl(rawUrl);
    if (!first) return refuse('bad_url');
    let url: URL = first;
    for (let hop = 0; ; hop += 1) {
      const address = await pickAddress(url.hostname, signal);
      const response: TransportResponse = await raceAbort(
        transport({ url, address, headers: REQUEST_HEADERS, signal }),
        signal,
      );
      try {
        const status = response.status;
        if (status >= 300 && status < 400 && status !== 304) {
          const location: string | undefined = response.headers.location;
          if (hop >= maxRedirects) return refuse('too_many_redirects');
          const next: URL | undefined =
            location === undefined ? undefined : publicHttpsUrl(location, url);
          if (!next) return refuse('bad_redirect');
          url = next;
          continue;
        }
        if (status !== 200) return refuse('bad_status');
        const type = contentTypeEssence(response.headers['content-type']);
        if (!acceptable(type, options.accept)) return refuse('bad_type');
        const encoding = (response.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
        if (encoding !== 'identity' && encoding !== '') return refuse('bad_type');
        const declared = response.headers['content-length'];
        if (
          declared !== undefined &&
          /^\d+$/u.test(declared) &&
          Number(declared) > options.maxBytes &&
          !options.startOnly
        ) {
          return refuse('too_large');
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const reader = response.body[Symbol.asyncIterator]();
        try {
          for (;;) {
            const next: IteratorResult<Uint8Array> = await raceAbort(reader.next(), signal);
            if (next.done) break;
            size += next.value.length;
            if (size > options.maxBytes) {
              if (!options.startOnly) return refuse('too_large');
              chunks.push(
                Buffer.from(next.value).subarray(0, options.maxBytes - (size - next.value.length)),
              );
              break;
            }
            chunks.push(Buffer.from(next.value));
          }
        } finally {
          void Promise.resolve(reader.return?.()).catch(() => undefined);
        }
        return { ok: true, url: url.href, contentType: type, body: Buffer.concat(chunks) };
      } finally {
        response.destroy();
      }
    }
  }

  async function pickAddress(hostname: string, signal: AbortSignal): Promise<ResolvedAddress> {
    let answers: ResolvedAddress[];
    try {
      answers = await raceAbort(resolve(hostname.replace(/\.$/u, '')), signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new RefusalError('resolve_failed');
    }
    // One private answer among public ones refuses the name: a client that connects to a
    // different answer than the one checked would otherwise be sent there.
    if (answers.length === 0 || answers.some((entry) => !isPublic(entry.address))) {
      throw new RefusalError('blocked_address');
    }
    const [first] = answers;
    if (!first) throw new RefusalError('blocked_address');
    return first;
  }
}

class RefusalError extends Error {
  constructor(readonly reason: SafeFetchRefusal) {
    super(reason);
  }
}

function refuse(reason: SafeFetchRefusal): SafeFetchResult {
  return { ok: false, reason };
}

/** Rejects with the signal's reason when it aborts first; a late result of `work` is dropped (and destroyed when it is a response). */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener('abort', abort, { once: true });
    }
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) {
          (value as { destroy?: () => void } | undefined)?.destroy?.();
          reject(signal.reason);
        } else {
          resolve(value);
        }
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

/**
 * The real transport: HTTPS to the checked address with the name's own TLS identity (the
 * certificate must be valid for the host in the URL, TLS 1.2 or later, SNI set), the response
 * header size capped, and no agent, so no socket is shared between requests.
 */
export function httpsTransport(tls: Pick<ConnectionOptions, 'ca'> = {}): Transport {
  return ({ url, address, headers, signal }) =>
    new Promise<TransportResponse>((resolve, reject) => {
      const hostname = url.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
      const req = request(
        {
          // The checked address; the certificate is verified for the URL's own host name.
          host: address.address,
          servername: hostname,
          port: url.port === '' ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: { ...headers, host: url.host },
          agent: false,
          signal,
          maxHeaderSize: MAX_HEADER_BYTES,
          minVersion: 'TLSv1.2',
          ...(tls.ca ? { ca: tls.ca } : {}),
        },
        (res) => {
          const flat: Record<string, string | undefined> = {};
          for (const [name, value] of Object.entries(res.headers)) {
            flat[name] = Array.isArray(value) ? value.join(', ') : value;
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: flat,
            body: res,
            destroy: () => {
              res.destroy();
              req.destroy();
            },
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
}
