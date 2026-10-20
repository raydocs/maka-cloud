import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import {
  calls,
  type FakeModel,
  lastUserText,
  startFakeModel,
  text,
  tool,
  toolResults,
} from '@maka-cloud/conductor/testing/fake-model';
import { Gateway } from '@maka-cloud/gateway';
import { FakeRun, FakeRunner, RunnerRegistry } from '@maka-cloud/orchestrator';
import { formatCiteCheckLine, REPORT_ARTIFACTS, RUNNER_EXPORT_PREFIX } from '@maka-cloud/playbooks';
import { conductorGateway } from '../gateway.js';
import { type Cloud, type CloudOptions, startCloud } from '../host.js';

interface SseEvent {
  id: number;
  event: string;
  data: Record<string, unknown>;
}

interface Stack {
  cloud: Cloud;
  model: FakeModel;
  claude: FakeRunner;
  codex: FakeRunner;
  token: string;
  warnings: Array<{ message: string; detail?: unknown }>;
  api(path: string, body?: unknown): Promise<Response>;
  restart(): Promise<void>;
}

const RESEARCH_MANIFEST = {
  summary: 'Report written and checked.',
  done: [
    'Wrote the comparison.',
    formatCiteCheckLine({
      claims: 4,
      verified: 2,
      quoteVerified: 2,
      failed: 0,
      removed: 0,
      judged: 0,
    }),
    // The line a real research runner adds once it has copied the report to the handoff directory.
    `${RUNNER_EXPORT_PREFIX} ${REPORT_ARTIFACTS.join(' ')}`,
  ],
  notDone: [],
  confidence: 'high' as const,
  knownIssues: [],
  artifacts: [...REPORT_ARTIFACTS],
};

type ConductorAccess = NonNullable<CloudOptions['conductor']>['access'];

async function startStack(
  t: TestContext,
  runnerStart?: (run: FakeRun) => void,
  access?: (modelUrl: string) => ConductorAccess,
): Promise<Stack> {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-host-test-'));
  const model = await startFakeModel();
  const onStart =
    runnerStart ?? ((run: FakeRun) => setImmediate(() => void run.complete(RESEARCH_MANIFEST)));
  const claude = new FakeRunner({ name: 'claude-agent-sdk', onStart });
  const codex = new FakeRunner({ name: 'codex', onStart });
  const warnings: Stack['warnings'] = [];
  const options: CloudOptions = {
    dbPath: join(dir, 'server.sqlite'),
    invitesPath: join(dir, 'invites.sqlite'),
    handoffRoot: join(dir, 'handoff'),
    runners: new RunnerRegistry([claude, codex]),
    conductorRoot: join(dir, 'conductor'),
    conductor: {
      access: access?.(model.url) ?? {
        apiKey: 'sk-test-not-a-key',
        baseUrl: model.url,
        unmeteredTestAccess: true,
      },
    },
    onWarning: (message, detail) => warnings.push({ message, detail }),
  };
  const stack = { model, claude, codex, warnings } as Stack;
  stack.cloud = await startCloud(options);
  stack.token = stack.cloud.server.invites.create('test').token;
  stack.api = (path, body) =>
    fetch(`${stack.cloud.server.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${stack.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  stack.restart = async () => {
    await stack.cloud.close();
    stack.cloud = await startCloud(options);
  };
  t.after(async () => {
    await stack.cloud.close();
    await model.close();
    await rm(dir, { recursive: true, force: true });
    if (model.failures.length > 0) throw model.failures[0];
  });
  return stack;
}

async function newConversation(stack: Stack): Promise<string> {
  const res = await stack.api('/v1/conversations', {});
  return ((await res.json()) as { conversationId: string }).conversationId;
}

/** Reads the conversation's feed from the start until `done` says enough arrived. */
async function readFeed(
  stack: Stack,
  conversationId: string,
  done: (events: SseEvent[]) => boolean,
  after = 0,
): Promise<SseEvent[]> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10_000);
  const events: SseEvent[] = [];
  try {
    const res = await fetch(
      `${stack.cloud.server.url}/v1/events?conversation=${conversationId}&after=${after}`,
      { headers: { authorization: `Bearer ${stack.token}` }, signal: abort.signal },
    );
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
      `Timed out reading the feed; got ${JSON.stringify(events.map((event) => [event.event, event.data]))}`,
    );
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  return events;
}

const assistantTexts = (events: SseEvent[]) =>
  events
    .filter((event) => event.event === 'message.posted' && event.data.role === 'assistant')
    .map((event) => event.data.text);

/** Names the product must never show in what the conductor publishes. */
const VENDOR_NAMES = /claude|anthropic|opus|codex|openai|gpt/iu;

test('one sentence in: the research playbook runs through the server, the task and the checked report come out in the feed', async (t) => {
  const stack = await startStack(t);
  stack.model.script(
    'planner',
    text('1. Search both databases’ docs.\n2. Draft and check every claim.'),
  );
  stack.model.script(
    'conductor',
    calls(tool('start_playbook', { playbook: 'research', goal: 'Compare Postgres and SQLite' })),
    calls(
      tool('delegate_task', {
        runner: 'claude-agent-sdk',
        brief: 'Research and draft the comparison.',
        mode: 'wait',
        timeoutMs: 10_000,
        budgetUsd: 1,
      }),
    ),
    (request) => {
      const [delegated] = toolResults(request);
      assert.equal(delegated?.isError, false, delegated?.text);
      const task = delegated?.json?.task as Record<string, unknown>;
      assert.equal(task.state, 'succeeded');
      assert.equal(
        (task.verification as { ok: boolean }).ok,
        true,
        JSON.stringify(task.verification),
      );
      assert.equal((task.verification as { basis: string }).basis, 'runner_reported');
      return text('Here is the checked comparison.');
    },
  );
  const conversationId = await newConversation(stack);
  const posted = await stack.api(`/v1/conversations/${conversationId}/messages`, {
    text: 'Compare Postgres and SQLite for a small app.',
  });
  assert.equal(posted.status, 202);

  const events = await readFeed(stack, conversationId, (seen) => assistantTexts(seen).length > 0);
  const kinds = events.map((event) => event.event);
  assert.equal(kinds[0], 'conversation.created');
  assert.equal(events[1]?.data.role, 'user');
  assert.ok(kinds.includes('task.event'), 'the delegated task shows in the feed');
  assert.deepEqual(assistantTexts(events), ['Here is the checked comparison.']);
  assert.equal(stack.claude.runs.length, 1);

  const tasks = (await (await stack.api(`/v1/conversations/${conversationId}/tasks`)).json()) as {
    tasks: Array<{ state: string }>;
  };
  assert.deepEqual(
    tasks.tasks.map((task) => task.state),
    ['succeeded'],
  );
});

test('the conductor reaches the model only through the gateway: the key stays there and each request is charged to the run', async (t) => {
  const MASTER = 'sk-master-host-only-0123456789';
  const keys: Array<string | null> = [];
  let gateway: Gateway | undefined;
  const stack = await startStack(t, undefined, (modelUrl) => {
    gateway = new Gateway({
      upstreams: { anthropic: { apiKey: MASTER, baseUrl: modelUrl } },
      fetch: (input, init) => {
        keys.push(new Headers(init?.headers).get('x-api-key'));
        return fetch(input, init);
      },
    });
    return { apiKey: 'gateway-in-process', gateway: conductorGateway(gateway, () => 'inv_e2e') };
  });
  t.after(() => gateway?.close());
  stack.model.script('planner', text('1. Answer.'));
  stack.model.script('conductor', text('Answered through the gateway.'));
  const conversationId = await newConversation(stack);
  await stack.api(`/v1/conversations/${conversationId}/messages`, { text: 'Hello.' });
  const events = await readFeed(stack, conversationId, (seen) => assistantTexts(seen).length > 0);
  assert.deepEqual(assistantTexts(events), ['Answered through the gateway.']);

  assert.ok(stack.model.requests.length >= 1);
  assert.equal(keys.length, stack.model.requests.length, 'every model request went through it');
  assert.ok(
    keys.every((key) => key === MASTER),
    'the vendor got the host’s key',
  );
  assert.ok(stack.model.requests.every((request) => !request.raw.includes(MASTER)));
  const [run] = stack.cloud.conductor.state.runsInState('done');
  assert.ok(run);
  const budget = stack.cloud.conductor.state.budget(run.runId);
  assert.ok(budget.modelUsd > 0, 'the gateway settled each request in the run ledger');
  assert.equal(budget.reservedUsd, 0);
  assert.equal(gateway?.inFlight, 0);
});

test('a question is answered over HTTP: the card, the answer and the reply all go through the feed, once each', async (t) => {
  const stack = await startStack(t);
  stack.model.script(
    'conductor',
    calls(
      tool('ask_user', {
        reason: 'taste',
        question: 'Which tone?',
        options: [
          { id: 'formal', label: 'Formal' },
          { id: 'casual', label: 'Casual' },
        ],
        recommended: 'casual',
      }),
    ),
  );
  const conversationId = await newConversation(stack);
  await stack.api(`/v1/conversations/${conversationId}/messages`, { text: 'Write a note.' });
  const asked = await readFeed(stack, conversationId, (seen) =>
    seen.some((event) => event.event === 'conductor.question'),
  );
  const card = asked.find((event) => event.event === 'conductor.question')?.data ?? {};
  assert.equal(card.reason, 'taste');
  assert.equal(card.question, 'Which tone?');
  assert.deepEqual(card.options, [
    { id: 'casual', label: 'Casual' },
    { id: 'formal', label: 'Formal' },
  ]);
  assert.equal(card.recommended, 'casual');

  stack.model.script('conductor', (request) => {
    assert.match(lastUserText(request), /: Formal\.[\s\S]*The user added: "short please"/);
    return text('A short formal note.');
  });
  const path = `/v1/conversations/${conversationId}/answers`;
  const answer = { questionId: card.questionId, optionId: 'formal', text: 'short please' };
  const first = await stack.api(path, answer);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { accepted: true, duplicate: false });
  const again = await stack.api(path, answer);
  assert.deepEqual(await again.json(), { accepted: true, duplicate: true });
  const other = await stack.api(path, { questionId: card.questionId, optionId: 'casual' });
  assert.equal(other.status, 409);
  assert.equal((await stack.api(path, { questionId: 'q_nope', optionId: 'formal' })).status, 404);

  const events = await readFeed(stack, conversationId, (seen) => assistantTexts(seen).length > 0);
  const answered = events.filter((event) => event.event === 'conductor.answered');
  assert.equal(answered.length, 1, 'one answered event however often the answer is sent');
  assert.equal(answered[0]?.data.optionId, 'formal');
  assert.equal(answered[0]?.data.text, 'short please');
  assert.deepEqual(assistantTexts(events), ['A short formal note.']);
  for (const event of events.filter((entry) => entry.event.startsWith('conductor.'))) {
    const payload = JSON.stringify({ ...event.data, conversationId: undefined });
    assert.doesNotMatch(payload, VENDOR_NAMES, `${event.event} carries no vendor name`);
  }
});

test('only the invite that owns the conversation can answer its question', async (t) => {
  const stack = await startStack(t);
  stack.model.script(
    'conductor',
    calls(
      tool('ask_user', {
        reason: 'taste',
        question: 'Which tone?',
        options: [
          { id: 'formal', label: 'Formal' },
          { id: 'casual', label: 'Casual' },
        ],
        recommended: 'casual',
      }),
    ),
  );
  const conversationId = await newConversation(stack);
  await stack.api(`/v1/conversations/${conversationId}/messages`, { text: 'Write a note.' });
  const asked = await readFeed(stack, conversationId, (seen) =>
    seen.some((event) => event.event === 'conductor.question'),
  );
  const questionId = String(
    asked.find((event) => event.event === 'conductor.question')?.data.questionId,
  );
  const path = `${stack.cloud.server.url}/v1/conversations/${conversationId}/answers`;
  const answerAs = (token: string) =>
    fetch(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ questionId, optionId: 'formal' }),
    });

  const stranger = stack.cloud.server.invites.create('someone else').token;
  assert.equal((await answerAs(stranger)).status, 404, 'another invite cannot see the question');
  assert.equal(stack.cloud.conductor.state.question(questionId)?.state, 'open');

  stack.model.script('conductor', text('A formal note.'));
  const own = await answerAs(stack.token);
  assert.equal(own.status, 200);
  assert.deepEqual(await own.json(), { accepted: true, duplicate: false });
});

test('after a restart the feed holds each conductor event once and an open question can still be answered', async (t) => {
  const stack = await startStack(t);
  stack.model.script(
    'conductor',
    calls(
      tool('ask_user', {
        reason: 'taste',
        question: 'A or B?',
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
        recommended: 'a',
      }),
    ),
  );
  const conversationId = await newConversation(stack);
  await stack.api(`/v1/conversations/${conversationId}/messages`, { text: 'Pick one.' });
  const before = await readFeed(stack, conversationId, (seen) =>
    seen.some((event) => event.event === 'conductor.question'),
  );
  const questionId = before.find((event) => event.event === 'conductor.question')?.data.questionId;

  await stack.restart();
  stack.model.script('conductor', text('B it is.'));
  const res = await stack.api(`/v1/conversations/${conversationId}/answers`, {
    questionId,
    optionId: 'b',
  });
  assert.equal(res.status, 200);
  const events = await readFeed(stack, conversationId, (seen) => assistantTexts(seen).length > 0);
  assert.equal(events.filter((event) => event.event === 'conductor.question').length, 1);
  assert.deepEqual(assistantTexts(events), ['B it is.']);
});

test('shutting the cloud down cancels a running task while the orchestrator is still reachable', async (t) => {
  let started: (run: FakeRun) => void = () => undefined;
  const running = new Promise<FakeRun>((resolve) => {
    started = resolve;
  });
  const stack = await startStack(t, (run) => started(run));
  stack.model.script('planner', text('1. Do it.'));
  stack.model.script(
    'conductor',
    calls(tool('start_playbook', { playbook: 'free', goal: 'Long job' })),
    calls(tool('delegate_task', { runner: 'codex', brief: 'Long job.', budgetUsd: 1 })),
    text('Started the long job.'),
  );
  const conversationId = await newConversation(stack);
  await stack.api(`/v1/conversations/${conversationId}/messages`, { text: 'Start the long job.' });
  const run = await running;
  await readFeed(stack, conversationId, (seen) => assistantTexts(seen).length > 0);
  assert.equal(run.cancelled, false);
  await stack.cloud.close();
  assert.equal(run.cancelled, true, 'the conductor cancelled its task on shutdown');
  assert.equal(
    stack.warnings.filter((warning) => /cancel/iu.test(warning.message)).length,
    0,
    JSON.stringify(stack.warnings),
  );
});
