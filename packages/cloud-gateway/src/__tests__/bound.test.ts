import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundAnthropic, boundOpenAI, DEFAULT_BOUND_LIMITS } from '../bound.js';
import { costUsd, modelTable, priceProblem, worstCaseUsd } from '../pricing.js';
import { dataUrl, png } from './images.js';

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

/** The bound of one image: the base plus every 32×32 patch it covers. */
function imageBound(width: number, height: number): number {
  return (
    DEFAULT_BOUND_LIMITS.imageBaseTokens +
    Math.ceil(width / 32) * Math.ceil(height / 32) * DEFAULT_BOUND_LIMITS.imagePatchTokens
  );
}

test('the input bound is the body bytes, the fixed overhead and a bound per image from its size', () => {
  const image = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: png(100, 50).toString('base64') },
  };
  const value = {
    ...base,
    messages: [
      { role: 'user', content: [image, { type: 'text', text: 'what is this' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [image] }] },
    ],
  };
  const bounded = anthropic(value);
  assert.ok(bounded.ok);
  assert.equal(
    bounded.inputTokens,
    encode(value).byteLength + DEFAULT_BOUND_LIMITS.requestOverheadTokens + 2 * imageBound(100, 50),
  );
  assert.equal(bounded.outputTokens, 2_000);
  assert.equal(bounded.mustCount, false);
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

test('content the bytes cannot bound must be counted first', () => {
  for (const block of [
    { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
    { type: 'image', source: { type: 'file', file_id: 'file_1' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } },
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBE' } },
  ]) {
    const bounded = anthropic({ ...base, messages: [{ role: 'user', content: [block] }] });
    assert.ok(bounded.ok);
    assert.equal(bounded.mustCount, true, JSON.stringify(block));
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
  assert.equal(text.mustCount, false);
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
        content: [
          { type: 'input_text', text: 'go' },
          { type: 'input_image', image_url: dataUrl(png(64, 64)) },
        ],
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
    bounded.body.byteLength + DEFAULT_BOUND_LIMITS.requestOverheadTokens + imageBound(64, 64),
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

test('an image is bounded by its pixels, above what any detail level charges', () => {
  const value = {
    model: 'codex-test',
    max_output_tokens: 100,
    input: [
      {
        role: 'user',
        content: [{ type: 'input_image', image_url: dataUrl(png(4096, 4096)), detail: 'original' }],
      },
    ],
  };
  const bounded = openai(value);
  assert.ok(bounded.ok);
  const forImage =
    bounded.inputTokens - encode(value).byteLength - DEFAULT_BOUND_LIMITS.requestOverheadTokens;
  // 4096×4096 at detail "original" is billed about 19,661 tokens; a flat 10,000 fell short.
  assert.ok(forImage >= 19_661, `${forImage} tokens reserved for the image`);
});

test('images by URL or file, and files, are refused wherever they sit in the input', () => {
  const remote = { type: 'input_image', image_url: 'https://example.com/huge.png', detail: 'high' };
  const inMessage = (part: unknown) => ({
    model: 'codex-test',
    input: [{ role: 'user', content: [part] }],
  });
  const inToolOutput = (part: unknown) => ({
    model: 'codex-test',
    input: [{ type: 'function_call_output', call_id: 'c1', output: [part] }],
  });
  for (const value of [
    inMessage(remote),
    inMessage({ type: 'input_image', file_id: 'file_1' }),
    inMessage({ type: 'input_image', image_url: 'data:image/png;base64,AA' }),
    inToolOutput(remote),
    inToolOutput({ type: 'input_file', file_url: 'https://example.com/a.pdf' }),
    inToolOutput({ type: 'input_image', image_url: dataUrl(png(8, 8)), file_id: 'file_2' }),
  ]) {
    assert.equal(openai(value).ok, false, JSON.stringify(value));
  }
  const inline = inToolOutput({ type: 'input_image', image_url: dataUrl(png(2048, 2048)) });
  const bounded = openai(inline);
  assert.ok(bounded.ok);
  assert.ok(
    bounded.inputTokens >= bounded.body.byteLength + imageBound(2048, 2048),
    'an image in a tool output is bounded too',
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
