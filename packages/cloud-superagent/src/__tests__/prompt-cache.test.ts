import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyAutonomy } from '../autonomy.js';
import { parseMessagesUsage } from '../judge-client.js';
import {
  appendMessage,
  buildRequest,
  cacheHitShare,
  diffPrefix,
  loadTool,
  recordCacheBreak,
  serializeSegments,
  setTail,
  toAnthropicBody,
  workerCacheHitShare,
} from '../prompt-cache.js';
import { FakeProvider, runWorkerTurn } from '../session.js';
import { DEFAULT_AUTONOMY } from '../types.js';
import { clock } from './harness.js';

const READ = { name: 'Read', description: 'read a file' };
const WRITE = { name: 'Write', description: 'write a file' };

test('newly loaded tools are appended; the tools prefix is not rewritten', () => {
  const first = buildRequest({
    system: 'You are Super-agent.',
    tools: [READ],
    messages: [{ role: 'user', content: 'fix login' }],
    endpoint: 'https://api.anthropic.com/v1/messages',
  });
  const second = loadTool(first, WRITE);
  assert.deepEqual(second.tools, first.tools);
  assert.equal(second.appendedTools.some((row) => row.name === 'Write'), true);
  const left = serializeSegments(first);
  const right = serializeSegments(second);
  assert.equal(right.system, left.system);
  assert.equal(right.tools, left.tools);
  assert.equal(right.messages, left.messages);
  const broke = diffPrefix(first, second);
  assert.equal(broke.broke, 'appendedTools');
  assert.equal(broke.appendOnly, true);
  const body = toAnthropicBody(second);
  const messages = body.messages as Array<{ content: string }>;
  assert.match(messages.at(-1)?.content ?? '', /Write/);
  assert.deepEqual(body.tools, first.tools);
});

test('a git status change only touches the tail, not the top of the request', () => {
  const first = buildRequest({
    system: 'stable',
    tools: [READ],
    messages: [{ role: 'user', content: 'status' }],
    tail: { gitStatus: 'clean' },
  });
  const second = setTail(first, { gitStatus: ' M src/login.ts' });
  const broke = diffPrefix(first, second);
  assert.equal(broke.broke, 'tail');
  assert.equal(broke.appendOnly, true);
  const left = serializeSegments(first);
  const right = serializeSegments(second);
  assert.equal(right.system, left.system);
  assert.equal(right.tools, left.tools);
  assert.equal(right.messages, left.messages);
  const inserted = buildRequest({
    ...first,
    tools: [WRITE, ...first.tools],
  });
  const broken = diffPrefix(first, inserted);
  assert.equal(broken.broke, 'tools');
  assert.equal(broken.appendOnly, false);
  const monitor = recordCacheBreak(emptyAutonomy(), first, inserted);
  assert.equal(monitor.state.cacheBreaks, 1);
  assert.equal(monitor.break.broke, 'tools');
});

test('cache-hit share uses Anthropic cache_control usage fields', () => {
  const usage = parseMessagesUsage(
    {
      usage: {
        input_tokens: 20,
        output_tokens: 4,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 10,
      },
    },
    'claude-haiku-5-5',
    12,
  );
  assert.equal(usage.cacheReadTokens, 80);
  assert.equal(usage.cacheWriteTokens, 10);
  assert.equal(cacheHitShare(usage), 80 / (80 + 10 + 20));
  const state = {
    ...emptyAutonomy(),
    cacheReadTokens: 80,
    cacheWriteTokens: 10,
    inputTokens: 20,
  };
  assert.equal(workerCacheHitShare(state), 80 / 110);
});

test('a failed request retries on the same provider endpoint and discards a partial', async () => {
  const time = clock();
  const provider = new FakeProvider('https://api.anthropic.com/v1/messages').script(
    { kind: 'broken', text: 'half-answer' },
    { kind: 'ok', text: 'complete', usage: { inputTokens: 5, cacheReadTokens: 40, cacheWriteTokens: 0 } },
  );
  const request = buildRequest({
    system: 'stable',
    tools: [READ],
    messages: [{ role: 'user', content: 'go' }],
    endpoint: provider.endpoint,
  });
  const turn = await runWorkerTurn({
    worker: { autonomy: emptyAutonomy() },
    request,
    provider,
    now: time.read,
    sleep: async (ms) => {
      time.advance(ms);
    },
    settings: { ...DEFAULT_AUTONOMY, streamSilenceMs: 50 },
  });
  assert.equal(turn.action, 'continue');
  assert.equal(turn.text, 'complete');
  assert.deepEqual(turn.discarded, ['half-answer']);
  assert.equal(turn.endpoint, provider.endpoint);
  assert.deepEqual(provider.endpoints, [provider.endpoint, provider.endpoint]);
  assert.equal(turn.attempts, 2);
  assert.equal(
    turn.request.messages.some((row) => row.content === 'half-answer'),
    false,
  );
  assert.equal(turn.state.cacheReadTokens, 40);
});

test('stream silence of 4 minutes retries; the model does not see the partial', async () => {
  const time = clock();
  const provider = new FakeProvider().script({ event: { kind: 'ok', text: 'partial' }, hang: true }, {
    kind: 'ok',
    text: 'full',
  });
  const turn = await runWorkerTurn({
    worker: { autonomy: emptyAutonomy() },
    request: appendMessage(
      buildRequest({ system: 's', messages: [{ role: 'user', content: 'hi' }] }),
      { role: 'assistant', content: 'partial' },
    ),
    provider,
    now: time.read,
    sleep: async (ms) => {
      time.advance(ms);
    },
    settings: { ...DEFAULT_AUTONOMY, streamSilenceMs: 4 * 60_000 },
  });
  assert.equal(turn.incidents.some((row) => row.rule === 'stream_silence' && row.action === 'retry'), true);
  assert.equal(turn.text, 'full');
  assert.equal(turn.attempts, 2);
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[0]?.endpoint, provider.calls[1]?.endpoint);
});
