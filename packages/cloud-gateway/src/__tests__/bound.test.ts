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

test('images and files are refused wherever they sit; a text document is bounded by its bytes', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000020000000200806000000', 'hex');
  const inline = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
  };
  for (const block of [
    inline,
    { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
    { type: 'image', source: { type: 'file', file_id: 'file_1' } },
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBE' } },
    { type: 'document', source: { type: 'url', url: 'https://example.com/a.pdf' } },
    { type: 'tool_result', tool_use_id: 't', content: [inline] },
    { type: 'document', source: { type: 'content', content: [inline] } },
  ]) {
    const bounded = anthropic({ ...base, messages: [{ role: 'user', content: [block] }] });
    assert.equal(bounded.ok, false, JSON.stringify(block));
    assert.equal(bounded.ok ? '' : bounded.reason, 'images and files are not allowed');
  }
  const text = anthropic({
    ...base,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'x' } },
        ],
      },
    ],
  });
  assert.ok(text.ok);
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

test('images and files are refused wherever they sit in the input, at any size or detail', () => {
  // A 32×32 PNG: at detail "high" a tile-based model bills it 8,500 tokens, above the whole
  // request's byte bound.
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000020000000200806000000', 'hex');
  const small = `data:image/png;base64,${png.toString('base64')}`;
  const inMessage = (part: unknown) => ({
    model: 'codex-test',
    max_output_tokens: 100,
    input: [{ role: 'user', content: [part] }],
  });
  const inToolOutput = (part: unknown) => ({
    model: 'codex-test',
    input: [{ type: 'function_call_output', call_id: 'c1', output: [part] }],
  });
  for (const value of [
    inMessage({ type: 'input_image', image_url: small, detail: 'high' }),
    inMessage({ type: 'input_image', image_url: 'https://example.com/huge.png' }),
    inMessage({ type: 'input_image', file_id: 'file_1' }),
    inToolOutput({ type: 'input_image', image_url: small }),
    inToolOutput({ type: 'input_file', file_url: 'https://example.com/a.pdf' }),
    inToolOutput({ type: 'computer_screenshot', image_url: small }),
  ]) {
    const bounded = openai(value);
    assert.equal(bounded.ok, false, JSON.stringify(value));
    assert.equal(bounded.ok ? '' : bounded.reason, 'images and files are not allowed');
  }
  assert.equal(
    openai({ model: 'codex-test', input: [{ type: 'item_reference', id: 'x' }] }).ok,
    false,
  );
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
