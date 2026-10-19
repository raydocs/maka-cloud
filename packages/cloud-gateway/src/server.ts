import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { plainRefusal, refusalResponse } from './errors.js';
import type { Gateway, Route } from './gateway.js';
import type { Vendor } from './pricing.js';
import { MAX_SEARCH_BODY_BYTES } from './search.js';

/** The paths sandboxes call, under the gateway's base URL. */
export const ROUTES: Readonly<Record<string, { vendor: Vendor; route: Route }>> = {
  '/anthropic/v1/messages': { vendor: 'anthropic', route: 'messages' },
  '/anthropic/v1/messages/count_tokens': { vendor: 'anthropic', route: 'count' },
  '/openai/v1/responses': { vendor: 'openai', route: 'responses' },
};

/** Web search, for a grant of either vendor. */
export const SEARCH_PATH = '/search';

/** The URL a sandbox's search tool calls. */
export function searchUrl(gatewayUrl: string): string {
  return `${gatewayUrl.replace(/\/+$/u, '')}${SEARCH_PATH}`;
}

/** The base URL a vendor's CLI is given, below the gateway's own URL. */
export function vendorBaseUrl(gatewayUrl: string, vendor: Vendor): string {
  const base = gatewayUrl.replace(/\/+$/u, '');
  return vendor === 'anthropic' ? `${base}/anthropic` : `${base}/openai/v1`;
}

export interface GatewayServer {
  /** `http://host:port`, as bound. */
  url: string;
  server: Server;
  close(): Promise<void>;
}

function tokenOf(request: IncomingMessage): string | undefined {
  const key = request.headers['x-api-key'];
  if (typeof key === 'string' && key !== '') return key;
  const auth = request.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return undefined;
}

function headersOf(request: IncomingMessage): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') out.set(name, value);
  }
  return out;
}

async function readBody(request: IncomingMessage, max: number): Promise<Uint8Array | undefined> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > max) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > max) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function write(out: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  out.writeHead(response.status, headers);
  if (response.body === null) {
    out.end();
    return;
  }
  const reader = response.body.getReader();
  // The caller went away: stop reading, which cuts the request upstream.
  const onClose = (): void => {
    if (!out.writableFinished) void reader.cancel().catch(() => undefined);
  };
  out.on('close', onClose);
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!out.write(next.value)) await once(out, 'drain');
    }
    out.end();
  } catch {
    out.destroy();
  } finally {
    out.off('close', onClose);
  }
}

/**
 * Serves the gateway over HTTP for sandboxes. Every request needs a live grant's token, on the
 * route of the grant's vendor. No body, header value or token is logged.
 */
export async function serveGateway(
  gateway: Gateway,
  options: { host: string; port: number },
): Promise<GatewayServer> {
  const server = createServer((request, out) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://gateway').pathname;
      if (path === SEARCH_PATH) return search(request, out);
      const match = ROUTES[path];
      const vendor: Vendor =
        match?.vendor ?? (path.startsWith('/openai/') ? 'openai' : 'anthropic');
      if (!match || request.method !== 'POST') {
        request.resume();
        return write(
          out,
          refusalResponse(vendor, 'not_found', 'the gateway does not serve this path'),
        );
      }
      const found = gateway.authenticate(tokenOf(request));
      if (!found || found.vendor !== match.vendor) {
        request.resume();
        return write(
          out,
          refusalResponse(vendor, 'unauthenticated', 'the access key is not valid'),
        );
      }
      const body = await readBody(request, gateway.limits.maxBodyBytes);
      if (body === undefined) {
        request.resume();
        return write(out, refusalResponse(vendor, 'too_large', 'the request body is too large'));
      }
      const aborted = new AbortController();
      out.on('close', () => {
        if (!out.writableFinished) aborted.abort();
      });
      const response = await gateway.handle(
        found.grant,
        match.route,
        headersOf(request),
        body,
        aborted.signal,
      );
      await write(out, response);
    })().catch(() => {
      if (!out.headersSent) {
        out.writeHead(500, { 'content-type': 'application/json' });
        out.end('{"error":{"message":"the gateway failed"}}');
      } else out.destroy();
    });
  });
  const search = async (request: IncomingMessage, out: ServerResponse): Promise<void> => {
    if (request.method !== 'POST') {
      request.resume();
      return write(out, plainRefusal('not_found', 'the gateway does not serve this path'));
    }
    const found = gateway.authenticate(tokenOf(request));
    if (!found) {
      request.resume();
      return write(out, plainRefusal('unauthenticated', 'the access key is not valid'));
    }
    const body = await readBody(request, MAX_SEARCH_BODY_BYTES);
    if (body === undefined) {
      request.resume();
      return write(out, plainRefusal('too_large', 'the request body is too large'));
    }
    const aborted = new AbortController();
    out.on('close', () => {
      if (!out.writableFinished) aborted.abort();
    });
    await write(out, await gateway.search(found.grant, body, aborted.signal));
  };
  server.listen(options.port, options.host);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    url: `http://${host}:${address.port}`,
    server,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
