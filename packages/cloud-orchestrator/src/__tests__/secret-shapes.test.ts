import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  containsSecret,
  scrubReading,
  scrubSecretFields,
  scrubSecretShapes,
  scrubSecretText,
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
  setKnownSecrets([key]);
  gone(`the gateway said no to ${key}`, key);
  gone(`GET /v1?x=${encodeURIComponent(key)}`, encodeURIComponent(key));
  gone(`{"detail":"${JSON.stringify(key).slice(1, -1)}"}`, key);
  gone(`Authorization: Basic ${Buffer.from(`user:${key}`).toString('base64')}`, 'dXNlcjpnd');
  setKnownSecrets([]);
  assert.equal(scrubSecretShapes(`still ${key}`), `still ${key}`);
});

test('a short registered value is a key whatever it looks like; only a few characters are not', () => {
  setKnownSecrets(['hunter', '123456', 'a1b2', 'abc']);
  assert.equal(
    scrubSecretShapes('pw hunter and 123456 and a1b2'),
    'pw [secret] and [secret] and [secret]',
  );
  assert.equal(containsSecret({ question: 'Sign in with hunter?' }), true);
  assert.equal(scrubSecretShapes('the abc of it'), 'the abc of it');
});

test('a short registered key is removed too, in every form, and a blank one is not a key', () => {
  const short = 'p@ss/w?';
  setKnownSecrets([short, '  ', '']);
  gone(`the gateway said no to ${short}`, short);
  gone(`GET /v1?x=${encodeURIComponent(short)}`, encodeURIComponent(short));
  gone(`{"detail":"${JSON.stringify(short).slice(1, -1)}"}`, short);
  assert.equal(containsSecret({ ask: `use ${short}` }), true);
  assert.equal(scrubSecretShapes('a short word'), 'a short word');
  setKnownSecrets([]);
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

// -- recheck17 item 5, recheck18 item 1 ---------------------------------------------------------

const layers = (text: string, times: number): string => {
  let out = text;
  for (let i = 0; i < times; i++) out = JSON.stringify(out).slice(1, -1);
  return out;
};

test('a key with awkward characters is found through several layers of percent-encoding and JSON escaping, in any case of hex', () => {
  const key = 'p@ss/w?"q\\x';
  const once = encodeURIComponent(key);
  const twice = encodeURIComponent(once);
  const forms = [
    once,
    once.toLowerCase().replace(/%([0-9a-f]{2})/gu, (_, hex: string) => `%${hex}`),
    // Mixed case, escape by escape: the first lower, the second upper.
    once.replace(/%2F/u, '%2f'),
    twice,
    twice.replace(/%252F/u, '%252f'),
    layers(key, 1),
    layers(key, 2),
    layers(key, 3),
    layers(encodeURIComponent(key), 2),
    encodeURIComponent(layers(key, 2)),
  ];
  for (const form of forms) {
    assert.ok(
      !scrubValues(`Authorization failed for ${form} (401)`, [key]).includes(form),
      `leaked: ${form}`,
    );
  }
  setKnownSecrets([key]);
  try {
    for (const form of forms) {
      assert.ok(!scrubSecretShapes(`failed for ${form}`).includes(form), `leaked: ${form}`);
    }
  } finally {
    setKnownSecrets([]);
  }
  // Ordinary text that merely looks similar stays.
  assert.equal(scrubValues('p@ss and %40 and w?', [key]), 'p@ss and %40 and w?');
});

test('a credential serialised again and again is scrubbed whatever the order of its fields', () => {
  const secret = 'dXNlcjpwYXNzd29yZC12ZXJ5LXNlY3JldA==';
  const digest = 'username="u", realm="r", nonce="n", response="abcdef0123456789"';
  const values: unknown[] = [
    { name: 'Authorization', value: `Basic ${secret}` },
    { value: `Basic ${secret}`, name: 'Authorization' },
    { value: secret, scheme: 'Basic' },
    { scheme: 'Digest', value: digest },
    { value: digest, extra: { deeper: 1 }, scheme: 'Digest' },
    ['Authorization', `Basic ${secret}`],
  ];
  for (const value of values) {
    for (let times = 0; times <= 4; times++) {
      let text = JSON.stringify(value);
      for (let i = 0; i < times; i++) text = JSON.stringify({ body: text });
      const out = scrubSecretShapes(text);
      assert.ok(!out.includes(secret), `${times} layers, secret kept: ${out}`);
      assert.ok(!out.includes('abcdef0123456789'), `${times} layers, digest kept: ${out}`);
      assert.ok(!out.includes('nonce'), `${times} layers, digest half kept: ${out}`);
    }
    // Written inside a string field that is itself JSON, as a tool result that quotes a response.
    const inner = scrubSecretShapes(JSON.stringify({ result: JSON.stringify(value) }));
    assert.ok(!inner.includes(secret) && !inner.includes('abcdef0123456789'), inner);
  }
});

test('a text that is cut off in the middle of nested JSON still loses its credential', () => {
  const secret = 'dXNlcjpwYXNzd29yZC12ZXJ5LXNlY3JldA==';
  const text = JSON.stringify({
    body: JSON.stringify({ value: `Basic ${secret}`, name: 'Authorization' }),
  });
  for (const cut of [text.length, text.length - 3, text.length - 12]) {
    assert.ok(!scrubSecretShapes(text.slice(0, cut)).includes(secret), String(cut));
  }
  assert.equal(
    scrubSecretShapes('{"title":"fix the nonce","n":[1,2]}'),
    '{"title":"fix the nonce","n":[1,2]}',
  );
});

test('a long token followed by a lone percent sign or backslash is scrubbed in linear time', () => {
  for (const tail of ['!%', '\nbuild 100%', ' C:\\']) {
    const text = `${'a'.repeat(200_000)}${tail}`;
    const started = Date.now();
    scrubSecretShapes(text);
    assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms for ${tail}`);
  }
});

test('a long run of backslashes or of escaped quotes is scrubbed in linear time', () => {
  const runs = [
    '\\'.repeat(200_000),
    '\\"'.repeat(100_000),
    '"\\'.repeat(100_000),
    `'${'\\'.repeat(200_000)}`,
    `${'\\'.repeat(100_000)}"password`,
    `${'\\'.repeat(100_000)}"password"`,
    `${'\\\\"'.repeat(50_000)}x`,
  ];
  for (const text of runs) {
    for (const scrub of [scrubSecretShapes, scrubSecretText]) {
      const started = Date.now();
      scrub(text);
      assert.ok(
        Date.now() - started < 1500,
        `took ${Date.now() - started} ms for ${text.slice(0, 12)}`,
      );
    }
    const started = Date.now();
    containsSecret(text);
    assert.ok(Date.now() - started < 1500, `containsSecret took ${Date.now() - started} ms`);
  }
});

test('a long text of credential-like pairs without a brace is scrubbed in linear time', () => {
  for (const unit of [
    '"value":"x",',
    '"token":"[secret]",',
    '"scheme":"Basic",',
    '"name":"Authorization",',
  ]) {
    const text = unit.repeat(Math.ceil(240_000 / unit.length));
    for (const scrub of [scrubSecretShapes, scrubSecretText]) {
      const started = Date.now();
      scrub(text);
      assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms for ${unit}`);
    }
  }
});

test('a scheme and its credential are found when other fields sit between them, up to a bound', () => {
  const gap = (n: number) => `"x":"${'a'.repeat(n)}",`;
  // Not a JSON text as a whole (a log line with a piece of one), so only the patterns read it.
  const pair = (n: number) => `sent "scheme":"Basic",${gap(n)}"value":"dXNlcjpwYXNzd29yZA==" ok`;
  assert.ok(!scrubSecretShapes(pair(100)).includes('dXNlcjpwYXNzd29yZA'));
  assert.ok(!scrubSecretShapes(pair(400)).includes('dXNlcjpwYXNzd29yZA'));
  // Known limit: with more than 512 characters of other fields between the two, the pair is not
  // recognised by its shape (a JSON text that parses is read field by field instead, and a registered secret is still found).
  assert.ok(scrubSecretShapes(pair(2000)).includes('dXNlcjpwYXNzd29yZA'));
});

test('known limit: a secret field whose quote follows a lone backslash is no longer read as one', () => {
  // Well-formed JSON never writes a key right after a backslash; text that does (a Windows path
  // printed before a field) was matched before the pattern started only at the start of a run.
  assert.ok(scrubSecretShapes('C:\\"token":"abc12345"').includes('abc12345'));
});

test('JSON nested past the stack is not read as JSON and does not throw', () => {
  const deep = `${'['.repeat(6000)}${']'.repeat(6000)}`;
  assert.doesNotThrow(() => scrubSecretShapes(deep));
  assert.equal(
    scrubSecretShapes(`${deep} Authorization: Bearer abcdefgh12345678`).includes(
      'abcdefgh12345678',
    ),
    false,
  );
});

test('a key split by a character that shows nothing is still found, whichever the character', () => {
  const key = 'abc12345SECRETkey';
  setKnownSecrets([key]);
  for (const mark of [
    '\u034f',
    '\ufe0f',
    '\u180b',
    '\u3164',
    '\u{e0100}',
    '\u0301',
    '\u200b',
    '\u00ad',
  ]) {
    const split = `abc12345${mark}SECRETkey`;
    assert.ok(
      !scrubSecretText(`here: ${split}`).includes('SECRETkey'),
      `U+${mark.codePointAt(0)?.toString(16)} survived`,
    );
    assert.equal(
      containsSecret({ ask: split }),
      true,
      `U+${mark.codePointAt(0)?.toString(16)} not found`,
    );
  }
  // A mark that would compose with the letter before it (c and an acute make ć) is found too.
  setKnownSecrets(['abcDEF12345key']);
  for (const split of ['abc\u0301DEF12345key', 'abcDEF12345ke\u0308y', 'a\u0300bcDEF12345key']) {
    assert.ok(!scrubSecretText(`here: ${split}`).includes('12345'), JSON.stringify(split));
    assert.equal(containsSecret({ ask: split }), true, JSON.stringify(split));
  }
  // The shape of a token the same way: nothing of its tail is left showing.
  assert.ok(!scrubSecretText('sk-abcdefgh\u034fijklmnop').includes('ijklmnop'));
  // Text with nothing in it is not rewritten.
  assert.equal(
    scrubSecretText('na\u0308ive e\u0301 \u{1F468}\u200d\u{1F469}'),
    'na\u0308ive e\u0301 \u{1F468}\u200d\u{1F469}',
  );
});

test('text of scripts that are written with combining marks is shown as written, with or without a secret in it', () => {
  const hindi = 'किताब में पुस्तक है';
  const thai = 'สวัสดีครับ';
  const arabic = 'مُحَمَّد';
  const emoji = '❤️ 1️⃣';
  for (const text of [hindi, thai, arabic, emoji]) {
    assert.equal(scrubReading(text, scrubSecretShapes), text);
    assert.equal(scrubSecretText(text), text);
  }
  setKnownSecrets(['abc12345SECRETkey']);
  assert.equal(scrubSecretText(`${hindi} abc12345́SECRETkey ${thai}`), `${hindi} [secret] ${thai}`);
  // A secret with marks of its own script inside it is found too, at the price of those marks.
  setKnownSecrets(['पुस्तक-secret-9']);
  assert.equal(scrubSecretText('x पुस्‍तक-secret-9 y'), 'x [secret] y');
});
