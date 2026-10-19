import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { nodeTransport } from '../transport.js';

function certificate(host: string): { key: Buffer; cert: Buffer; dir: string } | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'supervisor-cert-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-subj',
        `/CN=${host}`,
        '-addext',
        `subjectAltName=DNS:${host}`,
      ],
      { stdio: 'ignore' },
    );
    return {
      key: readFileSync(join(dir, 'key.pem')),
      cert: readFileSync(join(dir, 'cert.pem')),
      dir,
    };
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

test('the real transport connects to the pinned address and verifies the certificate for the URL host', async (t) => {
  const pems = certificate('pages.example');
  if (!pems) return t.skip('openssl is not available');
  const seen: { host?: string; cookie?: string; auth?: string } = {};
  const server = createServer({ key: pems.key, cert: pems.cert }, (req, res) => {
    seen.host = req.headers.host;
    seen.cookie = req.headers.cookie;
    seen.auth = req.headers.authorization;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('pinned');
  });
  const port = await listen(server);
  t.after(() => {
    server.close();
    rmSync(pems.dir, { recursive: true, force: true });
  });

  // The test server is on loopback and the certificate names pages.example: the transport reaches
  // the address it is given and accepts the certificate only for the URL's host name.
  const transport = nodeTransport({ ca: pems.cert });
  const url = new URL(`https://pages.example:${port}/doc?x=1`);
  const response = await transport.get({
    url,
    address: '127.0.0.1',
    headers: { accept: 'text/plain' },
    signal: new AbortController().signal,
  });
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) chunks.push(chunk);
  response.close();
  response.close();
  assert.equal(response.status, 200);
  assert.equal(Buffer.concat(chunks).toString(), 'pinned');
  assert.equal(seen.host, `pages.example:${port}`);
  assert.equal(seen.cookie, undefined);
  assert.equal(seen.auth, undefined);

  // A certificate for another host name is refused even though the address is the same.
  const wrong = new URL(`https://other.example:${port}/`);
  await assert.rejects(
    transport.get({
      url: wrong,
      address: '127.0.0.1',
      headers: {},
      signal: new AbortController().signal,
    }),
    /certificate|altnames|Hostname/iu,
  );
});

test('the real transport does not trust a certificate it was not given', async (t) => {
  const pems = certificate('pages.example');
  if (!pems) return t.skip('openssl is not available');
  const server = createServer({ key: pems.key, cert: pems.cert }, (_req, res) => res.end('x'));
  const port = await listen(server);
  t.after(() => {
    server.close();
    rmSync(pems.dir, { recursive: true, force: true });
  });
  await assert.rejects(
    nodeTransport().get({
      url: new URL(`https://pages.example:${port}/`),
      address: '127.0.0.1',
      headers: {},
      signal: new AbortController().signal,
    }),
    /self[- ]signed|unable to verify|certificate/iu,
  );
});
