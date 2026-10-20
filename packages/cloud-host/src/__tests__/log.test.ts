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

test('an error prints its name and message only, scrubbed, with no stack or cause', () => {
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
  assert.match(String(record?.detail), /^Error: fetch failed for key \[secret\]$/u);
});

test('a detail object is printed as scrubbed JSON, and one that cannot be printed does not throw', () => {
  const { log, lines } = logger();
  log.warning('detail', { token: ENV.MAKA_GITHUB_TOKEN, nested: { key: ENV.ANTHROPIC_API_KEY } });
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  log.warning('circular', circular);
  const text = lines.join('\n');
  assert.ok(!text.includes(ENV.MAKA_GITHUB_TOKEN));
  assert.ok(!text.includes(ENV.ANTHROPIC_API_KEY));
  assert.equal(parsed(lines).length, 2);
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
