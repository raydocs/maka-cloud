import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import {
  calls,
  type FakeModel,
  startFakeModel,
  text,
  tool,
} from '@maka-cloud/conductor/testing/fake-model';
import { type FakeRun, FakeRunner, RunnerRegistry } from '@maka-cloud/orchestrator';
import type { FetchOutcome, SourceFetcher } from '@maka-cloud/supervisor';
import { type Cloud, startCloud } from '../host.js';
import { type GenerateText, createVerifierModel } from '../inbox/models.js';
import { startInbox } from '../inbox/setup.js';

interface SseEvent {
  id: number;
  event: string;
  data: Record<string, any>;
}

/** The names the product never shows. */
const VENDOR_NAMES = /claude|anthropic|opus|codex|openai|gpt/iu;

const QUOTE = 'The tunnel opened in 1994 and is about 50 km long.';
const PAGE_URL = 'https://example.com/s1';

const REPORT = {
  title: 'The link',
  sections: [
    {
      heading: 'Facts',
      claims: [
        {
          id: 'c1',
          text: 'The tunnel opened in 1994.',
          citations: [{ sourceId: 's1', quote: QUOTE }],
        },
      ],
    },
  ],
  sources: [{ id: 's1', url: PAGE_URL }],
};
const CITE_RECORD = {
  version: 1,
  mode: 'drop_unsupported',
  claims: [{ id: 'c1', status: 'quote_verified', removed: false }],
};

const MANIFEST = {
  summary: 'Researched the tunnel.',
  done: ['wrote the report'],
  notDone: [],
  confidence: 'high' as const,
  knownIssues: [],
  artifacts: ['report.json', 'verification.json'],
};

interface Stack {
  cloud: Cloud;
  model: FakeModel;
  token: string;
  dir: string;
  warnings: Array<{ message: string; detail?: unknown }>;
  /** What the fake verifier provider was asked, and what it will answer. */
  verifier: { requests: Array<Parameters<GenerateText>[0]>; reply: (claimIds: string[]) => string };
  fetched: string[];
  page: { text: string };
  conversationId: string;
  runId: string | undefined;
  api(path: string, init?: { method?: string; body?: unknown }): Promise<Response>;
  restart(): Promise<void>;
}

async function startStack(
  t: TestContext,
  options: {
    verifierVendor?: 'anthropic' | 'openai';
    price?: { inputPerMTokUsd: number; outputPerMTokUsd: number };
    dailyCapUsd?: number;
    /** Starts the inbox with no gateway and no injected models, and a vendor key at hand. */
    noGateway?: boolean;
  } = {},
): Promise<Stack> {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-host-inbox-'));
  const model = await startFakeModel();
  const stack = {
    model,
    dir,
    warnings: [],
    fetched: [],
    page: { text: `<html><body><p>${QUOTE}</p></body></html>` },
    conversationId: '',
    runId: undefined,
  } as unknown as Stack;
  stack.verifier = {
    requests: [],
    reply: (ids) =>
      JSON.stringify({
        verdicts: ids.map((claimId) => ({
          claimId,
          verdict: 'supported',
          reason: 'the quote says so',
        })),
      }),
  };
  const generate: GenerateText = async (request) => {
    stack.verifier.requests.push(request);
    const match = /CLAIMS\n(DATA-[0-9a-f]+)\n(.*)\n\1\nEVIDENCE/su.exec(request.prompt);
    const ids = (JSON.parse(match?.[2] ?? '[]') as Array<{ id: string }>).map((claim) => claim.id);
    return { text: stack.verifier.reply(ids), usage: { inputTokens: 1000, outputTokens: 100 } };
  };
  const fetcher: SourceFetcher = {
    async fetchText(url): Promise<FetchOutcome> {
      stack.fetched.push(url);
      return {
        ok: true,
        text: stack.page.text,
        finalUrl: url,
        contentType: 'text/html',
        bytes: stack.page.text.length,
      };
    },
  };
  const onStart = (run: FakeRun) => {
    void (async () => {
      const handoff = dirname(run.spec.resultPath);
      await mkdir(handoff, { recursive: true });
      await writeFile(join(handoff, 'report.json'), JSON.stringify(REPORT));
      await writeFile(join(handoff, 'verification.json'), JSON.stringify(CITE_RECORD));
      stack.runId = stack.cloud.conductor.state.openRun(stack.conversationId)?.runId;
      await run.complete(MANIFEST);
    })();
  };
  const claude = new FakeRunner({ name: 'claude-agent-sdk', onStart });
  const codex = new FakeRunner({ name: 'codex', onStart });
  const startOptions = {
    dbPath: join(dir, 'server.sqlite'),
    invitesPath: join(dir, 'invites.sqlite'),
    handoffRoot: join(dir, 'handoff'),
    runners: new RunnerRegistry([claude, codex]),
    conductorRoot: join(dir, 'conductor'),
    conductor: {
      access: {
        apiKey: 'sk-test-not-a-key',
        baseUrl: model.url,
        unmeteredTestAccess: true as const,
      },
    },
    onWarning: (message: string, detail?: unknown) => stack.warnings.push({ message, detail }),
    supervisor: (
      context: Parameters<NonNullable<Parameters<typeof startCloud>[0]['supervisor']>>[0],
    ) =>
      options.noGateway
        ? startInbox(
            {
              dbPath: join(dir, 'supervisor.db'),
              config: {
                verifierModels: [
                  {
                    vendor: 'openai',
                    model: 'verifier-x',
                    inputPerMTokUsd: 1,
                    outputPerMTokUsd: 5,
                    maxInputChars: 100_000,
                    maxOutputTokens: 1_000,
                  },
                ],
                summaryModel: 'm',
                dailyCapUsd: 5,
              },
              // What an earlier version read its fallback keys from.
              env: { OPENAI_API_KEY: 'sk-not-a-key', ANTHROPIC_API_KEY: 'sk-not-a-key' },
              override: { fetcher, tickMs: 0 },
            } as Parameters<typeof startInbox>[0],
            context,
          )
        : startInbox(
            {
              dbPath: join(dir, 'supervisor.db'),
              config: {
                verifierModels: [],
                summaryModel: 'm',
                dailyCapUsd: options.dailyCapUsd ?? 5,
              },
              override: {
                models: [
                  createVerifierModel(
                    {
                      vendor: options.verifierVendor ?? 'openai',
                      model: 'verifier-x',
                      inputPerMTokUsd: options.price?.inputPerMTokUsd ?? 1,
                      outputPerMTokUsd: options.price?.outputPerMTokUsd ?? 5,
                      maxInputChars: 100_000,
                      maxOutputTokens: 1_000,
                    },
                    { generateText: generate, languageModel: () => ({}) as never },
                  ),
                ],
                summary: {
                  summarize: async (input) => ({
                    order: input.items.map((item) => item.id),
                    summary: 'ok',
                  }),
                },
                fetcher,
                tickMs: 0,
              },
            },
            context,
          ),
  };
  try {
    stack.cloud = await startCloud(startOptions);
  } catch (error) {
    await model.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  stack.token = stack.cloud.server.invites.create('test').token;
  stack.api = (path, init = {}) =>
    fetch(`${stack.cloud.server.url}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${stack.token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  stack.restart = async () => {
    await stack.cloud.close();
    stack.cloud = await startCloud(startOptions);
  };
  t.after(async () => {
    await stack.cloud.close();
    await model.close();
    await rm(dir, { recursive: true, force: true });
    if (model.failures.length > 0) throw model.failures[0];
  });
  const created = await stack.api('/v1/conversations', { body: {} });
  stack.conversationId = ((await created.json()) as { conversationId: string }).conversationId;
  return stack;
}

async function readEvents(
  stack: Stack,
  done: (events: SseEvent[]) => boolean,
  query = '',
): Promise<SseEvent[]> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10_000);
  const events: SseEvent[] = [];
  try {
    const res = await fetch(`${stack.cloud.server.url}/v1/events${query}`, {
      headers: { authorization: `Bearer ${stack.token}` },
      signal: abort.signal,
    });
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const fields = Object.fromEntries(
          frame
            .split('\n')
            .filter((line) => !line.startsWith(':') && line.includes(': '))
            .map((line) => [line.slice(0, line.indexOf(': ')), line.slice(line.indexOf(': ') + 2)]),
        );
        if (fields.id === undefined) continue;
        events.push({
          id: Number(fields.id),
          event: fields.event ?? '',
          data: JSON.parse(fields.data ?? 'null') as Record<string, unknown>,
        });
      }
      if (done(events)) return events;
    }
  } catch (error) {
    if (!abort.signal.aborted) throw error;
    throw new Error(
      `Timed out reading the feed; got ${JSON.stringify(events.map((e) => [e.event, e.data.kind ?? e.data.text ?? '']))}`,
    );
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  return events;
}

/** One sentence in; the free playbook delegates one task to the claude-agent-sdk runner and ends. */
async function runTask(stack: Stack, runner = 'claude-agent-sdk'): Promise<void> {
  stack.model.script('planner', text('1. Research and write it up.'));
  stack.model.script(
    'conductor',
    calls(tool('start_playbook', { playbook: 'free', goal: 'Research the tunnel' })),
    calls(
      tool('delegate_task', {
        runner,
        brief: 'Research the tunnel.',
        mode: 'wait',
        timeoutMs: 10_000,
        budgetUsd: 1,
      }),
    ),
    text('The research is done.'),
  );
  const posted = await stack.api(`/v1/conversations/${stack.conversationId}/messages`, {
    body: { text: 'Research the tunnel.' },
  });
  assert.equal(posted.status, 202);
}

const inboxItems = (events: SseEvent[], kind?: string) =>
  events.filter((e) => e.event === 'inbox.item' && (kind === undefined || e.data.kind === kind));

async function listItems(stack: Stack, state = 'all'): Promise<any[]> {
  const res = await stack.api(`/v1/inbox/items?state=${state}`);
  assert.equal(res.status, 200);
  return ((await res.json()) as { items: any[] }).items;
}

test('a finished research task is checked against its report and the cited page, by the other vendor, and charged to the run', async (t) => {
  const stack = await startStack(t);
  await runTask(stack);
  const events = await readEvents(stack, (seen) => inboxItems(seen, 'finished').length > 0);
  const [item] = inboxItems(events, 'finished');
  assert.match(item?.data.ask, /independently checked/);
  assert.equal(item?.data.interrupts, false, 'a finished task does not interrupt');

  assert.deepEqual(stack.fetched, [PAGE_URL], 'the cited page was fetched once');
  assert.equal(stack.verifier.requests.length, 1);
  const request = stack.verifier.requests[0];
  assert.equal(request?.maxRetries, 0);
  assert.match(request?.prompt ?? '', /The tunnel opened in 1994/);

  const run = stack.runId as string;
  const budget = stack.cloud.conductor.state.budget(run);
  // 1000 input and 100 output tokens at $1 and $5 per million tokens.
  assert.ok(Math.abs(budget.externalUsd - 0.0015) < 1e-9, `charged ${budget.externalUsd}`);
  assert.equal(budget.reservedUsd, 0, 'the reservation was released');

  const items = await listItems(stack);
  assert.equal(items.length, 1);
  assert.doesNotMatch(JSON.stringify(items), VENDOR_NAMES);
  assert.doesNotMatch(JSON.stringify(inboxItems(events)), VENDOR_NAMES);
  assert.deepEqual(stack.warnings, []);
});

test('a quote that is not in the cited page fails the task, nobody pays for a model, and the human is told in the conversation', async (t) => {
  const stack = await startStack(t);
  stack.page.text = 'Something else entirely, nothing about any tunnel.';
  await runTask(stack);
  const events = await readEvents(
    stack,
    (seen) =>
      inboxItems(seen, 'verification_failed').length > 0 &&
      seen.some((e) => e.event === 'conductor.notice' && /Needs you/.test(String(e.data.text))),
    `?conversation=${stack.conversationId}`,
  );
  const [failed] = inboxItems(events, 'verification_failed');
  assert.match(failed?.data.ask, /The tunnel opened in 1994/);
  assert.equal(
    stack.verifier.requests.length,
    0,
    'deterministic checks are final: no model is asked',
  );
  const budget = stack.cloud.conductor.state.budget(stack.runId as string);
  assert.equal(budget.externalUsd, 0);
  assert.equal(budget.reservedUsd, 0);
  const notice = events.find(
    (e) => e.event === 'conductor.notice' && /Needs you/.test(String(e.data.text)),
  );
  assert.doesNotMatch(String(notice?.data.text), VENDOR_NAMES);
});

test('the human accepts a failed check over HTTP and a repeat is a duplicate; a stale hash is refused with the item as it is now', async (t) => {
  const stack = await startStack(t);
  stack.page.text = 'Nothing relevant here.';
  await runTask(stack);
  await readEvents(stack, (seen) => inboxItems(seen, 'verification_failed').length > 0);
  const [item] = await listItems(stack, 'open');
  assert.equal(item.kind, 'verification_failed');

  const answer = (body: unknown) => stack.api(`/v1/inbox/items/${item.itemId}/answer`, { body });
  const stale = await answer({
    answerId: 'a0',
    optionId: 'accept',
    preconditionHash: 'not-the-hash',
  });
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { error: string }).error, 'stale');

  const accepted = await answer({
    answerId: 'a1',
    optionId: 'accept',
    preconditionHash: item.preconditionHash,
  });
  assert.equal(accepted.status, 200);
  const body = (await accepted.json()) as {
    duplicate: boolean;
    item: { state: string; closeReason: string };
  };
  assert.deepEqual(
    [body.duplicate, body.item.state, body.item.closeReason],
    [false, 'closed', 'accepted'],
  );
  const again = await answer({
    answerId: 'a1',
    optionId: 'accept',
    preconditionHash: item.preconditionHash,
  });
  assert.equal(((await again.json()) as { duplicate: boolean }).duplicate, true);
  const other = await answer({
    answerId: 'a2',
    optionId: 'accept',
    preconditionHash: item.preconditionHash,
  });
  assert.equal(other.status, 409);
  assert.equal(((await other.json()) as { error: string }).error, 'already_answered');
  assert.deepEqual(await listItems(stack, 'open'), []);
});

test('asking the agent to fix it posts one message into the conversation, even when the answer is sent twice', async (t) => {
  const stack = await startStack(t);
  stack.page.text = 'Nothing relevant here.';
  await runTask(stack);
  await readEvents(stack, (seen) => inboxItems(seen, 'verification_failed').length > 0);
  const [item] = await listItems(stack, 'open');
  const fix = item.options.find((option: { recommended: boolean }) => option.recommended);
  assert.equal(fix.id, 'fix');
  stack.model.script('conductor', text('I will look into the report.'));
  const body = { answerId: 'f1', optionId: 'fix', preconditionHash: item.preconditionHash };
  const first = await stack.api(`/v1/inbox/items/${item.itemId}/answer`, { body });
  assert.equal(first.status, 200);
  const second = await stack.api(`/v1/inbox/items/${item.itemId}/answer`, { body });
  assert.equal(((await second.json()) as { duplicate: boolean }).duplicate, true);

  const events = await readEvents(
    stack,
    (seen) =>
      seen.some(
        (e) =>
          e.event === 'message.posted' &&
          e.data.role === 'assistant' &&
          /look into/.test(e.data.text),
      ),
    `?conversation=${stack.conversationId}`,
  );
  const users = events.filter((e) => e.event === 'message.posted' && e.data.role === 'user');
  assert.equal(users.length, 2, 'the human’s first message and one message from the inbox');
  assert.doesNotMatch(users[1]?.data.text, VENDOR_NAMES);
});

test('a task run by one vendor is checked by a model of the other', async (t) => {
  const stack = await startStack(t, { verifierVendor: 'anthropic' });
  await runTask(stack, 'codex');
  const events = await readEvents(stack, (seen) => inboxItems(seen, 'finished').length > 0);
  assert.match(inboxItems(events, 'finished')[0]?.data.ask, /independently checked/);
  assert.equal(stack.verifier.requests.length, 1);
});

test('with only a model of the runner’s own vendor the task is not called verified, no model is paid for, and the human is told', async (t) => {
  const stack = await startStack(t, { verifierVendor: 'anthropic' });
  await runTask(stack, 'claude-agent-sdk');
  const events = await readEvents(
    stack,
    (seen) => inboxItems(seen, 'verification_failed').length > 0,
    `?conversation=${stack.conversationId}`,
  );
  const [item] = inboxItems(events, 'verification_failed');
  assert.match(item?.data.ask, /no model of another vendor/);
  assert.equal(
    inboxItems(events, 'finished').length,
    0,
    'it is never shown as finished and checked',
  );
  assert.equal(stack.verifier.requests.length, 0);
  assert.equal(stack.cloud.conductor.state.budget(stack.runId as string).externalUsd, 0);
});

test('a check the run budget cannot cover is not made: the free checks still run and the human is told it is a budget matter', async (t) => {
  const stack = await startStack(t, {
    price: { inputPerMTokUsd: 1000, outputPerMTokUsd: 1_000_000 },
    dailyCapUsd: 1000,
  });
  await runTask(stack);
  const events = await readEvents(
    stack,
    (seen) => inboxItems(seen, 'verification_failed').length > 0,
  );
  const [item] = inboxItems(events, 'verification_failed');
  assert.match(item?.data.ask, /budget/i);
  assert.deepEqual(stack.fetched, [PAGE_URL], 'the checks that cost nothing still ran');
  assert.equal(stack.verifier.requests.length, 0);
  const budget = stack.cloud.conductor.state.budget(stack.runId as string);
  assert.equal(budget.externalUsd, 0);
  assert.equal(budget.reservedUsd, 0);
});

test('a restart keeps the inbox and checks nothing twice', async (t) => {
  const stack = await startStack(t);
  await runTask(stack);
  await readEvents(stack, (seen) => inboxItems(seen, 'finished').length > 0);
  const before = await listItems(stack);
  await stack.restart();
  const after = await listItems(stack);
  assert.deepEqual(
    after.map((item) => [item.itemId, item.version]),
    before.map((item) => [item.itemId, item.version]),
  );
  assert.equal(stack.verifier.requests.length, 1);
  assert.deepEqual(stack.fetched, [PAGE_URL]);
  assert.deepEqual(stack.warnings, []);
});

test('without the model gateway the inbox does not start, and calls no vendor with a key it finds', async (t) => {
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    if (!url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost')) {
      sent.push(url);
      throw new TypeError('no network in this test');
    }
    return realFetch(input, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  await assert.rejects(startStack(t, { noGateway: true }), /needs the model gateway/u);
  assert.deepEqual(sent, []);
});

test('the inbox routes need an invite, and closing the cloud stops the supervisor without a warning', async (t) => {
  const stack = await startStack(t);
  const res = await fetch(`${stack.cloud.server.url}/v1/inbox/items`);
  assert.equal(res.status, 401);
  await stack.cloud.close();
  assert.deepEqual(stack.warnings, []);
});
