import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AnthropicLoopModel,
  FakeLoopModel,
  LoopProviderError,
  StreamAccumulator,
  textTurn,
  toolTurn,
  type LoopModelTurn,
} from '../coder-model.js';
import { ToolLoopCoder, boxLoopWorkspace } from '../coder-loop.js';
import { sequentialIds } from '../ids.js';
import { BOX_REPO, BoxWorkspace } from '../loop-box.js';
import { createCoderFromEnv } from '../loop-coder.js';
import {
  ADD_BROKEN,
  ADD_FIXED,
  CodingLoopHandler,
  FakeGitHost,
  NodeFileTestPort,
  scratchFiles,
} from '../loop.js';
import { FakeReviewer } from '../review.js';
import { Superagent } from '../runtime.js';
import { FakeSandbox } from '../sandbox.js';
import { DEFAULT_AUTONOMY, actMandate, type NormalizedEvent, type WorkerRecord } from '../types.js';
import { initLocalRepo } from '../workspace.js';
import { REPO, TENANT, github, prPayload } from './harness.js';

const FIX_PATCH = [
  'diff --git a/add.js b/add.js',
  '--- a/add.js',
  '+++ b/add.js',
  '@@ -1 +1 @@',
  '-export function add(a, b) { return a; }',
  '+export function add(a, b) { return a + b; }',
  '',
].join('\n');

const USAGE = { inputTokens: 900, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 };

async function boxRig(machine: string) {
  const hostDir = await initLocalRepo(scratchFiles());
  const sandbox = new FakeSandbox();
  const box = new BoxWorkspace(sandbox, machine);
  await box.materialize({ hostDir });
  return { sandbox, box, workspace: boxLoopWorkspace(box) };
}

function applyInput(workspace: ReturnType<typeof boxLoopWorkspace>) {
  return {
    brief: 'make add() return the sum',
    event: {} as NormalizedEvent,
    worker: {} as WorkerRecord,
    workspace,
    testCommand: 'node add.test.js',
  };
}

type Body = {
  system: unknown;
  tools: unknown;
  messages: Array<{ role: string; content: unknown }>;
  cache_control?: unknown;
};

function assertAppendOnly(bodies: readonly Record<string, unknown>[]): void {
  for (let i = 1; i < bodies.length; i += 1) {
    const prev = bodies[i - 1] as Body;
    const next = bodies[i] as Body;
    assert.equal(JSON.stringify(next.tools), JSON.stringify(prev.tools), `tools changed at ${i}`);
    assert.equal(
      JSON.stringify(next.system),
      JSON.stringify(prev.system),
      `system changed at ${i}`,
    );
    assert.ok(next.messages.length >= prev.messages.length, `messages shrank at ${i}`);
    assert.equal(
      JSON.stringify(next.messages.slice(0, prev.messages.length)),
      JSON.stringify(prev.messages),
      `earlier messages rewritten at ${i}`,
    );
  }
}

function lastUserBlocks(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const messages = (body as Body).messages;
  const last = messages.at(-1);
  assert.equal(last?.role, 'user');
  return last?.content as Array<Record<string, unknown>>;
}

test('normal run: read, patch, test until green; files change in the box only', async () => {
  const { sandbox, workspace } = await boxRig('loop-ok');
  const model = new FakeLoopModel([
    toolTurn([{ name: 'read_file', input: { path: 'add.js' } }], USAGE),
    toolTurn([{ name: 'apply_patch', input: { patch: FIX_PATCH } }], {
      ...USAGE,
      cacheReadTokens: 800,
    }),
    toolTurn([{ name: 'run', input: { command: 'node add.test.js' } }], {
      ...USAGE,
      cacheReadTokens: 850,
    }),
  ]);
  const result = await new ToolLoopCoder({ model }).apply(applyInput(workspace));
  assert.equal(result.loop?.stop, 'tests_passed');
  assert.equal(result.loop?.testsPassed, true);
  assert.equal(result.loop?.modelRequests, 3);
  assert.equal(result.loop?.toolCalls, 3);
  assert.equal(result.loop?.cacheBreaks, 0);
  assert.equal(result.loop?.inputTokens, 2700);
  assert.equal(result.loop?.cacheReadTokens, 1650);
  assert.ok((result.loop?.usdMicros ?? 0) > 0);
  assert.deepEqual(result.changed, ['add.js']);
  assert.deepEqual(result.files, {});
  assert.equal(result.incident, undefined);
  const root = sandbox.roots.get('loop-ok') as string;
  assert.equal(await readFile(join(root, BOX_REPO, 'add.js'), 'utf8'), ADD_FIXED);
  const readResult = lastUserBlocks(model.bodies[1] as Record<string, unknown>)[0];
  assert.equal(readResult?.type, 'tool_result');
  assert.match(String(readResult?.content), /1\texport function add\(a, b\) \{ return a; \}/);
  const body = model.bodies[0] as Body;
  assert.deepEqual(body.cache_control, { type: 'ephemeral' });
  assert.match(JSON.stringify(body.system), /"cache_control":\{"type":"ephemeral"\}/);
  assert.match(JSON.stringify(body.messages[0]), /Test command: node add\.test\.js/);
  assert.match(JSON.stringify(body.messages[0]), /add\.test\.js/);
  assertAppendOnly(model.bodies);
});

test('three identical calls nudge, six stop the loop with a repeat_tools incident', async () => {
  const { workspace } = await boxRig('loop-repeat');
  const read = () => toolTurn([{ name: 'read_file', input: { path: 'add.js' } }], USAGE);
  const model = new FakeLoopModel(Array.from({ length: 10 }, read));
  const result = await new ToolLoopCoder({ model }).apply(applyInput(workspace));
  assert.equal(result.loop?.stop, 'repeat_tools');
  assert.equal(result.loop?.modelRequests, 6);
  assert.equal(result.loop?.nudges, 1);
  assert.equal(result.incident?.rule, 'repeat_tools');
  assert.equal(result.incident?.action, 'stop');
  assert.equal(result.autonomy?.pending?.action, 'stop');
  const nudged = lastUserBlocks(model.bodies[3] as Record<string, unknown>);
  assert.ok(
    nudged.some(
      (block) => block.type === 'text' && /3 identical read_file/.test(String(block.text)),
    ),
  );
  for (const index of [1, 2]) {
    const plain = lastUserBlocks(model.bodies[index] as Record<string, unknown>);
    assert.ok(!plain.some((block) => block.type === 'text'));
  }
  assertAppendOnly(model.bodies);
});

test('three turns in a row with no visible output stop the loop', async () => {
  const { workspace } = await boxRig('loop-empty');
  const thinkingOnly: LoopModelTurn = {
    ...textTurn(''),
    content: [{ type: 'thinking', thinking: '', signature: 'sig' }],
  };
  const model = new FakeLoopModel([textTurn(''), thinkingOnly, textTurn('   ')]);
  const result = await new ToolLoopCoder({ model }).apply(applyInput(workspace));
  assert.equal(result.loop?.stop, 'empty_turns');
  assert.equal(result.loop?.modelRequests, 3);
  assert.equal(result.incident?.rule, 'empty_turns');
  const second = lastUserBlocks(model.bodies[1] as Record<string, unknown>);
  assert.match(String(second[0]?.text), /no visible output/);
  const assistant = (model.bodies[2] as Body).messages.at(-2);
  assert.deepEqual(assistant?.content, thinkingOnly.content);
  assertAppendOnly(model.bodies);
});

test('with tool loading, turn one sees core tools; a load keeps the tools prefix byte-identical', async () => {
  const { sandbox, workspace } = await boxRig('loop-load');
  const model = new FakeLoopModel([
    toolTurn([{ name: 'load_tools', input: { names: ['apply_patch'] } }], USAGE),
    toolTurn([{ name: 'apply_patch', input: { patch: FIX_PATCH } }], USAGE),
    toolTurn([{ name: 'run', input: { command: 'node add.test.js' } }], USAGE),
  ]);
  const result = await new ToolLoopCoder({ model, toolLoading: true }).apply(applyInput(workspace));
  assert.equal(result.loop?.stop, 'tests_passed');
  assert.deepEqual(result.loop?.toolsLoaded, ['apply_patch']);
  assert.equal(result.loop?.cacheBreaks, 0);
  const tools = (model.bodies[0] as Body).tools as Array<Record<string, unknown>>;
  const visible = tools.filter((tool) => !tool.defer_loading).map((tool) => tool.name);
  assert.deepEqual(visible, ['read_file', 'run', 'load_tools']);
  assert.ok(tools.filter((tool) => tool.defer_loading).every((tool) => !('cache_control' in tool)));
  assert.match(JSON.stringify((model.bodies[0] as Body).system), /apply_patch/);
  const loadResult = lastUserBlocks(model.bodies[1] as Record<string, unknown>)[0];
  assert.deepEqual(loadResult?.content, [{ type: 'tool_reference', tool_name: 'apply_patch' }]);
  const root = sandbox.roots.get('loop-load') as string;
  assert.equal(await readFile(join(root, BOX_REPO, 'add.js'), 'utf8'), ADD_FIXED);
  assertAppendOnly(model.bodies);
});

test('a deferred tool called before it is loaded is refused, not run', async () => {
  const { sandbox, workspace } = await boxRig('loop-unloaded');
  const model = new FakeLoopModel([
    toolTurn([{ name: 'write_file', input: { path: 'add.js', content: ADD_FIXED } }], USAGE),
    textTurn('giving up'),
  ]);
  const result = await new ToolLoopCoder({ model, toolLoading: true }).apply(applyInput(workspace));
  assert.equal(result.loop?.stop, 'end_turn');
  const refused = lastUserBlocks(model.bodies[1] as Record<string, unknown>)[0];
  assert.equal(refused?.is_error, true);
  assert.match(String(refused?.content), /not loaded yet/);
  const root = sandbox.roots.get('loop-unloaded') as string;
  assert.equal(await readFile(join(root, BOX_REPO, 'add.js'), 'utf8'), ADD_BROKEN);
});

test('a silent stream is dropped and the same request is retried on the same provider', async () => {
  const { workspace } = await boxRig('loop-silence');
  const model = new FakeLoopModel([{ hang: true }, textTurn('nothing to change')]);
  const result = await new ToolLoopCoder({
    model,
    settings: { ...DEFAULT_AUTONOMY, streamSilenceMs: 20 },
  }).apply(applyInput(workspace));
  assert.equal(result.loop?.stop, 'end_turn');
  assert.equal(result.loop?.streamRetries, 1);
  assert.equal(result.loop?.modelRequests, 2);
  assert.deepEqual(model.bodies[1], model.bodies[0]);
});

test('a retryable provider error retries the same body after a backoff', async () => {
  const { workspace } = await boxRig('loop-retry');
  const slept: number[] = [];
  const model = new FakeLoopModel([
    { error: new LoopProviderError('overloaded', 529, true) },
    textTurn('done'),
  ]);
  const result = await new ToolLoopCoder({
    model,
    sleep: async (ms) => {
      slept.push(ms);
    },
  }).apply(applyInput(workspace));
  assert.equal(result.loop?.stop, 'end_turn');
  assert.equal(result.loop?.providerRetries, 1);
  assert.deepEqual(slept, [1000]);
  assert.deepEqual(model.bodies[1], model.bodies[0]);
});

test('a non-retryable provider error stops the loop with an incident', async () => {
  const { workspace } = await boxRig('loop-400');
  const model = new FakeLoopModel([{ error: new LoopProviderError('bad request', 400, false) }]);
  const result = await new ToolLoopCoder({ model }).apply(applyInput(workspace));
  assert.equal(result.loop?.stop, 'provider_error');
  assert.equal(result.incident?.action, 'stop');
  assert.equal(model.calls, 1);
});

test('over budget, the loop compacts into a fresh conversation instead of editing history', async () => {
  const { workspace } = await boxRig('loop-compact');
  const model = new FakeLoopModel([
    toolTurn([{ name: 'read_file', input: { path: 'add.js' } }], USAGE),
    toolTurn([{ name: 'read_file', input: { path: 'add.test.js' } }], USAGE),
    toolTurn([{ name: 'run', input: { command: 'node add.test.js' } }], USAGE),
    textTurn('cannot fix'),
  ]);
  const result = await new ToolLoopCoder({ model, compactAtTokens: 200 }).apply(
    applyInput(workspace),
  );
  assert.ok((result.loop?.compactions ?? 0) >= 1);
  assert.equal(result.loop?.cacheBreaks, 0);
  const compactedAt = model.bodies.findIndex(
    (body, i) =>
      i > 0 && (body as Body).messages.length < (model.bodies[i - 1] as Body).messages.length,
  );
  assert.ok(compactedAt > 0);
  const fresh = model.bodies[compactedAt] as Body;
  assert.equal(fresh.messages.length, 1);
  assert.match(JSON.stringify(fresh.messages[0]), /compacted to \d+ tokens/);
  assert.equal(JSON.stringify(fresh.tools), JSON.stringify((model.bodies[0] as Body).tools));
  assert.equal(JSON.stringify(fresh.system), JSON.stringify((model.bodies[0] as Body).system));
});

test('without a box workspace the loop hands the call to its single-shot fallback', async () => {
  let called = 0;
  const coder = new ToolLoopCoder({
    model: new FakeLoopModel([]),
    fallback: {
      async apply() {
        called += 1;
        return { changed: [], files: {}, summary: 'fallback' };
      },
    },
  });
  const result = await coder.apply({
    brief: 'x',
    event: {} as NormalizedEvent,
    worker: {} as WorkerRecord,
  });
  assert.equal(result.summary, 'fallback');
  assert.equal(called, 1);
});

test('the SSE accumulator rebuilds text, tool_use input, thinking signature and usage', () => {
  const acc = new StreamAccumulator();
  const events = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          model: 'claude-haiku-5-5',
          usage: {
            input_tokens: 12,
            cache_read_input_tokens: 900,
            cache_creation_input_tokens: 40,
            output_tokens: 1,
          },
        },
      },
    ],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'abc' },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['ping', { type: 'ping' }],
    [
      'content_block_start',
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Reading ' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'add.js' } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"path":' },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '"add.js"}' },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 2 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 33 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ] as const;
  const progress = events.map(([name, data]) =>
    acc.push(`event: ${name}\ndata: ${JSON.stringify(data)}`),
  );
  assert.equal(progress[4], false, 'a ping is not model progress');
  assert.equal(acc.stopped, true);
  const turn = acc.result('fallback', 5);
  assert.equal(turn.stopReason, 'tool_use');
  assert.equal(turn.model, 'claude-haiku-5-5');
  assert.deepEqual(turn.usage, {
    inputTokens: 12,
    outputTokens: 33,
    cacheReadTokens: 900,
    cacheWriteTokens: 40,
  });
  assert.deepEqual(turn.content, [
    { type: 'thinking', thinking: '', signature: 'abc' },
    { type: 'text', text: 'Reading add.js' },
    { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'add.js' } },
  ]);
});

test('AnthropicLoopModel streams one request with the key in a header only', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const sse = [
    { type: 'message_start', message: { model: 'claude-haiku-5-5', usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const model = new AnthropicLoopModel({
    apiKey: 'test-key',
    fetch: fakeFetch,
    baseUrl: 'https://example.test/',
  });
  const turn = await model.next({ max_tokens: 10, messages: [] });
  assert.deepEqual(turn.content, [{ type: 'text', text: 'ok' }]);
  assert.equal(seen[0]?.url, 'https://example.test/v1/messages');
  const headers = seen[0]?.init.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], 'test-key');
  const sent = String(seen[0]?.init.body);
  assert.doesNotMatch(sent, /test-key/);
  assert.equal(JSON.parse(sent).stream, true);
});

test('AnthropicLoopModel turns 529 into a retryable provider error', async () => {
  const model = new AnthropicLoopModel({
    apiKey: 'k',
    fetch: (async () => new Response('overloaded', { status: 529 })) as typeof fetch,
  });
  await assert.rejects(model.next({}), (error: unknown) => {
    assert.ok(error instanceof LoopProviderError);
    assert.equal(error.retryable, true);
    assert.equal(error.status, 529);
    return true;
  });
});

test('MAKA_CLOUD_CODER_LOOP=1 selects the loop coder; it stays off by default', () => {
  const base = { MAKA_CLOUD_LOOP_LIVE: '1', ANTHROPIC_API_KEY: 'test-key' };
  const fetchNever = (async () => {
    throw new Error('no network in this test');
  }) as typeof fetch;
  assert.equal(createCoderFromEnv(base, fetchNever).kind, 'model');
  const loop = createCoderFromEnv({ ...base, MAKA_CLOUD_CODER_LOOP: '1' }, fetchNever);
  assert.equal(loop.kind, 'model-loop');
  assert.ok(loop.coder instanceof ToolLoopCoder);
  assert.equal(createCoderFromEnv({ MAKA_CLOUD_CODER_LOOP: '1' }, fetchNever).kind, 'fake');
});

test('a worker runs the loop coder in its box, then the handler tests, pushes and records loop stats', async () => {
  const repoDir = await initLocalRepo(scratchFiles());
  const git = new FakeGitHost();
  const sandbox = new FakeSandbox();
  const model = new FakeLoopModel([
    toolTurn([{ name: 'write_file', input: { path: 'add.js', content: ADD_FIXED } }], USAGE),
    toolTurn([{ name: 'run', input: { command: 'node add.test.js' } }], USAGE),
  ]);
  const handler = new CodingLoopHandler({
    coder: new ToolLoopCoder({ model }),
    tests: new NodeFileTestPort(),
    git,
    sandbox,
    repoUrl: repoDir,
  });
  const agent = new Superagent({
    handler,
    sandbox,
    reviewer: new FakeReviewer(),
    ids: sequentialIds(300),
    admission: { allowActors: ['alice', 'bob'] },
    judge: {
      async decide(event) {
        const repos = event.subject?.repo ? [event.subject.repo] : [REPO];
        return { action: 'spawn', mandate: actMandate(repos, 'explicit'), title: 'loop' };
      },
    },
  });
  const opened = await agent.ingest(
    github(TENANT, 'loop-tools-1', 'pull_request', prPayload('opened', 7)),
  );
  assert.equal(opened.result, 'spawned');
  if (opened.result !== 'spawned') return;
  const worker = agent.worker(TENANT, opened.workerId);
  assert.equal(git.pushes.length, 1);
  assert.match(handler.lastPatch, /return a \+ b/);
  const loopEvidence = (worker?.evidence ?? []).find((row) => row.label === 'coder-loop');
  assert.match(loopEvidence?.body ?? '', /stop=tests_passed/);
  assert.match(loopEvidence?.body ?? '', /cache_breaks=0/);
  assert.equal(model.calls, 2);
  assert.ok(sandbox.commands.some((row) => row.cmd.includes('base64 -d >')));
});
