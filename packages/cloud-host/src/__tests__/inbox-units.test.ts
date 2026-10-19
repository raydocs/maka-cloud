import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Interrupt, inputTokenBound } from '@maka-cloud/supervisor';
import { ConfigError, describeConfig, readStackConfig } from '../config.js';
import { conductorBudget } from '../inbox/budget.js';
import { readInboxConfig } from '../inbox/config.js';
import { artifactEvidence } from '../inbox/evidence.js';
import {
  createSummaryModel,
  createVerifierModel,
  type GenerateText,
  parseReply,
} from '../inbox/models.js';
import { conductorNotifier } from '../inbox/notifier.js';

function config(env: Record<string, string>) {
  const problems: string[] = [];
  const value = (name: string) => (env[name]?.trim() === '' ? undefined : env[name]?.trim());
  const result = readInboxConfig(value, problems);
  return { result, problems };
}

const ENTRY = { vendor: 'openai', model: 'gpt-x', inputPerMTokUsd: 2, outputPerMTokUsd: 8 };

test('without settings the pool is empty, the cap is $5 and the summary model is the small one', () => {
  const { result, problems } = config({});
  assert.deepEqual(problems, []);
  assert.deepEqual(result, {
    verifierModels: [],
    summaryModel: 'claude-haiku-5-5',
    dailyCapUsd: 5,
  });
});

test('a pool entry needs explicit prices and its vendor key, and unknown fields are refused', () => {
  const ok = config({
    MAKA_CLOUD_VERIFIER_MODELS: JSON.stringify([
      ENTRY,
      { ...ENTRY, vendor: 'anthropic', model: 'claude-x', baseUrl: 'https://gw.example/v1' },
    ]),
    OPENAI_API_KEY: 'k',
    MAKA_CLOUD_VERIFIER_DAILY_CAP_USD: '2.5',
  });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.result.dailyCapUsd, 2.5);
  assert.deepEqual(ok.result.verifierModels[0], {
    ...ENTRY,
    maxInputChars: 200_000,
    maxOutputTokens: 2_000,
  });
  assert.equal(ok.result.verifierModels[1]?.baseUrl, 'https://gw.example/v1');

  const bad = (models: unknown, extra: Record<string, string> = { OPENAI_API_KEY: 'k' }) =>
    config({ MAKA_CLOUD_VERIFIER_MODELS: JSON.stringify(models), ...extra }).problems;
  assert.match(bad([{ ...ENTRY, inputPerMTokUsd: undefined }]).join(), /inputPerMTokUsd/);
  assert.match(bad([{ ...ENTRY, outputPerMTokUsd: -1 }]).join(), /outputPerMTokUsd/);
  assert.match(bad([{ ...ENTRY, vendor: 'google' }]).join(), /vendor/);
  assert.match(bad([{ ...ENTRY, model: 'a b' }]).join(), /model/);
  assert.match(bad([{ ...ENTRY, extra: 1 }]).join(), /unknown field extra/);
  assert.match(bad([{ ...ENTRY, maxOutputTokens: 0 }]).join(), /maxOutputTokens/);
  assert.match(bad([{ ...ENTRY, baseUrl: 'ftp://x' }]).join(), /baseUrl/);
  assert.match(bad([{ ...ENTRY, baseUrl: 'https://u:p@x.example' }]).join(), /baseUrl/);
  assert.match(bad([ENTRY, ENTRY]).join(), /twice/);
  assert.match(bad([ENTRY], {}).join(), /OPENAI_API_KEY is not set/);
  assert.match(bad('x').join(), /array/);
  assert.match(bad([null]).join(), /must be an object/);
  assert.match(config({ MAKA_CLOUD_VERIFIER_MODELS: '{' }).problems.join(), /not valid JSON/);
  assert.match(config({ MAKA_CLOUD_VERIFIER_DAILY_CAP_USD: '-1' }).problems.join(), /DAILY_CAP/);
  assert.match(config({ MAKA_CLOUD_VERIFIER_DAILY_CAP_USD: 'lots' }).problems.join(), /DAILY_CAP/);
});

// ------------------------------------------------------------------ models

function fakeGenerate(reply: {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}) {
  const calls: Array<Parameters<GenerateText>[0]> = [];
  const generate: GenerateText = async (options) => {
    calls.push(options);
    return { text: reply.text, usage: reply.usage ?? {} };
  };
  return { generate, calls };
}

const POOL_ENTRY = {
  vendor: 'openai' as const,
  model: 'gpt-x',
  inputPerMTokUsd: 2,
  outputPerMTokUsd: 8,
  maxInputChars: 100,
  maxOutputTokens: 50,
};

test('a verifier model makes one request with no retries of its own and reports the usage it was given', async () => {
  const { generate, calls } = fakeGenerate({
    text: '```json\n{"verdicts":[]}\n```',
    usage: { inputTokens: 10, outputTokens: 3 },
  });
  const sdkModel = { tag: 'sdk-model' } as never;
  const model = createVerifierModel(
    POOL_ENTRY,
    {},
    { generateText: generate, languageModel: () => sdkModel },
  );
  assert.equal(model.vendor, 'openai');
  assert.deepEqual(model.price, { inputPerMTokUsd: 2, outputPerMTokUsd: 8 });
  const signal = new AbortController().signal;
  const out = await model.verify(
    { instructions: 'sys', prompt: 'ask', maxOutputTokens: 40 },
    signal,
  );
  assert.deepEqual(out, { output: { verdicts: [] }, usage: { inputTokens: 10, outputTokens: 3 } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    model: sdkModel,
    system: 'sys',
    prompt: 'ask',
    maxOutputTokens: 40,
    maxRetries: 0,
    abortSignal: signal,
  });
});

test('usage the provider does not report is charged at the bound, never at zero', async () => {
  const { generate } = fakeGenerate({ text: 'not json' });
  const model = createVerifierModel(
    POOL_ENTRY,
    {},
    { generateText: generate, languageModel: () => ({}) as never },
  );
  const request = { instructions: 'abcd', prompt: 'efghij', maxOutputTokens: 40 };
  const out = await model.verify(request, new AbortController().signal);
  assert.equal(
    out.output,
    'not json',
    'text that is not JSON is passed on for the supervisor to refuse',
  );
  assert.deepEqual(out.usage, { inputTokens: inputTokenBound(request), outputTokens: 40 });

  // Dense text is charged by its bytes, not by half a token per character.
  const dense = { instructions: 'abcd', prompt: '漢'.repeat(3000), maxOutputTokens: 40 };
  const denseOut = await model.verify(dense, new AbortController().signal);
  assert.ok(denseOut.usage.inputTokens >= 9000, `charged ${denseOut.usage.inputTokens}`);
});

test('a provider error reaches the supervisor, which charges the reservation', async () => {
  const model = createVerifierModel(
    POOL_ENTRY,
    {},
    {
      generateText: async () => {
        throw new Error('rate limited');
      },
      languageModel: () => ({}) as never,
    },
  );
  await assert.rejects(
    model.verify(
      { instructions: 'a', prompt: 'b', maxOutputTokens: 1 },
      new AbortController().signal,
    ),
    /rate limited/,
  );
});

test('the real provider objects are built from the key in the environment without any network call', () => {
  const anthropic = createVerifierModel(
    { ...POOL_ENTRY, vendor: 'anthropic', model: 'claude-x' },
    { ANTHROPIC_API_KEY: 'k' },
  );
  const openai = createVerifierModel(POOL_ENTRY, { OPENAI_API_KEY: 'k' });
  assert.deepEqual([anthropic.id, openai.id], ['anthropic:claude-x', 'openai:gpt-x']);
});

test('parseReply strips a code fence and keeps text that is not JSON as text', () => {
  assert.deepEqual(parseReply('{"a":1}'), { a: 1 });
  assert.deepEqual(parseReply('```\n{"a":1}\n```'), { a: 1 });
  assert.equal(parseReply('sure!'), 'sure!');
});

test('the summary model returns an order and a summary, and anything else is an error', async () => {
  const good = createSummaryModel('m', {}, undefined, {
    generateText: fakeGenerate({ text: '{"order":["b","a"],"summary":"Two things need you."}' })
      .generate,
    languageModel: () => ({}) as never,
  });
  const input = { items: [{ id: 'a', kind: 'blocked', ask: 'x', ageMs: 1 }] };
  assert.deepEqual(await good.summarize(input, new AbortController().signal), {
    order: ['b', 'a'],
    summary: 'Two things need you.',
  });
  for (const text of [
    'hello',
    '{"order":"a","summary":"s"}',
    '{"order":[1],"summary":"s"}',
    '{"order":[]}',
  ]) {
    const bad = createSummaryModel('m', {}, undefined, {
      generateText: fakeGenerate({ text }).generate,
      languageModel: () => ({}) as never,
    });
    await assert.rejects(bad.summarize(input, new AbortController().signal), /order and a summary/);
  }
  const seen: unknown[] = [];
  createSummaryModel('m', {}, 'https://gw.example/v1', {
    generateText: fakeGenerate({ text: '{}' }).generate,
    languageModel: (entry) => (seen.push(entry), {} as never),
  });
  assert.deepEqual(seen, [{ vendor: 'anthropic', model: 'm', baseUrl: 'https://gw.example/v1' }]);
});

// ------------------------------------------------------------------ budget

function fakeSpend() {
  const calls: unknown[][] = [];
  let reserve: unknown = { ok: true, charge: {}, duplicate: false };
  let settle: unknown = { ok: true, charge: {}, duplicate: false, overrunUsd: 0 };
  let throws: Error | undefined;
  const api = {
    reserveSpend: (...args: unknown[]) => {
      calls.push(['reserve', ...args]);
      if (throws) throw throws;
      return reserve;
    },
    settleSpend: (...args: unknown[]) => {
      calls.push(['settle', ...args]);
      if (throws) throw throws;
      return settle;
    },
  };
  return {
    api: api as never,
    calls,
    set: (next: { reserve?: unknown; settle?: unknown; throws?: Error }) => {
      if (next.reserve) reserve = next.reserve;
      if (next.settle) settle = next.settle;
      throws = next.throws;
    },
  };
}

test('a reservation is charged to the conversation and task, and every refusal says why', () => {
  const spend = fakeSpend();
  const budget = conductorBudget(spend.api);
  assert.deepEqual(budget.reserve({ key: 'k1', conversationId: 'c', taskId: 't', maxUsd: 0.4 }), {
    ok: true,
  });
  assert.deepEqual(spend.calls, [['reserve', 'k1', 'c', 't', 0.4]]);
  for (const reason of ['budget', 'no_run', 'conflict', 'invalid_amount']) {
    spend.set({ reserve: { ok: false, reason } });
    const result = budget.reserve({ key: 'k2', conversationId: 'c', taskId: 't', maxUsd: 1 });
    assert.equal(result.ok, false, reason);
    assert.ok(!result.ok && result.reason.length > 10, reason);
  }
});

test('a budget that cannot be read refuses the check and is reported', () => {
  const spend = fakeSpend();
  const warnings: string[] = [];
  const budget = conductorBudget(spend.api, (message) => warnings.push(message));
  spend.set({ throws: new Error('disk') });
  const result = budget.reserve({ key: 'k', conversationId: 'c', taskId: 't', maxUsd: 1 });
  assert.equal(result.ok, false);
  assert.deepEqual(warnings, ['The conversation budget could not be read']);
});

test('settling an unknown key is silent, a real problem is reported, and nothing throws', () => {
  const spend = fakeSpend();
  const warnings: string[] = [];
  const budget = conductorBudget(spend.api, (message) => warnings.push(message));
  spend.set({ settle: { ok: false, reason: 'not_found' } });
  budget.settle('k', 0);
  assert.deepEqual(warnings, []);
  spend.set({ settle: { ok: false, reason: 'conflict' } });
  budget.settle('k', 1);
  assert.match(warnings[0] ?? '', /not settled: conflict/);
  spend.set({ throws: new Error('disk') });
  budget.settle('k', 1);
  assert.match(warnings[1] ?? '', /could not be settled/);
});

// ---------------------------------------------------------------- evidence

test('evidence is the artifact text; what the server cannot read keeps its reason', async () => {
  const reads: Array<[unknown, string]> = [];
  const evidence = artifactEvidence({
    artifacts: {
      read: async (task, ref) => {
        reads.push([task, ref]);
        if (ref === 'missing') return { ok: false, reason: 'not_found' };
        if (ref === 'big') return { ok: false, reason: 'too_large' };
        if (ref === 'boom') throw new Error('io');
        if (ref === 'binary') return { ok: true, bytes: Buffer.from([0xff, 0x41]) };
        return { ok: true, bytes: Buffer.from('héllo') };
      },
    },
  });
  const task = { taskId: 't', conversationId: 'c' };
  const signal = new AbortController().signal;
  assert.deepEqual(await evidence.readArtifact(task, 'a.json', signal), {
    ok: true,
    text: 'héllo',
  });
  assert.deepEqual(await evidence.readArtifact(task, 'missing', signal), {
    ok: false,
    reason: 'not_found',
  });
  assert.deepEqual(await evidence.readArtifact(task, 'big', signal), {
    ok: false,
    reason: 'too_large',
  });
  assert.deepEqual(await evidence.readArtifact(task, 'boom', signal), {
    ok: false,
    reason: 'unavailable',
  });
  assert.deepEqual(await evidence.readArtifact(task, 'binary', signal), { ok: true, text: '�A' });
  assert.deepEqual(reads[0], [task, 'a.json']);
});

// ---------------------------------------------------------------- notifier

test('a single item becomes one notice with the ask, a batch one notice per conversation', async () => {
  const notices: Array<{ conversationId: string; text: string }> = [];
  const notifier = conductorNotifier({
    postNotice: async (notice) => void notices.push(notice as never),
  });
  const item = (conversationId: string, ask: string) => ({
    itemId: `i-${ask}`,
    conversationId,
    kind: 'blocked',
    ask,
  });
  await notifier.interrupt({
    items: [item('c1', 'The build failed.')],
    batch: false,
  } satisfies Interrupt);
  await notifier.interrupt({
    items: [item('c1', 'one'), item('c2', 'two'), item('c1', `three ${'x'.repeat(400)}`)],
    batch: true,
  });
  assert.equal(notices.length, 3);
  assert.deepEqual(notices[0], { conversationId: 'c1', text: 'Needs you: The build failed.' });
  assert.equal(notices[1]?.conversationId, 'c1');
  assert.match(notices[1]?.text ?? '', /^Needs you \(2 items\):\n- one\n- three x+…$/u);
  assert.ok((notices[1]?.text.length ?? 0) < 400);
  assert.deepEqual(notices[2], { conversationId: 'c2', text: 'Needs you: two' });
});

test('a notice that cannot be posted fails the interrupt, so the supervisor reports it', async () => {
  const notifier = conductorNotifier({
    postNotice: async () => {
      throw new Error('outbox down');
    },
  });
  await assert.rejects(
    notifier.interrupt({
      items: [{ itemId: 'i', conversationId: 'c', kind: 'blocked', ask: 'x' }],
      batch: false,
    }),
    /outbox down/,
  );
});

// ------------------------------------------------------------ stack config

test('the stack config reports a bad pool with the other problems and prints the pool without keys', () => {
  const base = {
    MAKA_CLOUD_DATA_DIR: '/data',
    ANTHROPIC_API_KEY: 'sk-secret-anthropic',
    INSTABOX_API_KEY: 'ibx-secret',
    INSTABOX_MACHINE_ID: 'mch_1',
  };
  assert.throws(
    () => readStackConfig({ ...base, MAKA_CLOUD_VERIFIER_MODELS: '[{"vendor":"openai"}]' }),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.problems.some((problem) => /MAKA_CLOUD_VERIFIER_MODELS\[0\]/.test(problem)),
  );
  const config = readStackConfig({
    ...base,
    OPENAI_API_KEY: 'sk-secret-openai',
    MAKA_CLOUD_VERIFIER_MODELS: JSON.stringify([ENTRY]),
  });
  assert.equal(config.supervisorDbPath, '/data/supervisor.db');
  const printed = describeConfig(config).join('\n');
  assert.match(printed, /1 model\(s\) from openai, daily cap \$5/);
  assert.doesNotMatch(printed, /secret/);
  assert.match(describeConfig(readStackConfig(base)).join('\n'), /no model configured/);
});
