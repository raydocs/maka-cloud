import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INSTALL_OUTPUT_HELD, InstallOutput } from '../install-output.js';

const BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj';

const blocks = [
  ['PEM', '-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----'],
  ['RSA', '-----BEGIN RSA PRIVATE KEY-----', '-----END RSA PRIVATE KEY-----'],
  ['OpenSSH', '-----BEGIN OPENSSH PRIVATE KEY-----', '-----END OPENSSH PRIVATE KEY-----'],
  ['PGP', '-----BEGIN PGP PRIVATE KEY BLOCK-----', '-----END PGP PRIVATE KEY BLOCK-----'],
] as const;

for (const [name, begin, end] of blocks) {
  test(`a ${name} key block is not kept whatever size it has or how it is cut into chunks`, () => {
    for (const size of [3, 40_000, INSTALL_OUTPUT_HELD + 5_000]) {
      const out = new InstallOutput();
      const lines = Math.max(1, Math.floor(size / 65));
      const text = `npm ERR! reading the key\n${begin}\n${`${BODY}\n`.repeat(lines)}${end}\nnpm ERR! retry number 7\n`;
      // The same text in chunks that cut every marker and line.
      for (let at = 0; at < text.length; at += 37) out.push(text.slice(at, at + 37));
      const tail = out.tail();
      assert.ok(!tail.includes(BODY.slice(0, 20)), `${size}: ${tail}`);
      assert.match(tail, /retry number 7/u);
      assert.match(tail, /npm ERR! reading the key/u);
    }
  });
}

test('a key block with one very long line (no line break at all) past the cap is still dropped', () => {
  const out = new InstallOutput();
  out.push('before\n-----BEGIN PRIVATE KEY-----\n');
  for (let sent = 0; sent < INSTALL_OUTPUT_HELD * 2; sent += 100_000) out.push(BODY.repeat(1_500));
  out.push('\n-----END PRIVATE KEY-----\nafter the key\n');
  const tail = out.tail();
  assert.ok(!tail.includes(BODY.slice(0, 20)), tail.slice(0, 200));
  assert.match(tail, /after the key/u);
  assert.match(tail, /before/u);
});

test('a block that never ends is never shown, and a key line that ends in the same line is left to the scrubber', () => {
  const open = new InstallOutput();
  open.push(`log\n-----BEGIN PGP PRIVATE KEY BLOCK-----\n${BODY}\n${BODY}`);
  assert.ok(!open.tail().includes(BODY.slice(0, 20)));
  const oneLine = new InstallOutput();
  oneLine.push(`x -----BEGIN PRIVATE KEY-----${BODY}-----END PRIVATE KEY----- y\n`);
  assert.ok(!oneLine.tail().includes(BODY.slice(0, 20)));
});

test('a secret whose name ends one line and whose value starts the next is scrubbed', () => {
  const out = new InstallOutput();
  out.push('{"password":\n');
  out.push('  "correct-horse-battery-staple"\n');
  out.push('}\nnpm ERR! failed\n');
  const tail = out.tail();
  assert.ok(!tail.includes('correct-horse-battery-staple'), tail);
  assert.match(tail, /failed/u);
});

test('a token cut in two by the chunks is scrubbed, and ordinary output is left alone', () => {
  const out = new InstallOutput();
  out.push('npm ERR! auth failed for ghp_');
  out.push('abcdefghijklmnopqrstuvwxyz0123456789 on the registry\n');
  out.push('added 12 packages in 2s\n');
  const tail = out.tail();
  assert.ok(!tail.includes('abcdefghijklmnop'), tail);
  assert.match(tail, /added 12 packages in 2s/u);
});

test('a secret field whose value runs past a line longer than the window keeps its value out', () => {
  // The certificate line alone is more than the window, so the lines in front of it (the secret
  // field's name among them) are gone by the time the tail is scrubbed, and the key after it is not.
  const certificate = `MIIDdzCCAl+gAwIBAgIEAgAAuTANBgkqhkiG9w0BAQUFADBaMQswCQYDVQQGEwJJ${'RTESMBAGA1UEChMJQmFsdGltb3Jl'.repeat(1_100)}`;
  const text = [
    'npm ERR! the client settings were',
    'npm ERR! {',
    'npm ERR!   "credentials": {',
    `npm ERR!     "certificate": "${certificate}",`,
    'npm ERR!     "key": "kq7-held-back-value-0193"',
    'npm ERR!   },',
    'npm ERR!   "registry": "https://registry.npmjs.org/"',
    'npm ERR! }',
    'npm ERR! install failed',
    '',
  ].join('\n');
  assert.ok(certificate.length > 24_000);
  for (const size of [37, 4_096, text.length]) {
    const out = new InstallOutput();
    for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
    const tail = out.tail();
    assert.ok(!tail.includes('kq7-held-back-value'), `${size}: ${tail.slice(-300)}`);
    assert.match(tail, /install failed/u);
    assert.match(tail, /registry\.npmjs\.org/u);
  }
});

test('a secret field whose value starts on the next line is held back the same way', () => {
  const certificate = 'QmFsdGltb3JlQ3liZXJUcnVzdFJvb3Q'.repeat(1_000);
  const out = new InstallOutput();
  out.push('{"secret":\n');
  out.push(`  {"cert": "${certificate}",\n`);
  out.push('   "key": "kq7-held-back-value-0194"}}\n');
  out.push('npm ERR! install failed\n');
  const tail = out.tail();
  assert.ok(!tail.includes('kq7-held-back-value'), tail.slice(-300));
  assert.match(tail, /install failed/u);
});
