import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger, createScrubber } from '../log.js';

const ENV = {
  ANTHROPIC_API_KEY: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  INSTABOX_API_KEY: 'ibx-live-0123456789',
  CLOUD_PUSH_VAPID_PRIVATE: 'wTq9PZkYvQ3p1m2L7yXr4nB8cDeFgHiJkLmNoPqRsTu',
  MAKA_GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  CUSTOM_PASSWORD: 'hunter2hunter2',
  MAKA_CLOUD_PORT: '8080',
};

function logger(extra: NodeJS.ProcessEnv = {}) {
  const lines: string[] = [];
  const log = createLogger({
    write: (line) => lines.push(line),
    env: { ...ENV, ...extra },
    now: () => Date.parse('2026-10-20T12:00:00Z'),
  });
  return { log, lines };
}

const parsed = (lines: string[]) =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>);

test('a log line is one JSON object with a time, a level and an event', () => {
  const { log, lines } = logger();
  log.info('listening', { port: 8080, secure: true, note: 'ready' });
  assert.equal(lines.length, 1);
  assert.deepEqual(parsed(lines)[0], {
    ts: '2026-10-20T12:00:00.000Z',
    level: 'info',
    event: 'listening',
    port: 8080,
    secure: true,
    note: 'ready',
  });
});

test('the values of secret-named environment variables never print, wherever they appear', () => {
  const { log, lines } = logger();
  for (const value of Object.entries(ENV)
    .filter(([name]) => name !== 'MAKA_CLOUD_PORT')
    .map(([, v]) => v)) {
    log.warn('request_failed', { message: `upstream said no to ${value} twice: ${value}` });
  }
  const text = lines.join('\n');
  for (const [name, value] of Object.entries(ENV)) {
    if (name === 'MAKA_CLOUD_PORT') continue;
    assert.ok(!text.includes(value), `${name} leaked`);
  }
  assert.match(text, /\[secret\]/u);
});

test('keys and tokens are removed by their shape even when the environment does not hold them', () => {
  const scrub = createScrubber({});
  const shapes = [
    'sk-proj-abcdefghijklmnop',
    'ghp_0123456789abcdefghij',
    'github_pat_11ABCDEFG0123456789_abc',
    'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
    'ibx-test-abcdef',
    'mkg_AbCdEfGhIjKlMnOp',
    'mki_inv_0123456789ab.AbCdEfGhIjKlMnOpQrStUvWxYz',
    'mko_ses_0123.AbCdEf',
    'AIzaSyA-1234567890123456789012345',
    'x-api-key: shhh-not-telling',
    'authorization="Basic dXNlcjpwYXNz"',
    'password=correct-horse',
    '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----',
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP',
  ];
  for (const shape of shapes) {
    const out = scrub(`while calling: ${shape} (done)`);
    assert.ok(out.includes('[secret]'), `not scrubbed: ${shape}`);
    for (const piece of shape
      .split(/[\s=:"]+/u)
      .filter((p) => p.length >= 12 && p !== 'authorization')) {
      assert.ok(!out.includes(piece), `kept ${piece}`);
    }
  }
  assert.equal(scrub('listening on port 8080'), 'listening on port 8080');
});

test('vendor and model names become "assistant", as in client-facing errors', () => {
  const { log, lines } = logger();
  log.error('run_failed', {
    message: 'claude-agent-sdk failed; Anthropic, OpenAI and Codex (gpt-5) said no, via Google',
  });
  const out = parsed(lines)[0]?.message as string;
  assert.doesNotMatch(out, /claude|anthropic|openai|codex|gpt|google/iu);
  assert.match(out, /assistant/u);
});

test('look-alike spellings do not get a vendor name past the scrubber', () => {
  const scrub = createScrubber({});
  assert.doesNotMatch(scrub('ＣＬＡＵＤＥ and An​thropic'), /claude|anthropic/iu);
});

test('an error prints its name and a code, never its message, stack or cause, unless the message is ours', () => {
  const { log, lines } = logger();
  const error = new Error(`fetch failed for key ${ENV.ANTHROPIC_API_KEY}`, {
    cause: new Error(ENV.INSTABOX_API_KEY),
  });
  log.warning('A gateway request failed', error);
  const line = lines[0] ?? '';
  assert.ok(!line.includes(ENV.ANTHROPIC_API_KEY));
  assert.ok(!line.includes(ENV.INSTABOX_API_KEY));
  assert.ok(!line.includes(' at '), 'no stack');
  const record = parsed(lines)[0];
  assert.equal(record?.event, 'warning');
  assert.equal(record?.level, 'warn');
  assert.match(String(record?.detail), /^Error\b/u);
  assert.ok(!String(record?.detail).includes('fetch failed'), 'the message is not printed');
});

test('private text in an error message does not print, and a message we wrote or the system wrote does', () => {
  const { log, lines } = logger();
  const PRIVATE = 'Dana asked me to send the quarterly numbers to her accountant';
  log.warning('model call failed', new Error(`upstream rejected: ${PRIVATE}`));
  log.warning('model call failed', new TypeError(PRIVATE));
  const withCode = Object.assign(new Error(PRIVATE), { code: 'ERR_SOMETHING', status: 503 });
  log.warning('with code', withCode);
  const sqlite = Object.assign(new Error(`near "${PRIVATE}": syntax error`), {
    errcode: 1,
    errstr: 'SQL logic error',
  });
  log.warning('db', sqlite);
  const system = Object.assign(new Error("ENOENT: no such file or directory, open '/var/x'"), {
    code: 'ENOENT',
    syscall: 'open',
    errno: -2,
  });
  log.warning('fs', system);
  class OurError extends Error {
    readonly safeToLog = true;
  }
  log.warning('ours', new OurError('The backup directory must not be inside the data directory'));
  const text = lines.join('\n');
  assert.ok(!text.includes(PRIVATE), 'no private text anywhere');
  const records = parsed(lines);
  assert.match(String(records[2]?.detail), /ERR_SOMETHING/u);
  assert.match(String(records[2]?.detail), /503/u);
  assert.match(String(records[3]?.detail), /SQL logic error/u);
  assert.match(String(records[4]?.detail), /ENOENT/u);
  assert.match(String(records[4]?.detail), /no such file/u);
  assert.match(String(records[5]?.detail), /must not be inside the data directory/u);
});

test('a detail object keeps only an allowlist of scalar fields: no endpoint, header, key or text', () => {
  const { log, lines } = logger();
  const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bHunCapabilityUrl';
  log.warning('push failed', {
    status: 503,
    code: 'EAI_AGAIN',
    endpoint: ENDPOINT,
    keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA', auth: 'tBHItJI5svbpez7KI4CCXg' },
    headers: { authorization: 'Bearer abc.def.ghi', 'x-api-key': ENV.ANTHROPIC_API_KEY },
    body: 'Dana asked me to send the quarterly numbers to her accountant',
    token: 123456789012,
  });
  log.warning('nested', { response: { status: 400, error: { message: 'private text' } } });
  const text = lines.join('\n');
  for (const leaked of [
    ENDPOINT,
    'fcm.googleapis.com',
    'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA',
    'tBHItJI5svbpez7KI4CCXg',
    'Bearer abc',
    ENV.ANTHROPIC_API_KEY,
    'quarterly numbers',
    '123456789012',
    'private text',
  ]) {
    assert.ok(!text.includes(leaked), `${leaked} leaked`);
  }
  assert.match(String(parsed(lines)[0]?.detail), /503/u);
  assert.match(String(parsed(lines)[0]?.detail), /EAI_AGAIN/u);
  const circular: Record<string, unknown> = { status: 500 };
  circular.self = circular;
  log.warning('circular', circular);
  assert.equal(parsed(lines).length, 3);
});

test('fields of any type are scrubbed: a number or object under a secret name, nested strings, arrays', () => {
  const { log, lines } = logger();
  const fields = {
    token: 123456789012,
    apiKey: { value: 'plain-looking' },
    password: true,
    session_secret: ['one', 'two'],
    request: {
      headers: { authorization: 'Bearer abcdefghijklmnop', accept: 'application/json' },
      note: `key ${ENV.ANTHROPIC_API_KEY} was used`,
      deeper: { deeper: { deeper: { deeper: { leaf: ENV.MAKA_GITHUB_TOKEN } } } },
    },
    list: [`a ${ENV.INSTABOX_API_KEY}`, { x: ENV.CUSTOM_PASSWORD }],
    count: 3,
    ok: true,
    nothing: null,
  } as unknown as Parameters<typeof log.info>[1];
  log.info('shapes', fields);
  const text = lines.join('\n');
  for (const leaked of [
    '123456789012',
    'plain-looking',
    'abcdefghijklmnop',
    ENV.ANTHROPIC_API_KEY,
    ENV.MAKA_GITHUB_TOKEN,
    ENV.INSTABOX_API_KEY,
    ENV.CUSTOM_PASSWORD,
    '"one"',
  ]) {
    assert.ok(!text.includes(leaked), `${leaked} leaked`);
  }
  const [record] = parsed(lines);
  assert.equal(record?.token, '[secret]');
  assert.equal(
    record?.invalid_field,
    '[secret]',
    'apiKey is not a plain field name, and is still hidden',
  );
  assert.equal(record?.password, '[secret]');
  assert.equal(record?.session_secret, '[secret]');
  assert.equal(record?.count, 3);
  assert.equal(record?.ok, true);
  assert.equal(record?.nothing, null);
  const request = record?.request as { headers: Record<string, unknown> };
  assert.equal(request.headers.authorization, '[secret]');
  assert.equal(request.headers.accept, 'application/json');
});

test('a number that is a secret value does not print, and values that cannot be printed do not throw', () => {
  const { log, lines } = logger({ DB_PASSWORD: '48151623420000' });
  const hostile = {
    toJSON() {
      throw new Error('no');
    },
  };
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  log.info('odd', {
    pin: 48151623420000,
    big: 10n,
    fn: () => 1,
    hostile,
    circular,
    many: Array.from({ length: 500 }, (_, i) => i),
  } as unknown as Parameters<typeof log.info>[1]);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0]?.includes('48151623420000'));
  assert.ok((lines[0]?.length ?? 0) < 5_000, 'a long list is cut');
});

test('a field named like a secret never prints its value, and names cannot forge the line', () => {
  const { log, lines } = logger();
  log.info('Bad Event!', {
    apiKey: 'x',
    api_token: 'plain-looking-value',
    level: 'error',
    ts: 'yesterday',
    'bad name': 'v',
  });
  const [record] = parsed(lines);
  assert.equal(record?.event, 'invalid_event');
  assert.equal(record?.level, 'info');
  assert.equal(record?.ts, '2026-10-20T12:00:00.000Z');
  assert.equal(record?.api_token, '[secret]');
  assert.equal(record?.field_level, 'error');
  assert.equal(record?.field_ts, 'yesterday');
  assert.ok(!('bad name' in (record ?? {})));
});

test('a long field is cut, and a newline in a value cannot make a second line', () => {
  const { log, lines } = logger();
  log.info('big', { text: `${'a b '.repeat(2_000)}` });
  log.info('multi', { text: 'one\ntwo\r\nthree' });
  assert.equal(lines.length, 2);
  assert.ok(String(parsed(lines)[0]?.text).length <= 1_001);
  assert.equal(lines[1]?.includes('\n'), false);
});
