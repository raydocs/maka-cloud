import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ENV_VARIABLES, readStackConfig } from '../config.js';
import { SMOKE_VARIABLES, smokeGate } from '../smoke.js';

const DOC = readFileSync(
  fileURLToPath(new URL('../../../../docs/fork/deploy.md', import.meta.url)),
  'utf8',
);

const table = (rows: ReadonlyArray<readonly [string, string]>): string =>
  [
    '| Variable | What it does |',
    '| --- | --- |',
    ...rows.map(([name, what]) => `| \`${name}\` | ${what.replaceAll('|', '\\|')} |`),
  ].join('\n');

const between = (start: string, end: string): string => {
  const from = DOC.indexOf(start);
  const to = DOC.indexOf(end);
  assert.ok(from >= 0 && to > from, `${start} … ${end} is in docs/fork/deploy.md`);
  return DOC.slice(from + start.length, to).trim();
};

test('the deploy doc lists every environment variable the server and the smoke test read, as the code words them', () => {
  assert.equal(
    between('<!-- env:start -->', '<!-- env:end -->'),
    table(ENV_VARIABLES),
    'paste the table from the code into docs/fork/deploy.md between the env markers',
  );
  assert.equal(
    between('<!-- smoke:start -->', '<!-- smoke:end -->'),
    table(SMOKE_VARIABLES),
    'paste the table from the code into docs/fork/deploy.md between the smoke markers',
  );
});

test('the commands the deploy doc runs exist', () => {
  for (const command of ['check', 'start', 'pause', 'resume', 'backups', 'backup', 'smoke']) {
    assert.match(DOC, new RegExp(`maka-cloud ${command}\\b|cli\\.js ${command}\\b`, 'u'), command);
  }
  assert.match(DOC, /maka-cloud restore <name>/u);
  for (const sub of ['invite create', 'invite limits', 'invite revoke']) {
    assert.ok(DOC.includes(sub), sub);
  }
  assert.ok(DOC.includes('/healthz'));
});

test('the examples in the deploy doc are accepted by the code that reads them', () => {
  const sandboxes = /^\s*MAKA_CLOUD_SANDBOXES='(.+)'$/mu.exec(DOC)?.[1];
  const mcp = /MAKA_CLOUD_MCP_PUBLIC_URL=(\S+)/u.exec(DOC)?.[1];
  const gateway = /MAKA_CLOUD_GATEWAY_PUBLIC_URL=([^\s`]+)/u.exec(DOC)?.[1];
  assert.ok(sandboxes && mcp && gateway, 'the doc shows all three');
  const config = readStackConfig({
    MAKA_CLOUD_DATA_DIR: '/var/lib/maka-cloud',
    MAKA_CLOUD_BACKUP_DIR: '/var/backups/maka-cloud',
    ANTHROPIC_API_KEY: 'placeholder',
    INSTABOX_API_KEY: 'placeholder',
    MAKA_CLOUD_SANDBOXES: sandboxes,
    MAKA_CLOUD_MCP_PUBLIC_URL: mcp,
    MAKA_CLOUD_GATEWAY_PUBLIC_URL: gateway,
  });
  assert.ok(Object.keys(config.sandboxes).length >= 2);
  assert.equal(config.mcp.publicUrl, mcp);
  assert.equal(config.gateway.publicUrl, gateway);
});

test('the smoke settings in the deploy doc pass the gate, and without the flag they do not', () => {
  const env: Record<string, string> = {};
  for (const line of DOC.split('\n')) {
    const found = /^# (MAKA_CLOUD_[A-Z_]+)=(.+)$/u.exec(line);
    if (found?.[1] && found[2]) {
      const value = found[2];
      env[found[1]] = value.startsWith("'") ? value.slice(1, -1) : value;
    }
  }
  env.MAKA_CLOUD_SMOKE_TOKEN = 'placeholder';
  const gate = smokeGate(env);
  assert.ok(gate.ok, gate.ok ? '' : gate.problems.join('; '));
  const { MAKA_CLOUD_LIVE: _live, ...withoutFlag } = env;
  assert.equal(smokeGate(withoutFlag).ok, false);
});

test('the deploy doc holds no key or token', () => {
  assert.doesNotMatch(
    DOC,
    /\bsk-[\w-]{8,}|\bgh[pousr]_\w{16,}|\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/u,
  );
});
