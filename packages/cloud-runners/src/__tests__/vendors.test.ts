import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { shq } from '../shell.js';
import { claudeAdapter, clip, codexAdapter, preambleFor } from '../vendors.js';

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
