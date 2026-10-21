import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { shq } from '../shell.js';
import { claudeAdapter, clip, codexAdapter, preambleFor, stepLine } from '../vendors.js';

function feed(adapter: typeof claudeAdapter, lines: unknown[]) {
  const parser = adapter.parser();
  return lines.flatMap((line) =>
    parser.feed(typeof line === 'string' ? line : JSON.stringify(line)),
  );
}

test('shq round-trips awkward text through bash', () => {
  for (const text of ["it's", 'a "quoted" $HOME `cmd` \\ end', 'line\nbreak', '', '*glob*']) {
    const out = execFileSync('bash', ['-c', `printf %s ${shq(text)}`], { encoding: 'utf8' });
    assert.equal(out, text);
  }
});

test('claude events become a session id, progress notes and a verdict', () => {
  const events = feed(claudeAdapter, [
    { type: 'system', subtype: 'init', session_id: 's-1' },
    'warning: plain text',
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Looking at the repo' },
          { type: 'tool_use', name: 'Grep', input: {} },
        ],
      },
    },
    { type: 'user', message: { content: [{ type: 'tool_result' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's-1' },
  ]);
  assert.deepEqual(events, [
    { kind: 'session', id: 's-1' },
    { kind: 'progress', note: 'Looking at the repo' },
    { kind: 'progress', note: 'tool: Grep' },
    { kind: 'session', id: 's-1' },
    { kind: 'result', ok: true, text: 'done' },
  ]);
  assert.deepEqual(
    feed(claudeAdapter, [
      { type: 'result', subtype: 'error_max_turns', is_error: true, result: 'too long' },
    ]),
    [{ kind: 'result', ok: false, text: 'too long' }],
  );
});

test('codex events become a thread id, progress notes and a verdict', () => {
  const events = feed(codexAdapter, [
    { type: 'thread.started', thread_id: 'th-1' },
    { type: 'item.started', item: { type: 'command_execution', command: 'npm test' } },
    {
      type: 'item.started',
      item: { type: 'mcp_tool_call', server: 'maka', tool: 'delegate_task' },
    },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Tests pass' } },
    { type: 'item.completed', item: { type: 'file_change' } },
    { type: 'turn.completed', usage: {} },
  ]);
  assert.deepEqual(events, [
    { kind: 'session', id: 'th-1' },
    { kind: 'progress', note: 'run: npm test' },
    { kind: 'progress', note: 'tool: maka.delegate_task' },
    { kind: 'progress', note: 'Tests pass' },
    { kind: 'progress', note: 'edited files' },
    { kind: 'result', ok: true },
  ]);
  assert.deepEqual(
    feed(codexAdapter, [{ type: 'turn.failed', error: { message: 'rate limited' } }]),
    [{ kind: 'result', ok: false, text: 'rate limited' }],
  );
  assert.deepEqual(feed(codexAdapter, [{ type: 'error', message: 'boom' }]), [
    { kind: 'result', ok: false, text: 'boom' },
  ]);
});

test('lines that are not events are ignored, including broken JSON', () => {
  assert.deepEqual(feed(claudeAdapter, ['', '{"type":', 'null', '[1]', '{"type":"unknown"}']), []);
  assert.deepEqual(feed(codexAdapter, ['{', '42']), []);
});

test('long notes are clipped to one line', () => {
  const note = clip(`first line\n${'x'.repeat(500)}`);
  assert.ok(note.length <= 200);
  assert.ok(!note.includes('\n'));
});

test('claude command: resume, model and MCP only when asked for', () => {
  const plain = claudeAdapter.command({ prompt: 'go' });
  assert.ok(
    !plain.includes('--resume') && !plain.includes('--model') && !plain.includes('--mcp-config'),
  );
  const full = claudeAdapter.command({
    prompt: "it's",
    resumeSessionId: 's-1',
    model: 'm-1',
    mcpUrl: 'http://x/mcp',
  });
  assert.match(full, /--resume 's-1'/);
  assert.match(full, /--model 'm-1'/);
  assert.match(full, /--strict-mcp-config/);
  assert.ok(full.includes(`-p ${shq("it's")}`));
});

test('codex command: resume subcommand and config overrides', () => {
  assert.match(codexAdapter.command({ prompt: 'go' }), /^codex exec --json --skip-git-repo-check /);
  const resumed = codexAdapter.command({ prompt: 'go', resumeSessionId: 'th-1', model: 'gpt-x' });
  assert.match(resumed, /^codex exec resume 'th-1' --json /);
  assert.match(resumed, /-c 'model="gpt-x"'/);
});

test('neither command nor environment can select a subscription login', () => {
  const access = { apiKey: 'sk-1', baseUrl: 'https://gw/v1' };
  const claudeEnv = claudeAdapter.env(access, 'tok');
  assert.deepEqual(Object.keys(claudeEnv).sort(), [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'DISABLE_AUTOUPDATER',
    'MAKA_MCP_TOKEN',
  ]);
  assert.match(preambleFor(claudeAdapter), /unset CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(preambleFor(claudeAdapter), /\.credentials\.json/);
  assert.match(codexAdapter.command({ prompt: 'x' }), /forced_login_method="api"/);
  assert.match(preambleFor(codexAdapter), /chatgpt/);
  const text = `${claudeAdapter.command({ prompt: 'x' })}${codexAdapter.command({ prompt: 'x' })}`;
  assert.ok(
    !/claude code/i.test(text),
    'no product branding in anything the agent or user is shown',
  );
});

const todoWrite = (todos: unknown) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos } }] },
});

test('claude: the todo item in progress is the step, from the agent’s own list; no list, no step', () => {
  const steps = (lines: unknown[]) =>
    feed(claudeAdapter, lines).filter((event) => event.kind === 'step');
  assert.deepEqual(
    steps([
      todoWrite([
        { content: 'Read the docs', status: 'completed', activeForm: 'Reading the docs' },
        {
          content: 'Fix the login loop',
          status: 'in_progress',
          activeForm: 'Fixing the login loop',
        },
        { content: 'Run the tests', status: 'pending', activeForm: 'Running the tests' },
      ]),
    ]),
    [{ kind: 'step', text: 'Fixing the login loop' }],
  );
  // The imperative form is used when there is no active form.
  assert.deepEqual(steps([todoWrite([{ content: 'Fix it', status: 'in_progress' }])]), [
    { kind: 'step', text: 'Fix it' },
  ]);
  for (const todos of [
    [{ content: 'a', status: 'completed' }],
    [{ content: 'a', status: 'pending' }],
    [],
    'not a list',
    [null, 3, { status: 'in_progress' }],
  ]) {
    assert.deepEqual(steps([todoWrite(todos)]), []);
  }
  assert.deepEqual(
    steps([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'TaskUpdate',
              input: { taskId: '2', status: 'in_progress', activeForm: 'Writing the test' },
            },
            {
              type: 'tool_use',
              name: 'TaskUpdate',
              input: { taskId: '3', status: 'completed', activeForm: 'Done thing' },
            },
          ],
        },
      },
    ]),
    [{ kind: 'step', text: 'Writing the test' }],
  );
});

test('the step is one short printable line without secrets or look-alike control text', () => {
  const parser = claudeAdapter.parser((text) => text.replaceAll('sk-secret-123', '[redacted]'));
  const [, step] = parser.feed(
    JSON.stringify(
      todoWrite([
        {
          content: 'x',
          status: 'in_progress',
          activeForm: `Use sk-secret-123 \u202Eto\u200B fix\n\u0000the ${'very '.repeat(80)}thing`,
        },
      ]),
    ),
  );
  assert.equal(step?.kind, 'step');
  const text = step?.kind === 'step' ? step.text : '';
  assert.ok(text.startsWith('Use [redacted] to fix the very very'));
  assert.ok(text.length <= 120 && text.endsWith('…'));
  assert.ok(!/[\u202E\u200B\u0000\n]/u.test(text));
  assert.equal(stepLine('\u202E\u200B \n'), undefined);
});

test('claude: the session’s own title is the step until a todo is in progress, then the todo wins', () => {
  const steps = (lines: unknown[]) =>
    feed(claudeAdapter, lines).filter((event) => event.kind === 'step');
  assert.deepEqual(steps([{ type: 'ai-title', aiTitle: 'Fix the login redirect loop' }]), [
    { kind: 'step', text: 'Fix the login redirect loop' },
  ]);
  assert.deepEqual(steps([{ type: 'summary', summary: 'Login loop' }]), [
    { kind: 'step', text: 'Login loop' },
  ]);
  // Once the agent's todo list has an item in progress, a later title does not replace it.
  assert.deepEqual(
    steps([
      todoWrite([{ content: 'Fix it', status: 'in_progress' }]),
      { type: 'ai-title', aiTitle: 'A newer title' },
    ]),
    [{ kind: 'step', text: 'Fix it' }],
  );
  // A title is defanged and capped like any step, and an empty or missing one says nothing.
  assert.deepEqual(steps([{ type: 'ai-title', aiTitle: '\u202E\u200B' }]), []);
  assert.deepEqual(steps([{ type: 'ai-title' }]), []);
  const long = steps([{ type: 'ai-title', aiTitle: 'x'.repeat(500) }]);
  assert.equal(long[0]?.kind === 'step' ? long[0].text.length <= 120 : false, true);
});

test('codex: the first todo that is not done is the step', () => {
  const todo = (items: unknown, type = 'item.updated') => ({
    type,
    item: { type: 'todo_list', items },
  });
  assert.deepEqual(
    feed(codexAdapter, [
      todo(
        [
          { text: 'Read', completed: true },
          { text: 'Fix', completed: false },
          { text: 'Test', completed: false },
        ],
        'item.started',
      ),
      todo([
        { text: 'Read', completed: true },
        { text: 'Fix', completed: true },
        { text: 'Test', completed: false },
      ]),
      todo([{ text: 'Read', completed: true }], 'item.completed'),
    ]),
    [
      { kind: 'step', text: 'Fix' },
      { kind: 'step', text: 'Test' },
    ],
  );
});

test('claude: a page counts as opened when its fetch was answered, and only then', () => {
  const call = (id: string, url: unknown, name = 'WebFetch') => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input: { url } }] },
  });
  const result = (id: string, error = false) => ({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          ...(error ? { is_error: true } : {}),
          content: 'x',
        },
      ],
    },
  });
  const opened = (lines: unknown[]) =>
    feed(claudeAdapter, lines).filter((event) => event.kind === 'opened');
  assert.deepEqual(
    opened([
      call('a', 'https://docs.example/a'),
      call('b', 'https://gone.example/b'),
      call('c', 'https://slow.example/c'),
      result('b', true),
      result('a'),
      result('a'),
      result('unknown'),
    ]),
    [{ kind: 'opened', url: 'https://docs.example/a' }],
  );
  // Other tools and a URL in the agent's own text are not pages it opened.
  assert.deepEqual(
    opened([
      call('d', 'https://docs.example/d', 'Bash'),
      result('d'),
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'see https://evil.example/x' }] },
      },
      call('e', 42),
      result('e'),
    ]),
    [],
  );
});

test('claude: calls waiting for an answer are bounded, so an agent cannot grow the parser’s memory', () => {
  const lines: unknown[] = [];
  for (let i = 0; i < 40; i++) {
    lines.push({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: `f${i}`,
            name: 'WebFetch',
            input: { url: `https://x.example/${i}` },
          },
        ],
      },
    });
  }
  const answer = (id: string) => ({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] },
  });
  const opened = feed(claudeAdapter, [...lines, answer('f0'), answer('f39')]).filter(
    (event) => event.kind === 'opened',
  );
  // The oldest were dropped when the bound was hit; the newest still count.
  assert.deepEqual(opened, [{ kind: 'opened', url: 'https://x.example/39' }]);
});
