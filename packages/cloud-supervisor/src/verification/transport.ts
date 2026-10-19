import { request } from 'node:https';

/** One request to one resolved address. The fetcher decides where it may go; the transport only goes there. */
export interface TransportRequest {
  url: URL;
  /** The address the fetcher resolved and checked. The connection goes to it, whatever DNS says now. */
  address: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  /** Releases the connection. Safe to call twice. */
  close(): void;
}

export interface Transport {
  get(request: TransportRequest): Promise<TransportResponse>;
}

export interface NodeTransportOptions {
  /** Extra certificate authorities, for a test server. Certificates are always verified. */
  ca?: string | Buffer;
}

/**
 * `https` to a fixed address: the socket connects to `address`, while the
 * certificate is verified for the URL's host name (SNI and the Host header).
 * No agent, so nothing is pooled and no cookie or credential is ever attached.
 */
export function nodeTransport(options: NodeTransportOptions = {}): Transport {
  return {
    get: ({ url, address, headers, signal }) =>
      new Promise((resolve, reject) => {
        const hostname = url.hostname.replace(/^\[|\]$/gu, '');
        const outgoing = request(
          {
            host: address,
            servername: hostname,
            port: url.port === '' ? 443 : Number(url.port),
            path: `${url.pathname}${url.search}`,
            method: 'GET',
            headers: { ...headers, host: url.host },
            agent: false,
            signal,
            ...(options.ca === undefined ? {} : { ca: options.ca }),
          },
          (response) => {
            const flat: Record<string, string | undefined> = {};
            for (const [name, value] of Object.entries(response.headers)) {
              flat[name] = Array.isArray(value) ? value.join(', ') : value;
            }
            resolve({
              status: response.statusCode ?? 0,
              headers: flat,
              body: response,
              close: () => {
                response.destroy();
                outgoing.destroy();
              },
            });
          },
        );
        outgoing.on('error', reject);
        outgoing.end();
      }),
  };
}
