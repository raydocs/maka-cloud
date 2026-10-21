import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { API_KEY, collect, MCP_TOKEN, notes, setup, terminal } from './harness.js';

const MANIFEST = {
  summary: 'fake run complete',
  done: ['the brief'],
  notDone: [],
  confidence: 'high',
  knownIssues: [],
};

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path)));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

test('claude runner: runs the CLI in the sandbox, reports progress, hands the result back', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const spec = await h.spec('tsk_claude1');
  const events = await collect(await h.runners.claude.start(spec));

  assert.equal(terminal(events)?.type, 'finished');
  assert.deepEqual(JSON.parse(await fs.readFile(spec.resultPath, 'utf8')), MANIFEST);
  const progress = notes(events);
  assert.ok(progress.includes('working on it'));
  assert.ok(progress.includes('tool: Bash'));
  assert.ok(progress.some((note) => /^snapshot sn_\d+ saved$/.test(note)));

  const { argv } = await h.cliCall('claude', 1);
  assert.equal(argv[0], '-p');
  for (const [flag, value] of [
    ['--output-format', 'stream-json'],
    ['--permission-mode', 'bypassPermissions'],
    ['--setting-sources', 'project,local'],
  ] as const) {
    assert.equal(argv[argv.indexOf(flag) + 1], value);
  }
  assert.ok(argv.includes('--verbose'));
  assert.ok(!argv.includes('--resume'));
  assert.ok(!argv.includes('--mcp-config'), 'no MCP endpoint was given');
  assert.equal((await h.sessions.get('tsk_claude1'))?.sessionId, 'sess-1');

  // The sandbox user did the work: nothing went through the root-privileged file API.
  assert.equal(h.fake.requestsTo('GET', /\/files$/).length, 0);
  // The lease that keeps the sandbox awake and the model access are released at the end.
  assert.equal(h.fake.leases.size, 0);
  assert.ok(h.fake.requestsTo('PUT', /activity-leases/).length >= 1);
  assert.deepEqual(h.revoked, ['tsk_claude1']);
});

test('codex runner: exec --json with API-key login forced and the MCP token read from the environment', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const spec = await h.spec('tsk_codex1', {
    runner: 'codex',
    mcp: { url: 'http://127.0.0.1:4100/mcp', token: MCP_TOKEN },
  });
  const events = await collect(await h.runners.codex.start(spec));

  assert.equal(terminal(events)?.type, 'finished');
  assert.deepEqual(JSON.parse(await fs.readFile(spec.resultPath, 'utf8')), MANIFEST);
  assert.ok(notes(events).includes('run: ls'));
  assert.ok(notes(events).includes('working on it'));

  const { argv } = await h.cliCall('codex', 1);
  assert.deepEqual(argv.slice(0, 3), ['exec', '--json', '--skip-git-repo-check']);
  const configs = argv.flatMap((arg, i) => (argv[i - 1] === '-c' ? [arg] : []));
  for (const expected of [
    'forced_login_method="api"',
    'approval_policy="never"',
    'sandbox_mode="danger-full-access"',
    'openai_base_url="https://gateway.test/v1"',
    'mcp_servers.maka.url="http://orchestrator.internal:4100/mcp"',
    'mcp_servers.maka.bearer_token_env_var="MAKA_MCP_TOKEN"',
  ]) {
    assert.ok(configs.includes(expected), `missing -c ${expected}`);
  }
  assert.equal((await h.sessions.get('tsk_codex1'))?.sessionId, 'thr-1');
});

test('secrets travel in the CLI environment only: not in argv, files, or reported notes', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const spec = await h.spec('tsk_secrets', {
    mcp: { url: 'http://127.0.0.1:4100/mcp', token: MCP_TOKEN },
  });
  const events = await collect(await h.runners.claude.start(spec));
  assert.equal(terminal(events)?.type, 'finished');

  const { argv, env } = await h.cliCall('claude', 1);
  assert.match(env, new RegExp(`^MAKA_MCP_TOKEN=${MCP_TOKEN}$`, 'm'));
  assert.match(env, new RegExp(`^ANTHROPIC_API_KEY=${API_KEY}$`, 'm'));
  assert.match(env, /^ANTHROPIC_BASE_URL=https:\/\/gateway\.test\/v1$/m);
  const joined = argv.join('\n');
  assert.ok(!joined.includes(MCP_TOKEN) && !joined.includes(API_KEY));

  const config = JSON.parse(argv[argv.indexOf('--mcp-config') + 1] ?? '{}');
  assert.equal(config.mcpServers.maka.url, 'http://orchestrator.internal:4100/mcp');
  assert.equal(config.mcpServers.maka.headers.Authorization, 'Bearer ${MAKA_MCP_TOKEN}');
  assert.ok(argv.includes('--strict-mcp-config'));

  for (const file of await filesUnder(h.root)) {
    const text = await fs.readFile(file, 'utf8');
    assert.ok(!text.includes(MCP_TOKEN) && !text.includes(API_KEY), `secret written to ${file}`);
  }
  for (const note of notes(events)) assert.ok(!note.includes(MCP_TOKEN) && !note.includes(API_KEY));
});

test('a secret that a CLI prints is redacted from the notes and the failure reason', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('leakfail');
  const spec = await h.spec('tsk_leak');
  const events = await collect(await h.runners.claude.start(spec));
  const failure = terminal(events);
  assert.equal(failure?.type, 'failed');
  const reported = JSON.stringify(events);
  assert.ok(!reported.includes(API_KEY));
  assert.match(failure?.type === 'failed' ? failure.reason : '', /key is \[redacted\]/);
});

test('no subscription login: a login found in the sandbox stops the run before the CLI starts', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await fs.mkdir(join(h.home, '.claude'), { recursive: true });
  await fs.writeFile(join(h.home, '.claude', '.credentials.json'), '{}');
  const claudeEvents = await collect(await h.runners.claude.start(await h.spec('tsk_login1')));
  const failure = terminal(claudeEvents);
  assert.equal(failure?.type, 'failed');
  assert.match(failure?.type === 'failed' ? failure.reason : '', /subscription login/);
  assert.equal(await h.cliCalls('claude'), 0);

  await fs.rm(join(h.home, '.claude'), { recursive: true });
  await fs.writeFile(join(h.home, '.claude.json'), '{"oauthAccount":{"emailAddress":"a@b.c"}}');
  const second = await collect(await h.runners.claude.start(await h.spec('tsk_login2')));
  assert.equal(terminal(second)?.type, 'failed');
  assert.equal(await h.cliCalls('claude'), 0);

  await fs.mkdir(join(h.home, '.codex'), { recursive: true });
  await fs.writeFile(join(h.home, '.codex', 'auth.json'), '{"auth_mode":"chatgpt","tokens":{}}');
  const codexEvents = await collect(
    await h.runners.codex.start(await h.spec('tsk_login3', { runner: 'codex' })),
  );
  assert.equal(terminal(codexEvents)?.type, 'failed');
  assert.equal(await h.cliCalls('codex'), 0);
});

test('login selectors set in the sandbox profile are removed before the CLI runs', async (t) => {
  const h = await setup({
    fake: {
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token',
        ANTHROPIC_AUTH_TOKEN: 'other-token',
      },
    },
  });
  t.after(() => h.cleanup());
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_env')));
  assert.equal(terminal(events)?.type, 'finished');
  const { env } = await h.cliCall('claude', 1);
  assert.ok(!env.includes('CLAUDE_CODE_OAUTH_TOKEN'));
  assert.ok(!env.includes('ANTHROPIC_AUTH_TOKEN'));
  assert.match(env, /^ANTHROPIC_API_KEY=/m);
});

for (const vendor of ['claude', 'codex'] as const) {
  test(`${vendor} runner: the todo in progress becomes the step line and no model is asked`, async (t) => {
    const opened: Array<[string, string]> = [];
    const h = await setup({ cloud: { onOpenedPage: (taskId, url) => opened.push([taskId, url]) } });
    t.after(() => h.cleanup());
    await h.setMode('todos');
    const events = await collect(
      await h.runners[vendor].start(await h.spec(`tsk_${vendor}_todos`)),
    );
    assert.equal(terminal(events)?.type, 'finished');
    const steps = notes(events).filter((note) => note.startsWith('step: '));
    assert.deepEqual(
      steps,
      vendor === 'claude'
        ? ['step: Fixing the login loop']
        : ['step: Fix the login loop', 'step: Run the tests'],
    );
    // Only the page whose fetch was answered is reported; the failed and the unanswered are not.
    assert.deepEqual(
      opened,
      vendor === 'claude' ? [[`tsk_${vendor}_todos`, 'https://docs.example/login']] : [],
    );
  });
}

test('a callback that throws does not stop the run', async (t) => {
  const h = await setup({
    cloud: {
      onOpenedPage: () => {
        throw new Error('the server is shutting down');
      },
    },
  });
  t.after(() => h.cleanup());
  await h.setMode('todos');
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_throwing')));
  assert.equal(terminal(events)?.type, 'finished');
});
