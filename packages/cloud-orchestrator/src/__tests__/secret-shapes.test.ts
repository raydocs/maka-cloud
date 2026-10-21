import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  scrubSecretFields,
  scrubSecretShapes,
  scrubValues,
  setKnownSecrets,
} from '../secret-shapes.js';

afterEach(() => setKnownSecrets([]));

const gone = (text: string, ...secrets: string[]): void => {
  const out = scrubSecretShapes(text);
  for (const secret of secrets) assert.ok(!out.includes(secret), `${secret} survived in ${out}`);
  assert.match(out, /\[secret\]/u, out);
};

test('secrets in a URL query string or fragment are removed, the rest of the URL stays', () => {
  const out = scrubSecretShapes(
    'GET https://api.example.com/v1/items?page=2&access_token=abc123DEF456&key=AIZ-9988-7766#id_token=eyJhbGciOi.xyz',
  );
  assert.equal(
    out,
    'GET https://api.example.com/v1/items?page=2&access_token=[secret]&key=[secret]#id_token=[secret]',
  );
  gone('https://x.test/dl?sig=0a1b2c3d4e5f&expires=9', '0a1b2c3d4e5f');
  gone('https://x.test/?api_key=sekrit-value-1&q=cats', 'sekrit-value-1');
});

test('an authorization header written as a list, an object or a pair loses its whole value', () => {
  gone('{"Authorization":["Bearer","tok-0123456789-abcdef"]}', 'tok-0123456789-abcdef');
  gone('{"headers":{"authorization":["Basic dXNlcjpwYXNz"]}}', 'dXNlcjpwYXNz');
  gone('{"scheme":"Basic","value":"dXNlcjpwYXNzd29yZA=="}', 'dXNlcjpwYXNzd29yZA');
  gone('{"value":"plain-credential-1234","scheme":"Bearer"}', 'plain-credential-1234');
  gone('{"name":"Authorization","value":"opaque-value-5678"}', 'opaque-value-5678');
  gone('[["Authorization","opaque-value-9012"]]', 'opaque-value-9012');
  gone('{"auth":{"token":{"v":"nested-secret-3456"}}}', 'nested-secret-3456');
  gone('{"cookie":"session=abcdef0123456789"}', 'abcdef0123456789');
});

test('JSON that was written into a string is read through its escapes', () => {
  gone(
    '"{\\"Authorization\\":[\\"Bearer\\",\\"tok-0123456789-abcdef\\"]}"',
    'tok-0123456789-abcdef',
  );
  gone("{'x-api-key': 'single-quoted-key-1'}", 'single-quoted-key-1');
});

test('the values this process holds are removed however they are written, and ordinary text stays', () => {
  const key = 'gw-live-Zk39/Qp+Lm20x';
  setKnownSecrets([key, 'short']);
  gone(`the gateway said no to ${key}`, key);
  gone(`GET /v1?x=${encodeURIComponent(key)}`, encodeURIComponent(key));
  gone(`{"detail":"${JSON.stringify(key).slice(1, -1)}"}`, key);
  gone(`Authorization: Basic ${Buffer.from(`user:${key}`).toString('base64')}`, 'dXNlcjpnd');
  // Too short to be told from a word.
  assert.equal(scrubSecretShapes('a short word'), 'a short word');
  setKnownSecrets([]);
  assert.equal(scrubSecretShapes(`still ${key}`), `still ${key}`);
});

test('ordinary text and data pass through', () => {
  for (const text of [
    'Token budget exceeded for the task',
    'GET https://example.com/search?q=cats&page=2',
    'the keyboard layout and the password reset email',
    '{"name":"Ada","value":"hello","scheme":"https"}',
    'Merge conflict in src/api-key.ts at 3f2a9c1',
  ]) {
    assert.equal(scrubSecretShapes(text), text);
  }
});

test('an object is scrubbed field by field before it is written out', () => {
  const out = scrubSecretFields({
    label: 'fetch https://x.test/?access_token=abc123DEF456',
    headers: { Authorization: ['Bearer', 'tok-0123456789'], accept: 'text/plain' },
    steps: [{ output: 'ok', token: 'xyz-98765' }],
    count: 3,
    none: null,
  });
  assert.deepEqual(out, {
    label: 'fetch https://x.test/?access_token=[secret]',
    headers: { Authorization: '[secret]', accept: 'text/plain' },
    steps: [{ output: 'ok', token: '[secret]' }],
    count: 3,
    none: null,
  });
});

test('scrubValues replaces a value of any length, in the forms a vendor echoes it, inside JSON strings too', () => {
  const key = 'a"b\\c/1';
  const quoted = JSON.stringify({ error: { message: `bad ${key}` } });
  assert.ok(!scrubValues(quoted, [key]).includes('a\\"b'), 'escaped for JSON');
  // The same key written with a unicode escape is only found by reading the JSON.
  const unicode = '{"message":"bad \\u0061\\"b\\\\c/1"}';
  assert.ok(!scrubValues(unicode, [key]).includes('\\u0061'), scrubValues(unicode, [key]));
  assert.equal(
    scrubValues(`https://u:${encodeURIComponent('p@s')}@h`, ['p@s']),
    'https://u:[secret]@h',
  );
  assert.equal(scrubValues('abc', ['b']), 'a[secret]c', 'there is no minimum length');
  assert.equal(scrubValues('abc', []), 'abc');
  assert.equal(scrubValues('abc', ['']), 'abc');
});

test('credential pairs are scrubbed when the JSON was serialised again inside a string, once or twice', () => {
  const basic = 'dXNlcjpwYXNzd29yZDEyMw==';
  const pairs = [
    { scheme: 'Basic', value: basic },
    { value: basic, type: 'Bearer' },
    { name: 'Authorization', value: basic },
  ];
  for (const pair of pairs) {
    const once = JSON.stringify(pair);
    for (const text of [once, JSON.stringify(once), JSON.stringify(JSON.stringify(once))]) {
      const out = scrubSecretShapes(`request failed: ${text}`);
      assert.ok(!out.includes(basic), `${text} -> ${out}`);
    }
  }
  const header = JSON.stringify(JSON.stringify(['Authorization', basic]));
  assert.ok(!scrubSecretShapes(header).includes(basic), scrubSecretShapes(header));
  // What is around them stays.
  assert.match(
    scrubSecretShapes(JSON.stringify(JSON.stringify({ scheme: 'Basic', value: basic, ok: 1 }))),
    /"ok\\":1|ok\\":1/u,
  );
});

test('an object keeps the link between a scheme or header name and its value', () => {
  const basic = 'dXNlcjpwYXNzd29yZDEyMw==';
  const out = scrubSecretFields({
    a: { scheme: 'Basic', value: basic },
    b: [{ name: 'X-Api-Key', value: basic }, ['Cookie', basic], { name: 'Accept', value: 'x' }],
  });
  assert.ok(!JSON.stringify(out).includes(basic), JSON.stringify(out));
  assert.match(JSON.stringify(out), /"value":"x"/u);
});
