import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundAnthropic, boundOpenAI, DEFAULT_BOUND_LIMITS } from '../bound.js';
import { costUsd, modelTable, priceProblem, worstCaseUsd } from '../pricing.js';

const table = modelTable([
  {
    vendor: 'openai',
    model: 'codex-test',
    inputPerMTokUsd: 1,
    outputPerMTokUsd: 10,
    maxOutputTokens: 9_000,
  },
]);

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function anthropic(value: Record<string, unknown>) {
  return boundAnthropic(encode(value), value, table, DEFAULT_BOUND_LIMITS);
}

const base = {
  model: 'claude-opus-5-5',
  max_tokens: 2_000,
  messages: [{ role: 'user', content: 'hi' }],
};

function openai(value: Record<string, unknown>) {
  return boundOpenAI(encode(value), value, table, DEFAULT_BOUND_LIMITS);
}

test('the input bound is the body bytes and the fixed overhead', () => {
  const value = {
    ...base,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'what is this' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'text' }] },
    ],
  };
  const bounded = anthropic(value);
  assert.ok(bounded.ok);
  assert.equal(
    bounded.inputTokens,
    encode(value).byteLength + DEFAULT_BOUND_LIMITS.requestOverheadTokens,
  );
  assert.equal(bounded.outputTokens, 2_000);
  assert.equal(bounded.inputMultiplier, 1.25);
});

test('a one-hour cache hint raises the input rate to the one-hour write price', () => {
  const bounded = anthropic({
    ...base,
    system: [{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  });
  assert.ok(bounded.ok);
  assert.equal(bounded.inputMultiplier, 2);
  assert.equal(bounded.oneHourCache, true);
});

test('only listed block types pass, each with its listed keys, at any depth', () => {
  const NOT_TEXT = 'only text, thinking, tool calls and text tool results are allowed in a request';
  const passing = anthropic({
    ...base,
    system: [{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'go', citations: null }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hm', signature: 'sig' },
          { type: 'redacted_thinking', data: 'opaque' },
          { type: 'text', text: 'reading' },
          { type: 'tool_use', id: 't', name: 'read', input: { type: 'image', nested: [1] } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't', content: 'text', is_error: true },
          { type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'more' }] },
          { type: 'tool_result', tool_use_id: 't' },
        ],
      },
    ],
  });
  assert.ok(passing.ok, passing.ok ? '' : passing.reason);

  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000020000000200806000000', 'hex');
  const inline = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
  };
  const pdfUrl = { type: 'url', url: 'https://example.com/a.pdf' };
  const user = (block: unknown) => [{ role: 'user', content: [block] }];
  const assistant = (block: unknown) => [{ role: 'assistant', content: [block] }];
  for (const messages of [
    user(inline),
    user({ type: 'image', source: { type: 'file', file_id: 'file_1' } }),
    user({ type: 'document', source: pdfUrl }),
    user({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'x' } }),
    user({ type: 'search_result', source: 'https://e.test', title: 't', content: [] }),
    user({ type: 'container_upload', file_id: 'file_1' }),
    user({ type: 'tool_result', tool_use_id: 't', content: [inline] }),
    user({
      type: 'tool_result',
      tool_use_id: 't',
      content: [{ type: 'document', source: pdfUrl }],
    }),
    user({ type: 'tool_result', tool_use_id: 't', content: { type: 'text', text: 'x' } }),
    user({ type: 'tool_result', tool_use_id: 't', content: 'x', toolset_name: 'mcp' }),
    // Server-tool history: a fetched PDF bills its pages, not the bytes of its URL.
    assistant({ type: 'server_tool_use', id: 's', name: 'web_fetch', input: { url: pdfUrl.url } }),
    user({
      type: 'web_fetch_tool_result',
      tool_use_id: 's',
      content: {
        type: 'web_fetch_result',
        url: pdfUrl.url,
        content: { type: 'document', source: pdfUrl },
      },
    }),
    user({ type: 'web_search_tool_result', tool_use_id: 's', content: [] }),
    assistant({ type: 'compaction', content: 'summary' }),
    assistant({ type: 'tool_use', id: 't', name: 'read', input: {}, caller: { type: 'direct' } }),
    assistant({ type: 'text', text: 'x', citations: [{ type: 'char_location' }] }),
    user({ type: 'text', text: 'x', source: pdfUrl }),
    user({ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1d' } }),
    user({ type: 'brand_new_block' }),
    user('text'),
    [{ role: 'user', content: 'x', attachments: [pdfUrl] }],
    [{ role: 'system', content: 'x' }],
  ]) {
    const bounded = anthropic({ ...base, messages });
    assert.equal(bounded.ok, false, JSON.stringify(messages));
  }
  for (const system of [[inline], [{ type: 'document', source: pdfUrl }], { type: 'text' }]) {
    const bounded = anthropic({ ...base, system });
    assert.equal(bounded.ok ? '' : bounded.reason, NOT_TEXT, JSON.stringify(system));
  }
  const fetched = anthropic({
    ...base,
    messages: user({ type: 'web_fetch_tool_result', tool_use_id: 's', content: {} }),
  });
  assert.equal(fetched.ok ? '' : fetched.reason, NOT_TEXT);
});

test('context edits that only clear content are allowed; anything else is not', () => {
  assert.equal(
    anthropic({ ...base, context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] } })
      .ok,
    true,
  );
  assert.equal(
    anthropic({ ...base, context_management: { edits: [{ type: 'compact_20260112' }] } }).ok,
    false,
  );
  assert.equal(anthropic({ ...base, max_tokens: undefined }).ok, false);
  assert.equal(
    anthropic({ ...base, tools: [{ name: 'read', input_schema: { type: 'object' } }] }).ok,
    true,
  );
  assert.equal(
    anthropic({ ...base, tools: [{ type: 'code_execution_20260521', name: 'code_execution' }] }).ok,
    false,
  );
});

test('a Responses request without an output cap is sent with the model cap', () => {
  const value = {
    model: 'codex-test',
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'go' }],
      },
    ],
    stream: true,
  };
  const bounded = boundOpenAI(encode(value), value, table, DEFAULT_BOUND_LIMITS);
  assert.ok(bounded.ok);
  assert.equal(bounded.outputTokens, 9_000);
  const sent = JSON.parse(new TextDecoder().decode(bounded.body)) as Record<string, unknown>;
  assert.equal(sent.max_output_tokens, 9_000);
  assert.equal(
    bounded.inputTokens,
    bounded.body.byteLength + DEFAULT_BOUND_LIMITS.requestOverheadTokens,
  );
  const over = { model: 'codex-test', input: 'go', max_output_tokens: 9_001 };
  assert.equal(boundOpenAI(encode(over), over, table, DEFAULT_BOUND_LIMITS).ok, false);
  const stored = { model: 'codex-test', input: [{ type: 'item_reference', id: 'msg_1' }] };
  assert.equal(boundOpenAI(encode(stored), stored, table, DEFAULT_BOUND_LIMITS).ok, false);
});

test('a hosted shell is refused; local tools pass only in their exact shape', () => {
  const withTools = (tools: unknown[]) => openai({ model: 'codex-test', input: 'go', tools });
  const fn = { type: 'function', name: 'read', description: 'd', parameters: {}, strict: true };
  for (const tool of [
    fn,
    { type: 'custom', name: 'apply_patch', description: 'd', format: { type: 'text' } },
    { type: 'local_shell' },
    { type: 'apply_patch' },
    { type: 'shell', environment: { type: 'local' } },
  ]) {
    assert.equal(withTools([tool]).ok, true, JSON.stringify(tool));
  }
  for (const tool of [
    { type: 'shell', environment: { type: 'container_auto', memory_limit: '4g' } },
    { type: 'shell', environment: { type: 'container_reference', container_id: 'cntr_1' } },
    { type: 'shell' },
    { type: 'shell', environment: { type: 'local', skills: [] } },
    { type: 'local_shell', environment: { type: 'container_auto' } },
    { type: 'apply_patch', container: 'cntr_1' },
    { ...fn, allowed_callers: ['code_interpreter'] },
    { type: 'web_search' },
    { type: 'code_interpreter', container: { type: 'auto' } },
  ]) {
    const bounded = withTools([fn, tool]);
    assert.equal(bounded.ok, false, JSON.stringify(tool));
    assert.equal(bounded.ok ? '' : bounded.reason, 'hosted tools are not allowed');
  }
});

test('only listed input types pass, at any depth: no image, file or hosted-tool history', () => {
  const NOT_TEXT = 'only text, reasoning and local tool calls are allowed in the input';
  const passing = openai({
    model: 'codex-test',
    instructions: 'rules',
    input: [
      { role: 'developer', content: 'rules' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
      {
        type: 'reasoning',
        id: 'rs_1',
        encrypted_content: 'opaque',
        summary: [{ type: 'summary_text', text: 'hm' }],
      },
      { role: 'assistant', content: [{ type: 'output_text', text: 'ok', annotations: [] }] },
      { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{"type":"image"}' },
      { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'x' }] },
      { type: 'shell_call', call_id: 'c2', action: { commands: ['ls'] } },
      {
        type: 'shell_call_output',
        call_id: 'c2',
        output: [{ stdout: 'a', stderr: '', outcome: { type: 'exit', exit_code: 0 } }],
      },
      {
        type: 'apply_patch_call',
        call_id: 'c3',
        operation: { type: 'update_file', path: 'a', diff: '' },
      },
      { type: 'apply_patch_call_output', call_id: 'c3', status: 'completed' },
      { type: 'local_shell_call', call_id: 'c4', action: { type: 'exec', command: ['ls'] } },
      { type: 'custom_tool_call', call_id: 'c5', name: 'patch', input: 'x' },
      { type: 'custom_tool_call_output', call_id: 'c5', output: 'done' },
    ],
  });
  assert.ok(passing.ok, passing.ok ? '' : passing.reason);

  // A 32×32 PNG: at detail "high" a tile-based model bills it 8,500 tokens, above the whole
  // request's byte bound.
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000020000000200806000000', 'hex');
  const small = `data:image/png;base64,${png.toString('base64')}`;
  const inMessage = (part: unknown) => [{ role: 'user', content: [part] }];
  const inToolOutput = (part: unknown) => [
    { type: 'function_call_output', call_id: 'c1', output: [part] },
  ];
  for (const input of [
    inMessage({ type: 'input_image', image_url: small, detail: 'high' }),
    inMessage({ type: 'input_image', file_id: 'file_1' }),
    inMessage({ type: 'input_file', file_url: 'https://example.com/a.pdf' }),
    inMessage({ type: 'input_audio', input_audio: { data: 'x', format: 'wav' } }),
    inToolOutput({ type: 'input_image', image_url: small }),
    inToolOutput({ type: 'input_file', file_id: 'file_1' }),
    inToolOutput({ type: 'computer_screenshot', image_url: small }),
    [{ type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search' } }],
    [{ type: 'file_search_call', id: 'fs_1', queries: ['q'], status: 'completed' }],
    [{ type: 'computer_call_output', call_id: 'c', output: { type: 'computer_screenshot' } }],
    [{ type: 'mcp_call', id: 'm', name: 'x', server_label: 's', arguments: '{}' }],
    [{ type: 'compaction', encrypted_content: 'opaque' }],
    [
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'x', annotations: [{ type: 'file_citation' }] }],
      },
    ],
    [{ type: 'brand_new_item' }],
    [{ type: 7 }],
  ]) {
    const bounded = openai({ model: 'codex-test', input });
    assert.equal(bounded.ok ? '' : bounded.reason, NOT_TEXT, JSON.stringify(input));
  }
  const stored = openai({ model: 'codex-test', input: [{ type: 'item_reference', id: 'x' }] });
  assert.equal(stored.ok ? '' : stored.reason, 'stored items are not allowed');
  const instructions = openai({
    model: 'codex-test',
    input: 'go',
    instructions: [{ role: 'user', content: [{ type: 'input_image', image_url: small }] }],
  });
  assert.equal(instructions.ok, false);
});

test('the long-context tier prices the whole request once the input passes its threshold', () => {
  const haiku = table.get('anthropic:claude-haiku-5-5');
  assert.ok(haiku);
  const short = costUsd(haiku, {
    input: 100_000,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 1_000,
  });
  const long = costUsd(haiku, {
    input: 100_001,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 1_000,
  });
  assert.ok(Math.abs(short - (100_000 * 0.1 + 1_000 * 0.5) / 1e6) < 1e-12);
  assert.ok(Math.abs(long - (100_001 * 0.5 + 1_000 * 2.5) / 1e6) < 1e-12);
  assert.ok(
    worstCaseUsd(haiku, { inputTokens: 100_001, outputTokens: 1_000, inputMultiplier: 1 }) >= long,
  );
});

test("the built-in modes' Codex model is priced with no configuration, and configuration replaces it", () => {
  const builtIn = modelTable();
  const sol = builtIn.get('openai:gpt-6.1-sol');
  assert.ok(sol);
  const usage = {
    input: 100_000,
    cacheRead: 100_000,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 10_000,
  };
  assert.ok(
    Math.abs(costUsd(sol, usage) - (100_000 * 2 + 100_000 * 0.1 + 10_000 * 10) / 1e6) < 1e-12,
  );
  const long = { ...usage, input: 172_001 };
  assert.ok(
    Math.abs(costUsd(sol, long) - (172_001 * 4 + 100_000 * 0.2 + 10_000 * 15) / 1e6) < 1e-12,
  );
  const request = { model: 'gpt-6.1-sol', input: 'go', stream: true };
  const bounded = boundOpenAI(encode(request), request, builtIn, DEFAULT_BOUND_LIMITS);
  assert.ok(bounded.ok);
  assert.equal(bounded.outputTokens, 128_000);
  const repriced = modelTable([
    {
      vendor: 'openai',
      model: 'gpt-6.1-sol',
      inputPerMTokUsd: 3,
      outputPerMTokUsd: 12,
      maxOutputTokens: 64_000,
    },
  ]).get('openai:gpt-6.1-sol');
  assert.equal(repriced?.inputPerMTokUsd, 3);
  assert.equal(repriced?.longContext, undefined);
  assert.equal(builtIn.get('anthropic:gpt-6.1-sol'), undefined);
});

test('configured prices are checked', () => {
  assert.equal(
    priceProblem({
      vendor: 'openai',
      model: 'm',
      inputPerMTokUsd: 1,
      outputPerMTokUsd: 2,
      maxOutputTokens: 10,
    }),
    undefined,
  );
  assert.ok(
    priceProblem({
      vendor: 'openai',
      model: 'm',
      inputPerMTokUsd: -1,
      outputPerMTokUsd: 2,
      maxOutputTokens: 10,
    }),
  );
  assert.ok(
    priceProblem({
      vendor: 'openai',
      model: 'm',
      inputPerMTokUsd: 1,
      outputPerMTokUsd: 2,
      maxOutputTokens: 0,
    }),
  );
  assert.ok(
    priceProblem({
      vendor: 'google' as never,
      model: 'm',
      inputPerMTokUsd: 1,
      outputPerMTokUsd: 2,
      maxOutputTokens: 1,
    }),
  );
});
