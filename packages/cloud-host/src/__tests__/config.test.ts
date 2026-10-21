import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DEFAULT_MODES, EFFORTS, MODEL_ID as MODES_MODEL_ID } from '@maka-cloud/modes';
import { EFFORT_LEVELS, MODEL_ID as RUNNERS_MODEL_ID } from '@maka-cloud/runners';
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
  // A repository belongs to one invite and one installation: naming it twice is refused.
  assert.ok(
    problemsOf({
      ...ENV,
      MAKA_GITHUB_WEBHOOK_SECRET: DUTY_SECRET,
      MAKA_CLOUD_DUTY_REPOS: `acme/widgets@7=${INVITE_A},ACME/Widgets@7=${INVITE_B}`,
    }).some((p) => /names acme\/widgets more than once/.test(p)),
  );
});

test('the spend alert needs an amount, the owner’s invite and Web Push, and says what is missing', () => {
  const push = {
    CLOUD_PUSH_VAPID_PUBLIC: 'public',
    CLOUD_PUSH_VAPID_PRIVATE: 'private-key-value',
    CLOUD_PUSH_SUBJECT: 'mailto:ops@example.test',
  };
  const good = {
    ...ENV,
    ...push,
    MAKA_CLOUD_SPEND_ALERT_USD: '12.5',
    MAKA_CLOUD_OWNER_INVITE: 'inv_0123456789ab',
  };
  assert.deepEqual(readStackConfig(good).spendAlert, {
    usd: 12.5,
    ownerInvite: 'inv_0123456789ab',
  });
  assert.equal(readStackConfig(ENV).spendAlert, undefined);
  const problem = (env: NodeJS.ProcessEnv): string =>
    problemsOf(env)
      .filter((text) => /SPEND_ALERT|OWNER_INVITE/u.test(text))
      .join(' | ');
  assert.match(problem({ ...good, MAKA_CLOUD_OWNER_INVITE: undefined }), /go together/u);
  assert.match(problem({ ...good, MAKA_CLOUD_SPEND_ALERT_USD: undefined }), /go together/u);
  for (const bad of ['0', '-1', '1e3', 'ten', '100001', '']) {
    if (bad === '') continue;
    assert.match(problem({ ...good, MAKA_CLOUD_SPEND_ALERT_USD: bad }), /above 0/u, bad);
  }
  for (const bad of ['owner', 'inv_123', 'INV_0123456789AB', 'inv_0123456789abc']) {
    assert.match(problem({ ...good, MAKA_CLOUD_OWNER_INVITE: bad }), /invite id/u, bad);
  }
  const {
    CLOUD_PUSH_VAPID_PUBLIC: _a,
    CLOUD_PUSH_VAPID_PRIVATE: _b,
    CLOUD_PUSH_SUBJECT: _c,
    ...noPush
  } = good;
  assert.match(problem(noPush), /needs Web Push/u);
});

const DUTY_SECRET = 'a-webhook-secret-of-sufficient-length';
const INVITE_A = 'inv_00000000000a';
const INVITE_B = 'inv_00000000000b';

test('standing duties are off without a webhook secret, and the data layout names their database', () => {
  const config = readStackConfig(ENV);
  assert.equal(config.dutiesSet, false);
  assert.deepEqual(config.dutyLinks, []);
  assert.equal(config.dutiesDbPath, '/srv/maka/duties.db');
  assert.match(describeConfig(config).join('\n'), /standing duties:\s+off/);
});

test('standing duties need a long enough secret and a list of repositories, and no message prints the secret', () => {
  const on = readStackConfig({
    ...ENV,
    MAKA_GITHUB_WEBHOOK_SECRET: DUTY_SECRET,
    MAKA_CLOUD_DUTY_REPOS: `Acme/Widgets@7=${INVITE_A}, acme/gadgets@9=${INVITE_B}`,
  });
  assert.equal(on.dutiesSet, true);
  assert.deepEqual(on.dutyLinks, [
    { repo: 'acme/widgets', installationId: 7, inviteId: INVITE_A },
    { repo: 'acme/gadgets', installationId: 9, inviteId: INVITE_B },
  ]);
  const printed = describeConfig(on).join('\n');
  assert.match(
    printed,
    /standing duties:\s+on, projects may be registered for acme\/widgets, acme\/gadgets/,
  );
  assert.ok(!printed.includes(DUTY_SECRET));

  const secretOnly = readStackConfig({ ...ENV, MAKA_GITHUB_WEBHOOK_SECRET: DUTY_SECRET });
  assert.equal(secretOnly.dutiesSet, true);
  assert.deepEqual(
    secretOnly.dutyLinks,
    [],
    'no repository is allowed until the operator names one',
  );
  assert.match(describeConfig(secretOnly).join('\n'), /no repository yet/);

  const short = problemsOf({ ...ENV, MAKA_GITHUB_WEBHOOK_SECRET: 'too-short' });
  assert.ok(short.some((p) => /MAKA_GITHUB_WEBHOOK_SECRET must be at least 16/.test(p)));
  assert.ok(!short.join('\n').includes('too-short'));
  assert.ok(
    problemsOf({ ...ENV, MAKA_CLOUD_DUTY_REPOS: `acme/widgets@7=${INVITE_A}` }).some((p) =>
      /needs MAKA_GITHUB_WEBHOOK_SECRET/.test(p),
    ),
  );
  for (const bad of [
    'acme/widgets',
    `widgets@7=${INVITE_A}`,
    `acme/@7=${INVITE_A}`,
    `a/b/c@7=${INVITE_A}`,
    `acme/wid gets@7=${INVITE_A}`,
    `../x/y@7=${INVITE_A}`,
    `acme/widgets@7=${INVITE_A},`,
    `acme/widgets@0=${INVITE_A}`,
    `acme/widgets@-1=${INVITE_A}`,
    `acme/widgets@7x=${INVITE_A}`,
    'acme/widgets@7=',
    'acme/widgets@7=inv_xyz',
    'acme/widgets@7=someone',
  ]) {
    assert.ok(
      problemsOf({
        ...ENV,
        MAKA_GITHUB_WEBHOOK_SECRET: DUTY_SECRET,
        MAKA_CLOUD_DUTY_REPOS: bad,
      }).some((p) => /comma separated owner\/name@<installation id>=<invite id>/.test(p)),
      bad,
    );
  }
});

test('the modes default to the built-in ones, and the built-in ones are priced by the gateway', () => {
  assert.deepEqual(readStackConfig(ENV).modes, DEFAULT_MODES);
  assert.match(describeConfig(readStackConfig(ENV)).join('\n'), /modes: +quick, standard, deep/);
});

test('MAKA_CLOUD_MODES replaces the modes, and a Codex model it names needs a gateway price', () => {
  const modes = structuredClone(DEFAULT_MODES);
  modes.modes.deep.reviewer.codex = { model: 'codex-test', effort: 'high' };
  const price = {
    vendor: 'openai',
    model: 'codex-test',
    inputPerMTokUsd: 1,
    outputPerMTokUsd: 10,
    maxOutputTokens: 9_000,
  };
  const config = readStackConfig({
    ...ENV,
    MAKA_CLOUD_MODES: JSON.stringify(modes),
    MAKA_CLOUD_GATEWAY_MODELS: JSON.stringify([price]),
  });
  assert.deepEqual(config.modes, modes);
  assert.deepEqual(problemsOf({ ...ENV, MAKA_CLOUD_MODES: JSON.stringify(modes) }), [
    'MAKA_CLOUD_MODES names the openai model "codex-test", which the gateway has no price for: add it to MAKA_CLOUD_GATEWAY_MODELS',
  ]);
});

test('a MAKA_CLOUD_MODES that is not JSON, of another version or not the schema is refused, never half read', () => {
  assert.deepEqual(problemsOf({ ...ENV, MAKA_CLOUD_MODES: '{' }), [
    'MAKA_CLOUD_MODES config: not valid JSON',
  ]);
  assert.match(
    problemsOf({ ...ENV, MAKA_CLOUD_MODES: JSON.stringify({ ...DEFAULT_MODES, version: 2 }) }).join(
      '\n',
    ),
    /MAKA_CLOUD_MODES version/,
  );
  assert.match(
    problemsOf({ ...ENV, MAKA_CLOUD_MODES: JSON.stringify({ version: 1, modes: {} }) }).join('\n'),
    /MAKA_CLOUD_MODES modes\.quick/,
  );
});

test('the modes package and the runners agree on the efforts and the model ids a run may carry', () => {
  assert.deepEqual([...EFFORTS], [...EFFORT_LEVELS]);
  assert.equal(MODES_MODEL_ID.source, RUNNERS_MODEL_ID.source);
  assert.equal(MODES_MODEL_ID.flags, RUNNERS_MODEL_ID.flags);
});

test('"modes" prints the modes in force as JSON that MAKA_CLOUD_MODES accepts', async () => {
  const { stdout } = await run(process.execPath, [CLI, 'modes'], { env: {} });
  assert.deepEqual(JSON.parse(stdout), DEFAULT_MODES);
  const edited = structuredClone(DEFAULT_MODES);
  edited.modes.quick.budget.defaultRunUsd = 3;
  const again = await run(process.execPath, [CLI, 'modes'], {
    env: { MAKA_CLOUD_MODES: JSON.stringify(edited) },
  });
  assert.deepEqual(JSON.parse(again.stdout), edited);
  await assert.rejects(
    run(process.execPath, [CLI, 'modes'], { env: { MAKA_CLOUD_MODES: '{' } }),
    (error: unknown) => {
      const failed = error as { code: number; stderr: string };
      assert.equal(failed.code, 2);
      assert.match(failed.stderr, /MAKA_CLOUD_MODES/);
      return true;
    },
  );
});

test('Claude runs through the Agent SDK only when its account and group are both set, and as plain names', () => {
  assert.equal(readStackConfig(ENV).agentChannel, undefined);
  assert.deepEqual(
    readStackConfig({ ...ENV, MAKA_CLOUD_AGENT_USER: 'maka-agent', MAKA_CLOUD_AGENT_GROUP: 'maka' })
      .agentChannel,
    { user: 'maka-agent', group: 'maka' },
  );
  const problem = (env: NodeJS.ProcessEnv): string =>
    problemsOf({ ...ENV, ...env })
      .filter((text) => /AGENT_/u.test(text))
      .join(' | ');
  assert.match(problem({ MAKA_CLOUD_AGENT_USER: 'maka-agent' }), /go together/u);
  assert.match(problem({ MAKA_CLOUD_AGENT_GROUP: 'maka' }), /go together/u);
  for (const bad of ['root user', 'a;b', 'Agent', '../x', '-u']) {
    assert.match(
      problem({ MAKA_CLOUD_AGENT_USER: bad, MAKA_CLOUD_AGENT_GROUP: 'maka' }),
      /Unsafe agent channel user/u,
      bad,
    );
  }
  assert.ok(ENV_VARIABLES.some(([name]) => name === 'MAKA_CLOUD_AGENT_USER'));
  assert.match(describeConfig(readStackConfig(ENV)).join('\n'), /Claude runs: +directly/u);
});

test('the limits of one task default to no turn limit and 4 hours, and take only plain positive numbers', () => {
  assert.deepEqual(readStackConfig(ENV).taskLimits, { runMs: 4 * 3_600_000 });
  assert.deepEqual(
    readStackConfig({ ...ENV, MAKA_CLOUD_TASK_TURN_USD: '1.5', MAKA_CLOUD_TASK_RUN_HOURS: '0.5' })
      .taskLimits,
    { turnUsd: 1.5, runMs: 1_800_000 },
  );
  const problem = (env: NodeJS.ProcessEnv): string =>
    problemsOf({ ...ENV, ...env })
      .filter((text) => /TASK_/u.test(text))
      .join(' | ');
  for (const bad of ['0', '-1', 'ten', '1e3', '100001']) {
    assert.match(problem({ MAKA_CLOUD_TASK_TURN_USD: bad }), /TURN_USD must be/u, bad);
  }
  for (const bad of ['0', '-1', 'four', '169']) {
    assert.match(problem({ MAKA_CLOUD_TASK_RUN_HOURS: bad }), /RUN_HOURS must be/u, bad);
  }
  assert.match(
    describeConfig(readStackConfig(ENV)).join('\n'),
    /task limits: +no limit per turn, 4 h of run time/u,
  );
});

test('timeline content is off unless the owner sets 1, and anything else but 0 is refused', () => {
  assert.equal(readStackConfig(ENV).timelineContent, false);
  assert.equal(
    readStackConfig({ ...ENV, MAKA_CLOUD_TIMELINE_CONTENT: '0' }).timelineContent,
    false,
  );
  assert.equal(readStackConfig({ ...ENV, MAKA_CLOUD_TIMELINE_CONTENT: '1' }).timelineContent, true);
  for (const bad of ['true', 'yes', '2', 'on']) {
    assert.match(
      problemsOf({ ...ENV, MAKA_CLOUD_TIMELINE_CONTENT: bad }).join(' | '),
      /TIMELINE_CONTENT must be 1 or 0/u,
      bad,
    );
  }
});

test('a key too short for the scrubber to know is refused at start, naming the variable and never its value', () => {
  for (const name of [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'DEEPSEEK_API_KEY',
    'INSTABOX_API_KEY',
    'CLOUD_PUSH_VAPID_PRIVATE',
    'MAKA_GITHUB_TOKEN',
  ]) {
    const problems = problemsOf({ ...ENV, [name]: 'abc123' });
    assert.ok(
      problems.includes(`${name} is too short to be a key (at least 8 characters)`),
      problems.join('\n'),
    );
    assert.ok(!problems.join('\n').includes('abc123'));
    // Long enough, it is no longer refused for its length (other settings may still be missing).
    const longer = problemsOf({ ...ENV, [name]: 'abc12345', MAKA_CLOUD_PORT: 'x' });
    assert.ok(!longer.some((problem) => problem.includes('too short')), longer.join('\n'));
  }
});

const POOL_ENV = (() => {
  const { MAKA_CLOUD_SANDBOXES: _fixed, ...rest } = ENV;
  return { ...rest, MAKA_CLOUD_BOXES: '1', MAKA_CLOUD_BOX_TEMPLATE: 'tpl_node' };
})();

test('MAKA_CLOUD_BOXES=1 with a template asks for the pool, three boxes per invite by default', () => {
  const config = readStackConfig(POOL_ENV);
  assert.deepEqual(config.boxes, { templateId: 'tpl_node', maxPerInvite: 3 });
  assert.deepEqual(config.sandboxes, {});
  assert.deepEqual(readStackConfig({ ...POOL_ENV, MAKA_CLOUD_BOX_MAX: '5' }).boxes, {
    templateId: 'tpl_node',
    maxPerInvite: 5,
  });
  assert.equal(readStackConfig(ENV).boxes, undefined, 'the fixed machines stay the default');
  assert.ok(describeConfig(config).some((line) => line.includes('up to 3 per invite')));
});

test('the pool needs its template, refuses a bad size, and is not mixed with fixed machines', () => {
  const { MAKA_CLOUD_BOX_TEMPLATE: _template, ...noTemplate } = POOL_ENV;
  assert.deepEqual(problemsOf(noTemplate), ['MAKA_CLOUD_BOX_TEMPLATE is not set']);
  assert.deepEqual(problemsOf({ ...POOL_ENV, MAKA_CLOUD_BOX_TEMPLATE: 'a b' }), [
    'MAKA_CLOUD_BOX_TEMPLATE is not a template id',
  ]);
  for (const bad of ['0', '6', '2.5', 'many', '-1']) {
    assert.deepEqual(problemsOf({ ...POOL_ENV, MAKA_CLOUD_BOX_MAX: bad }), [
      'MAKA_CLOUD_BOX_MAX must be a whole number from 1 to 5',
    ]);
  }
  assert.deepEqual(problemsOf({ ...POOL_ENV, MAKA_CLOUD_BOXES: 'yes' }), [
    'MAKA_CLOUD_BOXES must be 1, or unset',
  ]);
  assert.deepEqual(problemsOf({ ...POOL_ENV, MAKA_CLOUD_SANDBOXES: ENV.MAKA_CLOUD_SANDBOXES }), [
    'MAKA_CLOUD_BOXES=1 and MAKA_CLOUD_SANDBOXES are both set: use one of them',
  ]);
});

test('settings of the pool without the switch are an error, not ignored', () => {
  assert.deepEqual(problemsOf({ ...ENV, MAKA_CLOUD_BOX_TEMPLATE: 'tpl_node' }), [
    'MAKA_CLOUD_BOX_TEMPLATE and MAKA_CLOUD_BOX_MAX need MAKA_CLOUD_BOXES=1',
  ]);
  assert.deepEqual(problemsOf({ ...ENV, MAKA_CLOUD_BOX_MAX: '2' }), [
    'MAKA_CLOUD_BOX_TEMPLATE and MAKA_CLOUD_BOX_MAX need MAKA_CLOUD_BOXES=1',
  ]);
});
