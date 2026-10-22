import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { test } from 'node:test';
import {
  APPLE,
  createOidcVerifier,
  GOOGLE,
  type JwksSource,
  jwksFromSafeFetch,
} from '../identity.js';
import { createSafeFetch } from '../safe-fetch.js';

const NOW = 1_800_000_000_000;
const AUD = 'cloud.maka.app';
const NONCE = 'n0nce-from-the-server';

interface Signer {
  kid: string;
  privateKey: KeyObject;
  jwk: JsonWebKey & { kid: string };
}

function signer(kid: string, bits = 2048): Signer {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  return {
    kid,
    privateKey,
    jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' },
  };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function token(
  key: Signer,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string {
  const head = b64({ alg: 'RS256', kid: key.kid, ...header });
  const body = b64({
    iss: 'https://accounts.google.com',
    aud: AUD,
    sub: 'g-123',
    exp: NOW / 1000 + 600,
    iat: NOW / 1000 - 10,
    nonce: NONCE,
    email: 'ada@example.com',
    email_verified: true,
    ...claims,
  });
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key.privateKey).toString(
    'base64url',
  );
  return `${head}.${body}.${sig}`;
}

function setup(keys: Signer[] = [signer('k1')], now = () => NOW) {
  let fetches = 0;
  const state = { keys, fail: false, garbage: false };
  const source: JwksSource = async () => {
    fetches += 1;
    if (state.fail) throw new Error('offline');
    if (state.garbage) return { keys: 'nope' as unknown as JsonWebKey[] };
    return { keys: state.keys.map((k) => k.jwk) };
  };
  const verifier = createOidcVerifier({ ...GOOGLE, audiences: [AUD] }, source, now);
  assert.ok(verifier);
  return { verifier, state, fetches: () => fetches };
}

test('a token signed by the provider’s key for our client with our nonce is an identity', async () => {
  const k = signer('k1');
  const { verifier } = setup([k]);
  assert.deepEqual(await verifier.verify(token(k, {}), NONCE), {
    provider: 'google',
    subject: 'g-123',
    email: 'ada@example.com',
    emailVerified: true,
  });
});

test('Apple’s string flag, an audience list and the other issuer form are understood', async () => {
  const k = signer('k1');
  const source: JwksSource = async () => ({ keys: [k.jwk] });
  const apple = createOidcVerifier({ ...APPLE, audiences: ['web.id', AUD] }, source, () => NOW);
  assert.ok(apple);
  const id = await apple.verify(
    token(k, { iss: 'https://appleid.apple.com', aud: ['other', AUD], email_verified: 'true' }),
    NONCE,
  );
  assert.equal(id?.provider, 'apple');
  assert.equal(id?.emailVerified, true);
  const google = setup([k]).verifier;
  assert.ok(await google.verify(token(k, { iss: 'accounts.google.com' }), NONCE));
});

test('an email the provider does not vouch for is reported as unverified, and none is fine', async () => {
  const k = signer('k1');
  const { verifier } = setup([k]);
  assert.equal(
    (await verifier.verify(token(k, { email_verified: false }), NONCE))?.emailVerified,
    false,
  );
  const none = await verifier.verify(token(k, { email: undefined, email_verified: true }), NONCE);
  assert.equal(none?.email, undefined);
  assert.equal(none?.emailVerified, false);
});

test('a token that is wrong in any one way is nothing', async () => {
  const k = signer('k1');
  const other = signer('k1'); // same kid, a key the provider never published
  const { verifier } = setup([k]);
  const exp = NOW / 1000;
  const good = token(k, {});
  const [head, body, sig] = good.split('.') as [string, string, string];
  const cases: Array<[string, string]> = [
    ['signed by another key under the same kid', token(other, {})],
    ['unknown kid', token(signer('k9'), {})],
    [
      'claims changed after signing',
      `${head}.${b64({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), sub: 'someone-else' })}.${sig}`,
    ],
    ['wrong issuer', token(k, { iss: 'https://evil.example' })],
    ['issuer of the other provider', token(k, { iss: 'https://appleid.apple.com' })],
    ['wrong audience', token(k, { aud: 'someone.else' })],
    ['audience list without ours', token(k, { aud: ['a', 'b'] })],
    ['no audience', token(k, { aud: undefined })],
    ['expired', token(k, { exp: exp - 120 })],
    ['no expiry', token(k, { exp: undefined })],
    ['expiry as text', token(k, { exp: String(exp + 600) })],
    ['expiry far ahead', token(k, { exp: exp + 7 * 24 * 3600 })],
    ['issued in the future', token(k, { iat: exp + 3600 })],
    ['not yet valid', token(k, { nbf: exp + 3600 })],
    ['wrong nonce', token(k, { nonce: 'another' })],
    ['no nonce', token(k, { nonce: undefined })],
    ['numeric nonce', token(k, { nonce: 123 })],
    ['no subject', token(k, { sub: undefined })],
    ['empty subject', token(k, { sub: '' })],
    ['subject too long', token(k, { sub: 'x'.repeat(256) })],
    ['no kid in the header', token(k, {}, { kid: undefined })],
    ['not three parts', `${head}.${body}`],
    ['four parts', `${good}.x`],
    ['empty signature', `${head}.${body}.`],
    ['not base64url', `${head}.${body}.@@@`],
    ['empty', ''],
  ];
  for (const [what, candidate] of cases) {
    assert.equal(await verifier.verify(candidate, NONCE), undefined, what);
  }
  assert.equal(await verifier.verify(good, ''), undefined, 'an empty expected nonce');
  assert.ok(await verifier.verify(good, NONCE), 'the good one still works');
});

test('a token cannot choose a weaker algorithm', async () => {
  const k = signer('k1');
  const { verifier } = setup([k]);
  const claims = {
    iss: 'https://accounts.google.com',
    aud: AUD,
    sub: 'g-1',
    exp: NOW / 1000 + 600,
    nonce: NONCE,
  };
  // alg none with no signature, and with an empty one
  for (const sig of ['', 'AAAA']) {
    const none = `${b64({ alg: 'none', kid: 'k1' })}.${b64(claims)}.${sig}`;
    assert.equal(await verifier.verify(none, NONCE), undefined, `none / ${sig}`);
  }
  // HS256 keyed with the public key's bytes, the classic confusion
  const pem = Buffer.from(JSON.stringify(k.jwk));
  const head = b64({ alg: 'HS256', kid: 'k1' });
  const body = b64(claims);
  const mac = createHmac('sha256', pem).update(`${head}.${body}`).digest('base64url');
  assert.equal(await verifier.verify(`${head}.${body}.${mac}`, NONCE), undefined, 'HS256');
  const es = `${b64({ alg: 'ES256', kid: 'k1' })}.${body}.${mac}`;
  assert.equal(await verifier.verify(es, NONCE), undefined, 'ES256');
  assert.equal(
    await verifier.verify(token(k, {}, { alg: 'rs256' }), NONCE),
    undefined,
    'lower case',
  );
});

test('a short RSA key, a key for another use and a non-RSA key are refused', async () => {
  const weak = signer('w', 1024);
  assert.equal(await setup([weak]).verifier.verify(token(weak, {}), NONCE), undefined);
  const k = signer('k1');
  const encrypt = { ...k, jwk: { ...k.jwk, use: 'enc' } };
  assert.equal(await setup([encrypt]).verifier.verify(token(k, {}), NONCE), undefined);
  const notRsa = { ...k, jwk: { ...k.jwk, kty: 'EC' } };
  assert.equal(await setup([notRsa]).verifier.verify(token(k, {}), NONCE), undefined);
  const otherAlg = { ...k, jwk: { ...k.jwk, alg: 'RS512' } };
  assert.equal(await setup([otherAlg]).verifier.verify(token(k, {}), NONCE), undefined);
});

test('a provider with no client id configured is off', () => {
  assert.equal(
    createOidcVerifier({ ...GOOGLE, audiences: [] }, async () => undefined),
    undefined,
  );
  assert.equal(
    createOidcVerifier({ ...GOOGLE, audiences: [''] }, async () => undefined),
    undefined,
  );
});

test('a rotated key is picked up, but an unknown kid cannot make the server refetch every time', async () => {
  let now = NOW;
  const k1 = signer('k1');
  const { verifier, state, fetches } = setup([k1], () => now);
  assert.ok(await verifier.verify(token(k1, {}), NONCE));
  assert.equal(fetches(), 1);
  const k2 = signer('k2');
  state.keys = [k1, k2];
  // an unknown key id right after a fetch does not fetch again...
  assert.equal(await verifier.verify(token(k2, {}), NONCE), undefined);
  assert.equal(fetches(), 1);
  // ...but does once a minute has passed
  now += 61_000;
  assert.ok(
    await verifier.verify(token(k2, { exp: (now + 600_000) / 1000, iat: now / 1000 - 5 }), NONCE),
  );
  assert.equal(fetches(), 2);
  for (let i = 0; i < 5; i += 1) await verifier.verify(token(signer('zz'), {}), NONCE);
  assert.equal(fetches(), 2, 'garbage kids within the minute fetch nothing');
});

test('when the provider cannot be reached the old keys serve for a day, and then nothing does', async () => {
  let now = NOW;
  const k = signer('k1');
  const { verifier, state } = setup([k], () => now);
  const fresh = () => token(k, { exp: (now + 600_000) / 1000, iat: now / 1000 - 5 });
  assert.ok(await verifier.verify(fresh(), NONCE));
  state.fail = true;
  now += 2 * 60 * 60 * 1000;
  assert.ok(await verifier.verify(fresh(), NONCE), 'two hours on, offline');
  now += 23 * 60 * 60 * 1000;
  assert.equal(await verifier.verify(fresh(), NONCE), undefined, 'over a day without keys');
  state.fail = false;
  now += 61_000;
  assert.ok(await verifier.verify(fresh(), NONCE), 'recovers when the provider is back');
});

test('a garbage or empty key set never replaces the keys that work', async () => {
  let now = NOW;
  const k = signer('k1');
  const { verifier, state } = setup([k], () => now);
  const fresh = () => token(k, { exp: (now + 600_000) / 1000, iat: now / 1000 - 5 });
  assert.ok(await verifier.verify(fresh(), NONCE));
  state.garbage = true;
  now += 2 * 60 * 60 * 1000;
  assert.ok(await verifier.verify(fresh(), NONCE));
  state.garbage = false;
  state.keys = [];
  now += 61_000;
  assert.ok(await verifier.verify(fresh(), NONCE));
});

test('the key set is fetched with the safe fetch: public https only, json only, nothing of ours sent', async () => {
  const k = signer('k1');
  const seen: Array<{ url: string; headers: Readonly<Record<string, string>> }> = [];
  const body = Buffer.from(JSON.stringify({ keys: [k.jwk] }));
  const safeFetch = createSafeFetch({
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: async (request) => {
      seen.push({ url: request.url.href, headers: request.headers });
      return {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: (async function* () {
          yield body;
        })(),
        destroy: () => undefined,
      };
    },
  });
  const verifier = createOidcVerifier(
    { ...GOOGLE, audiences: [AUD] },
    jwksFromSafeFetch(safeFetch),
    () => NOW,
  );
  assert.ok(verifier);
  assert.ok(await verifier.verify(token(k, {}), NONCE));
  assert.equal(seen[0]?.url, GOOGLE.jwksUri);
  assert.equal(
    Object.keys(seen[0]?.headers ?? {}).some((h) => /authorization|cookie/i.test(h)),
    false,
  );
  // a provider address that is not public is never fetched
  const blocked = createOidcVerifier(
    { ...GOOGLE, audiences: [AUD] },
    jwksFromSafeFetch(
      createSafeFetch({
        resolve: async () => [{ address: '10.0.0.5', family: 4 }],
        transport: async () => assert.fail('connected to a private address'),
      }),
    ),
    () => NOW,
  );
  assert.equal(await blocked?.verify(token(k, {}), NONCE), undefined);
});
