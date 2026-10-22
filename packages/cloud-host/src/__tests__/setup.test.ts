import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { InviteStore } from '@maka-cloud/server';
import { readStackConfig } from '../config.js';
import {
  answerProblems,
  generateVapidKeys,
  parseEnvFile,
  planSetup,
  renderEnvFile,
  runSetup,
  type SetupIO,
} from '../setup.js';

const KEYS = {
  ANTHROPIC_API_KEY: 'sk-ant-setup-test-0123456789',
  OPENAI_API_KEY: 'sk-openai-setup-test-0123456789',
  INSTABOX_API_KEY: 'ibk_setup_test_0123456789',
  MAKA_GITHUB_TOKEN: 'github_pat_setuptest0123456789',
};

function workspace(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'maka-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dataDir: dir,
    envFile: join(dir, 'maka-cloud.env'),
    composeEnvFile: join(dir, 'maka-cloud.compose.env'),
  };
}

/** Records what the wizard says; answers questions from a script, in order. */
function scripted(answers: string[] = []) {
  const said: string[] = [];
  const asked: { question: string; secret: boolean }[] = [];
  const io: SetupIO = {
    ask: async (question, options = {}) => {
      asked.push({ question, secret: options.secret === true });
      const next = answers.shift();
      if (next === undefined) throw new Error(`no scripted answer for ${question}`);
      return next;
    },
    say: (line) => said.push(line),
  };
  return { io, said, asked };
}

/** Every vendor answers yes, and the machine exists. */
const allOk: typeof fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('/v1/machines/')) {
    return Response.json({ id: 'm_owner', status: 'running' });
  }
  return Response.json({ data: [] });
};

const fromEnv = (extra: Record<string, string> = {}) => ({
  ...KEYS,
  MAKA_CLOUD_SETUP_DOMAIN: 'Example.com',
  MAKA_CLOUD_SETUP_MACHINE: 'm_owner',
  ...extra,
});

test('setup --from-env writes both files private, and the server starts from them', async (t) => {
  const ws = workspace(t);
  const { io, said } = scripted();
  const code = await runSetup({
    ...ws,
    env: fromEnv(),
    fromEnv: true,
    verify: true,
    io,
    fetch: allOk,
  });
  assert.equal(code, 0, said.join('\n'));
  for (const file of [ws.envFile, ws.composeEnvFile]) {
    assert.equal(statSync(file).mode & 0o777, 0o600, file);
  }
  const server = parseEnvFile(readFileSync(ws.envFile, 'utf8'));
  const config = readStackConfig({
    ...Object.fromEntries(server),
    MAKA_CLOUD_DATA_DIR: ws.dataDir,
  });
  const owner = server.get('MAKA_CLOUD_OWNER_INVITE') as string;
  assert.deepEqual(config.sandboxes, { [owner]: 'm_owner' });
  assert.equal(config.mcp.publicUrl, 'https://mcp.example.com/mcp');
  assert.equal(config.gateway.publicUrl, 'https://models.example.com');
  assert.deepEqual(config.agentChannel, { user: 'maka-agent', group: 'maka-box' });
  assert.equal(config.pushSet, true);
  assert.deepEqual(config.spendAlert, { usd: 5, ownerInvite: owner });
  assert.deepEqual(
    config.inbox.verifierModels.map((entry) => `${entry.vendor}:${entry.model}`),
    ['anthropic:claude-sonnet-5-5', 'openai:gpt-6.1-sol'],
  );
  assert.equal(config.githubTokenProblem, undefined);
  assert.equal(config.openAiKeySet, true);

  const compose = parseEnvFile(readFileSync(ws.composeEnvFile, 'utf8'));
  assert.deepEqual(Object.fromEntries(compose), {
    MAKA_CLOUD_APP_NAME: 'app.example.com',
    MAKA_CLOUD_MCP_NAME: 'mcp.example.com',
    MAKA_CLOUD_MODELS_NAME: 'models.example.com',
  });

  const store = new InviteStore(join(ws.dataDir, 'invites.db'));
  try {
    const invites = store.list();
    assert.equal(invites.length, 1);
    assert.equal(invites[0]?.inviteId, owner);
    const tokenLine = said.find((line) => line.startsWith('Your sign-in token'));
    assert.ok(tokenLine, 'the token is shown once');
    const token = tokenLine.split(': ').at(-1) as string;
    assert.equal(store.resolve(token)?.inviteId, owner);
  } finally {
    store.close();
  }

  // Nothing the wizard said holds a key.
  const transcript = said.join('\n');
  for (const key of Object.values(KEYS)) assert.ok(!transcript.includes(key));
  assert.ok(!transcript.includes(server.get('CLOUD_PUSH_VAPID_PRIVATE') as string));
});

test('run again, setup keeps the invite, the push keys and settings it does not own', async (t) => {
  const ws = workspace(t);
  const first = scripted();
  assert.equal(
    await runSetup({ ...ws, env: fromEnv(), fromEnv: true, verify: false, io: first.io }),
    0,
  );
  const before = parseEnvFile(readFileSync(ws.envFile, 'utf8'));
  writeFileSync(
    ws.envFile,
    `${readFileSync(ws.envFile, 'utf8')}MAKA_CLOUD_TASK_RUN_HOURS=6\nMAKA_CLOUD_SPEND_ALERT_USD=12\n`,
  );

  const second = scripted();
  const env = fromEnv({ MAKA_CLOUD_SETUP_DOMAIN: 'other.org', OPENAI_API_KEY: '' });
  assert.equal(await runSetup({ ...ws, env, fromEnv: true, verify: false, io: second.io }), 0);
  const after = parseEnvFile(readFileSync(ws.envFile, 'utf8'));
  assert.equal(after.get('MAKA_CLOUD_OWNER_INVITE'), before.get('MAKA_CLOUD_OWNER_INVITE'));
  assert.equal(after.get('CLOUD_PUSH_VAPID_PRIVATE'), before.get('CLOUD_PUSH_VAPID_PRIVATE'));
  assert.equal(after.get('MAKA_CLOUD_TASK_RUN_HOURS'), '6');
  assert.equal(after.get('MAKA_CLOUD_SPEND_ALERT_USD'), '12');
  assert.equal(after.get('MAKA_CLOUD_MCP_PUBLIC_URL'), 'https://mcp.other.org/mcp');
  // The key left out is removed, and with it the model that would need it.
  assert.equal(after.has('OPENAI_API_KEY'), false);
  assert.ok(!after.get('MAKA_CLOUD_VERIFIER_MODELS')?.includes('openai'));
  assert.ok(second.said.some((line) => line.includes('is kept; its token still signs you in')));
  assert.ok(!second.said.some((line) => line.startsWith('Your sign-in token')));
});

test('a key the vendor refuses stops setup before anything is written or any invite made', async (t) => {
  const ws = workspace(t);
  const refusing: typeof fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('anthropic')) return new Response('{}', { status: 401 });
    return allOk(input);
  };
  const { io, said } = scripted();
  const code = await runSetup({
    ...ws,
    env: fromEnv(),
    fromEnv: true,
    verify: true,
    io,
    fetch: refusing,
  });
  assert.equal(code, 2);
  assert.ok(said.some((line) => line.includes('refused: the Anthropic API key')));
  assert.equal(existsSync(ws.envFile), false);
  assert.equal(existsSync(join(ws.dataDir, 'invites.db')), false);
});

test('a service that cannot be reached is reported and does not stop setup', async (t) => {
  const ws = workspace(t);
  const offline: typeof fetch = async () => {
    throw new TypeError('fetch failed');
  };
  const { io, said } = scripted();
  const code = await runSetup({
    ...ws,
    env: fromEnv(),
    fromEnv: true,
    verify: true,
    io,
    fetch: offline,
  });
  assert.equal(code, 0, said.join('\n'));
  assert.ok(said.some((line) => line.startsWith('  not checked, could not reach the service')));
});

test('setup --from-env names every missing setting, and a classic GitHub token is refused', async (t) => {
  const ws = workspace(t);
  const missing = scripted();
  assert.equal(await runSetup({ ...ws, env: {}, fromEnv: true, verify: false, io: missing.io }), 2);
  for (const name of [
    'MAKA_CLOUD_SETUP_DOMAIN',
    'ANTHROPIC_API_KEY',
    'INSTABOX_API_KEY',
    'MAKA_CLOUD_SETUP_MACHINE',
  ]) {
    assert.ok(missing.said.includes(`${name} is not set`), name);
  }
  const classic = scripted();
  const env = fromEnv({ MAKA_GITHUB_TOKEN: 'ghp_classic0123456789' });
  assert.equal(await runSetup({ ...ws, env, fromEnv: true, verify: false, io: classic.io }), 2);
  assert.ok(classic.said.some((line) => line.includes('not a fine-grained token')));
  assert.equal(existsSync(ws.envFile), false);
});

test('the interactive wizard asks for keys without echo and re-asks what it cannot use', async (t) => {
  const ws = workspace(t);
  const { io, asked, said } = scripted([
    'not a domain',
    'example.com',
    '', // Anthropic: required, asked again
    KEYS.ANTHROPIC_API_KEY,
    '', // OpenAI: skipped
    KEYS.INSTABOX_API_KEY,
    'ghp_classic0123456789', // refused, asked again
    '', // GitHub: skipped
    'm_owner',
    '', // contact: skipped
  ]);
  const code = await runSetup({ ...ws, env: {}, fromEnv: false, verify: false, io });
  assert.equal(code, 0, said.join('\n'));
  const secret = asked.filter((entry) => entry.secret).map((entry) => entry.question);
  assert.ok(secret.every((question) => /key|token/iu.test(question)));
  assert.equal(secret.length, 6);
  assert.ok(
    asked.filter((entry) => !entry.secret).every((entry) => !/key|token/iu.test(entry.question)),
  );
  assert.ok(said.some((line) => line.includes('no review from a second vendor')));
  const server = parseEnvFile(readFileSync(ws.envFile, 'utf8'));
  assert.equal(server.has('OPENAI_API_KEY'), false);
  assert.equal(server.has('MAKA_GITHUB_TOKEN'), false);
  assert.equal(server.get('CLOUD_PUSH_SUBJECT'), 'https://app.example.com');
});

test('the env file reads back as written, JSON and all', () => {
  const entries = new Map([
    ['A', 'plain'],
    ['MAKA_CLOUD_SANDBOXES', '{"inv_0123456789ab":"m_1"}'],
    ['B', 'has space'],
  ]);
  const text = renderEnvFile(entries, ['header']);
  assert.match(text, /^# header\n/u);
  assert.match(text, /MAKA_CLOUD_SANDBOXES='\{"inv_0123456789ab":"m_1"\}'/u);
  assert.deepEqual(parseEnvFile(text), entries);
  assert.throws(() => renderEnvFile(new Map([['X', "it's"]]), []), /single quote/u);
  assert.throws(() => renderEnvFile(new Map([['X', 'a\nb']]), []), /one line/u);
});

test('the owner machine leaves another invite it was mapped to: one machine per invite', () => {
  const planned = planSetup({
    answers: {
      domain: 'example.com',
      anthropicKey: KEYS.ANTHROPIC_API_KEY,
      instaboxKey: KEYS.INSTABOX_API_KEY,
      machine: 'm_owner',
    },
    ownerInvite: 'inv_aaaaaaaaaaaa',
    existing: {
      server: new Map([
        ['MAKA_CLOUD_SANDBOXES', '{"inv_bbbbbbbbbbbb":"m_owner","inv_cccccccccccc":"m_other"}'],
      ]),
    },
    vapid: generateVapidKeys,
  });
  assert.deepEqual(JSON.parse(planned.server.get('MAKA_CLOUD_SANDBOXES') as string), {
    inv_cccccccccccc: 'm_other',
    inv_aaaaaaaaaaaa: 'm_owner',
  });
});

test('checkers the operator chose are kept, unless they need a key that is gone', () => {
  const answers = {
    domain: 'localhost',
    anthropicKey: KEYS.ANTHROPIC_API_KEY,
    instaboxKey: KEYS.INSTABOX_API_KEY,
    machine: 'm_owner',
  };
  const plan = (chosen: string) =>
    planSetup({
      answers,
      ownerInvite: 'inv_aaaaaaaaaaaa',
      existing: { server: new Map([['MAKA_CLOUD_VERIFIER_MODELS', chosen]]) },
      vapid: generateVapidKeys,
    }).server.get('MAKA_CLOUD_VERIFIER_MODELS');
  assert.equal(plan('[]'), '[]');
  const openAiOnly =
    '[{"vendor":"openai","model":"gpt-x","inputPerMTokUsd":1,"outputPerMTokUsd":1}]';
  assert.ok(!plan(openAiOnly)?.includes('"openai"'));
  assert.deepEqual(answerProblems(answers), []);
});

test('values are read as Compose and systemd read them: escapes, comments, broken quotes', () => {
  const read = parseEnvFile(
    [
      'MAKA_CLOUD_SANDBOXES="{\\"inv_aaaaaaaaaaaa\\":\\"m_a\\"}"',
      'ANTHROPIC_API_KEY=sk-example # production',
      "SINGLE='a # b'",
      'export EXPORTED=yes',
      'BROKEN="never closed',
      'OCTAL="maka\\055agent"',
      'HEX="a\\x2db\\u00e9\\tc"',
      'UNKNOWN="keep\\qthis"',
      'BYTES="caf\\xc3\\xa9 \\303\\251"',
    ].join('\n'),
  );
  assert.equal(read.get('MAKA_CLOUD_SANDBOXES'), '{"inv_aaaaaaaaaaaa":"m_a"}');
  assert.equal(read.get('ANTHROPIC_API_KEY'), 'sk-example');
  assert.equal(read.get('SINGLE'), 'a # b');
  assert.equal(read.get('EXPORTED'), 'yes');
  assert.equal(read.has('BROKEN'), false);
  assert.equal(read.get('OCTAL'), 'maka-agent');
  assert.equal(read.get('HEX'), 'a-b\u00e9\tc');
  assert.equal(read.get('UNKNOWN'), 'keep\\qthis');
  assert.equal(read.get('BYTES'), 'caf\u00e9 \u00e9');
});

test('when the settings cannot be written, the new invite is revoked and the old file kept', async (t) => {
  const ws = workspace(t);
  const { io, said } = scripted();
  const code = await runSetup({
    ...ws,
    composeEnvFile: join(ws.dataDir, 'missing', 'names.env'),
    env: fromEnv(),
    fromEnv: true,
    verify: false,
    io,
  });
  assert.equal(code, 2);
  assert.ok(said.some((line) => line.startsWith('The settings could not be written')));
  assert.ok(!said.some((line) => line.startsWith('Your sign-in token')));
  assert.equal(existsSync(ws.envFile), false);
  const store = new InviteStore(join(ws.dataDir, 'invites.db'));
  try {
    assert.deepEqual(
      store.list().map((invite) => invite.revokedAt !== null),
      [true],
    );
  } finally {
    store.close();
  }
});
