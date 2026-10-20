import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ConfigError, describeConfig, ENV_VARIABLES, readStackConfig } from '../config.js';

const ENV = {
  MAKA_CLOUD_DATA_DIR: '/srv/maka',
  ANTHROPIC_API_KEY: 'sk-secret-anthropic',
  INSTABOX_API_KEY: 'ibx-secret-instabox',
  MAKA_CLOUD_SANDBOXES: JSON.stringify({ inv_000000000001: 'mch_1' }),
};

function problemsOf(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    readStackConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.problems;
  }
  assert.fail('expected a ConfigError');
}

test('the minimal environment gives the data layout and the defaults', () => {
  const config = readStackConfig(ENV);
  assert.equal(config.dbPath, '/srv/maka/cloud.db');
  assert.equal(config.invitesPath, '/srv/maka/invites.db');
  assert.equal(config.handoffRoot, '/srv/maka/handoff');
  assert.equal(config.conductorRoot, '/srv/maka/conductor');
  assert.equal(config.runnerSessionsPath, '/srv/maka/runner-sessions.json');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8080);
  assert.deepEqual(config.mcp, { host: '127.0.0.1', port: 8081 });
  assert.deepEqual(config.conductor, {});
  assert.deepEqual(config.instabox, {});
  assert.deepEqual(config.sandboxes, { inv_000000000001: 'mch_1' });
  assert.equal(config.openAiKeySet, false);
  assert.equal(config.searchKeySet, false);
  assert.match(config.githubTokenProblem ?? '', /MAKA_GITHUB_TOKEN is not set/);
});

test('only a fine-grained MAKA_GITHUB_TOKEN can open pull requests, and GITHUB_TOKEN is ignored', () => {
  assert.equal(
    readStackConfig({ ...ENV, MAKA_GITHUB_TOKEN: 'github_pat_secret' }).githubTokenProblem,
    undefined,
  );
  assert.match(
    readStackConfig({ ...ENV, MAKA_GITHUB_TOKEN: 'ghp_secret' }).githubTokenProblem ?? '',
    /not a fine-grained token/,
  );
  assert.match(
    readStackConfig({ ...ENV, GITHUB_TOKEN: 'github_pat_secret' }).githubTokenProblem ?? '',
    /MAKA_GITHUB_TOKEN is not set/,
  );
});

test('optional settings are read', () => {
  const config = readStackConfig({
    ...ENV,
    MAKA_CLOUD_HOST: '0.0.0.0',
    MAKA_CLOUD_PORT: '9000',
    MAKA_CLOUD_MCP_HOST: '0.0.0.0',
    MAKA_CLOUD_MCP_PORT: '9001',
    MAKA_CLOUD_MCP_PUBLIC_URL: 'https://mcp.example.test/mcp',
    ANTHROPIC_BASE_URL: 'https://gateway.example.test',
    MAKA_CLOUD_LLM_CONNECTION_ID: 'conn-prod',
    INSTABOX_API_URL: 'https://sandbox.example.test',
    OPENAI_API_KEY: 'sk-secret-openai',
    DEEPSEEK_API_KEY: 'sk-secret-search',
    DEEPSEEK_BASE_URL: 'https://search.example.test',
  });
  assert.equal(config.searchKeySet, true);
  assert.equal(config.gateway.searchBaseUrl, 'https://search.example.test');
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 9000);
  assert.deepEqual(config.mcp, {
    host: '0.0.0.0',
    port: 9001,
    publicUrl: 'https://mcp.example.test/mcp',
  });
  assert.deepEqual(config.conductor, { connectionId: 'conn-prod' });
  assert.equal(config.gateway.anthropicBaseUrl, 'https://gateway.example.test');
  assert.deepEqual(config.instabox, { apiUrl: 'https://sandbox.example.test' });
  assert.equal(config.openAiKeySet, true);
});

test('the config the stack passes on carries no key, so only the gateway reads one', () => {
  const env = {
    ...ENV,
    OPENAI_API_KEY: 'sk-secret-openai',
    DEEPSEEK_API_KEY: 'sk-secret-search',
  };
  const serialized = JSON.stringify(readStackConfig(env));
  for (const name of [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'DEEPSEEK_API_KEY',
    'INSTABOX_API_KEY',
  ]) {
    assert.ok(!serialized.includes(env[name as keyof typeof env]), `${name} is not in the config`);
  }
});

test('every missing required variable is reported at once', () => {
  assert.deepEqual(problemsOf({ MAKA_CLOUD_DATA_DIR: '  ' }), [
    'MAKA_CLOUD_DATA_DIR is not set',
    'ANTHROPIC_API_KEY is not set',
    'INSTABOX_API_KEY is not set',
    'MAKA_CLOUD_SANDBOXES is not set',
  ]);
});

test('bad ports and URLs are refused', () => {
  assert.deepEqual(
    problemsOf({
      ...ENV,
      MAKA_CLOUD_PORT: '80a',
      MAKA_CLOUD_MCP_PORT: '70000',
      MAKA_CLOUD_MCP_PUBLIC_URL: 'ftp://mcp.example.test',
      ANTHROPIC_BASE_URL: 'not a url',
      INSTABOX_API_URL: 'https://user:pass@sandbox.example.test',
    }),
    [
      'MAKA_CLOUD_PORT must be a port number from 1 to 65535',
      'MAKA_CLOUD_MCP_PORT must be a port number from 1 to 65535',
      'MAKA_CLOUD_MCP_PUBLIC_URL must be an http or https URL',
      'ANTHROPIC_BASE_URL is not a URL',
      'INSTABOX_API_URL must not carry credentials',
    ],
  );
  assert.deepEqual(problemsOf({ ...ENV, MAKA_CLOUD_PORT: '9000', MAKA_CLOUD_MCP_PORT: '9000' }), [
    'MAKA_CLOUD_PORT and MAKA_CLOUD_MCP_PORT must differ',
  ]);
});

test('the model gateway listens on the host by default, and its settings are checked', () => {
  assert.deepEqual(readStackConfig(ENV).gateway, { host: '127.0.0.1', port: 8082, models: [] });
  const codex = {
    vendor: 'openai',
    model: 'codex-test',
    inputPerMTokUsd: 1,
    outputPerMTokUsd: 10,
    maxOutputTokens: 9_000,
  };
  assert.deepEqual(
    readStackConfig({
      ...ENV,
      ANTHROPIC_BASE_URL: 'https://anthropic.example.test',
      OPENAI_BASE_URL: 'https://openai.example.test/v1',
      MAKA_CLOUD_GATEWAY_HOST: '10.0.0.2',
      MAKA_CLOUD_GATEWAY_PORT: '9002',
      MAKA_CLOUD_GATEWAY_PUBLIC_URL: 'https://models.example.test',
      MAKA_CLOUD_GATEWAY_MODELS: JSON.stringify([codex]),
    }).gateway,
    {
      host: '10.0.0.2',
      port: 9002,
      publicUrl: 'https://models.example.test',
      models: [codex],
      anthropicBaseUrl: 'https://anthropic.example.test',
      openAiBaseUrl: 'https://openai.example.test/v1',
    },
  );
  assert.equal(
    readStackConfig({ ...ENV, MAKA_CLOUD_GATEWAY_PUBLIC_URL: 'http://127.0.0.1:8082' }).gateway
      .publicUrl,
    'http://127.0.0.1:8082',
    'plain http only on a loopback host',
  );
  assert.deepEqual(
    problemsOf({
      ...ENV,
      MAKA_CLOUD_GATEWAY_PORT: '8081',
      MAKA_CLOUD_GATEWAY_PUBLIC_URL: 'http://models.example.test',
      MAKA_CLOUD_GATEWAY_MODELS: JSON.stringify([{ ...codex, maxOutputTokens: 0 }, 'opus']),
    }),
    [
      'MAKA_CLOUD_GATEWAY_MODELS entry 1: maxOutputTokens must be a positive whole number',
      'MAKA_CLOUD_GATEWAY_MODELS entry 2: must be an object',
      'MAKA_CLOUD_GATEWAY_PUBLIC_URL must be https, except on a loopback host',
      'MAKA_CLOUD_GATEWAY_PORT and MAKA_CLOUD_MCP_PORT must differ',
    ],
  );
  assert.deepEqual(problemsOf({ ...ENV, MAKA_CLOUD_GATEWAY_MODELS: '{' }), [
    'MAKA_CLOUD_GATEWAY_MODELS is not JSON',
  ]);
});

test('the printed configuration carries no secret value', () => {
  const lines = describeConfig(
    readStackConfig({
      ...ENV,
      OPENAI_API_KEY: 'sk-secret-openai',
      DEEPSEEK_API_KEY: 'sk-secret-search',
    }),
  ).join('\n');
  assert.doesNotMatch(lines, /secret/);
  assert.match(lines, /Codex runner key: +set/);
});

const CLI = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'cli.js');
const run = promisify(execFile);

test('"check" prints the configuration without secrets and starts nothing', async () => {
  const { stdout, stderr } = await run(process.execPath, [CLI, 'check'], { env: ENV });
  assert.match(stdout, /data directory: +\/srv\/maka/);
  assert.doesNotMatch(stdout + stderr, /secret/);
  assert.doesNotMatch(stdout, /listening/);
});

test('a missing variable or an unknown command exits with 2 and says why', async () => {
  await assert.rejects(run(process.execPath, [CLI, 'start'], { env: {} }), (error: unknown) => {
    const failed = error as { code: number; stderr: string };
    assert.equal(failed.code, 2);
    assert.match(failed.stderr, /MAKA_CLOUD_DATA_DIR is not set/);
    assert.match(failed.stderr, /MAKA_CLOUD_SANDBOXES is not set/);
    return true;
  });
  await assert.rejects(run(process.execPath, [CLI, 'serve'], { env: ENV }), (error: unknown) => {
    const failed = error as { code: number; stderr: string };
    assert.equal(failed.code, 2);
    assert.match(failed.stderr, /Usage:/);
    return true;
  });
});

const PUSH_ENV = {
  CLOUD_PUSH_VAPID_PUBLIC: 'public-key-value',
  CLOUD_PUSH_VAPID_PRIVATE: 'sk-secret-vapid-private',
  CLOUD_PUSH_SUBJECT: 'mailto:ops@example.test',
};

test('Web Push is off unless all three VAPID settings are set', () => {
  assert.equal(readStackConfig(ENV).pushSet, false);
  assert.equal(readStackConfig({ ...ENV, ...PUSH_ENV }).pushSet, true);
});

test('a partial Web Push setting is refused, naming the missing variable and no secret', () => {
  const problems = problemsOf({ ...ENV, CLOUD_PUSH_VAPID_PRIVATE: 'sk-secret-vapid-private' });
  const problem = problems.find((p) => p.includes('CLOUD_PUSH_'));
  assert.ok(problem, problems.join('; '));
  assert.match(problem, /CLOUD_PUSH_VAPID_PUBLIC/);
  assert.match(problem, /CLOUD_PUSH_SUBJECT/);
  assert.ok(!problems.join('\n').includes('sk-secret-vapid-private'));
});

test('the usage text lists the Web Push variables, and the summary never prints the key', () => {
  assert.ok(ENV_VARIABLES.some(([name]) => name === 'CLOUD_PUSH_VAPID_PRIVATE'));
  const lines = describeConfig(readStackConfig({ ...ENV, ...PUSH_ENV })).join('\n');
  assert.match(lines, /Web Push:\s+on/);
  assert.ok(!lines.includes('sk-secret-vapid-private'));
  assert.ok(!lines.includes('public-key-value'));
});

test('each invite gets its own machine: a shared, empty, malformed or legacy setting is refused', () => {
  const sandboxes = (value: unknown): readonly string[] =>
    problemsOf({ ...ENV, MAKA_CLOUD_SANDBOXES: JSON.stringify(value) });
  assert.deepEqual(
    readStackConfig({
      ...ENV,
      MAKA_CLOUD_SANDBOXES: JSON.stringify({ inv_aaaaaaaaaaaa: 'm_a', inv_bbbbbbbbbbbb: 'm_b' }),
    }).sandboxes,
    { inv_aaaaaaaaaaaa: 'm_a', inv_bbbbbbbbbbbb: 'm_b' },
  );
  assert.deepEqual(sandboxes({ inv_aaaaaaaaaaaa: 'm_a', inv_bbbbbbbbbbbb: 'm_a' }), [
    'MAKA_CLOUD_SANDBOXES: inv_bbbbbbbbbbbb and inv_aaaaaaaaaaaa share a machine',
  ]);
  assert.deepEqual(sandboxes({}), ['MAKA_CLOUD_SANDBOXES has no entry']);
  assert.deepEqual(sandboxes([]), ['MAKA_CLOUD_SANDBOXES must be a JSON object']);
  assert.deepEqual(sandboxes({ default: 'm_a' }), [
    'MAKA_CLOUD_SANDBOXES: a key is not an invite id (inv_ and 12 hex digits)',
  ]);
  assert.deepEqual(sandboxes({ inv_aaaaaaaaaaaa: '' }), [
    'MAKA_CLOUD_SANDBOXES: the machine of inv_aaaaaaaaaaaa is not a machine id',
  ]);
  assert.deepEqual(problemsOf({ ...ENV, MAKA_CLOUD_SANDBOXES: '{' }), [
    'MAKA_CLOUD_SANDBOXES is not JSON',
  ]);
  // The old single-machine variable would put every invite on one machine: it stops the start.
  assert.match(
    problemsOf({ ...ENV, INSTABOX_MACHINE_ID: 'mch_1' }).join('\n'),
    /INSTABOX_MACHINE_ID is no longer used/,
  );
});

test('a caller with no invites reads the single-machine setting instead', () => {
  const { MAKA_CLOUD_SANDBOXES: _sandboxes, ...base } = ENV;
  assert.deepEqual(problemsOf(base), ['MAKA_CLOUD_SANDBOXES is not set']);
  const config = readStackConfig(
    { ...base, INSTABOX_MACHINE_ID: 'mch_1' },
    { sandboxes: 'single-machine' },
  );
  assert.deepEqual(config.sandboxes, {});
  assert.throws(
    () => readStackConfig(base, { sandboxes: 'single-machine' }),
    (error: unknown) =>
      error instanceof ConfigError && error.problems.includes('INSTABOX_MACHINE_ID is not set'),
  );
});

test('spend limits are small unless the environment raises them, and a bad number stops the start', () => {
  const defaults = readStackConfig(ENV).spend;
  assert.deepEqual(defaults, { inviteDailyUsd: 5, inviteMonthlyUsd: 50, serverDailyUsd: 25 });
  assert.match(describeConfig(readStackConfig(ENV)).join('\n'), /invite \$5\/day and \$50\/month/u);

  const raised = readStackConfig({
    ...ENV,
    MAKA_CLOUD_INVITE_DAILY_USD: '12.5',
    MAKA_CLOUD_INVITE_MONTHLY_USD: '100',
    MAKA_CLOUD_SERVER_DAILY_USD: '0',
  }).spend;
  assert.deepEqual(raised, { inviteDailyUsd: 12.5, inviteMonthlyUsd: 100, serverDailyUsd: 0 });

  for (const name of [
    'MAKA_CLOUD_INVITE_DAILY_USD',
    'MAKA_CLOUD_INVITE_MONTHLY_USD',
    'MAKA_CLOUD_SERVER_DAILY_USD',
  ]) {
    for (const bad of ['-1', 'abc', '1e3', '1,5', '999999999']) {
      assert.match(
        problemsOf({ ...ENV, [name]: bad }).join('\n'),
        new RegExp(`${name} must be`, 'u'),
      );
    }
  }
  const names = ENV_VARIABLES.map(([name]) => name);
  for (const name of [
    'MAKA_CLOUD_INVITE_DAILY_USD',
    'MAKA_CLOUD_INVITE_MONTHLY_USD',
    'MAKA_CLOUD_SERVER_DAILY_USD',
  ]) {
    assert.ok((names as string[]).includes(name), `${name} is in the usage text`);
  }
});

test('the backup directory is optional, absolute and apart from the data directory', () => {
  assert.equal(readStackConfig(ENV).backupDir, undefined);
  assert.equal(
    readStackConfig({ ...ENV, MAKA_CLOUD_BACKUP_DIR: '/srv/backups' }).backupDir,
    '/srv/backups',
  );
  for (const bad of ['backups', '/srv/maka', '/srv/maka/backups', '/srv', '/']) {
    assert.ok(
      problemsOf({ ...ENV, MAKA_CLOUD_BACKUP_DIR: bad }).some((problem) =>
        problem.startsWith('MAKA_CLOUD_BACKUP_DIR'),
      ),
      bad,
    );
  }
});
