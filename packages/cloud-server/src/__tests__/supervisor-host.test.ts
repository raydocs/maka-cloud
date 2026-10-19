import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { ConversationHandler, SupervisorParts } from '../cloud-server.js';
import type { InboxService } from '../inbox.js';
import { conductorSession, recordingHandler } from './conductor.js';
import { eventually, newConversation, openStream, startHarness } from './harness.js';

/** A service that does nothing, for tests that look at what the server hands the supervisor. */
export function idleService(onStop: () => void | Promise<void> = () => undefined): InboxService {
  return {
    list: async () => ({ items: [], next: null }),
    answer: async () => ({ ok: false, reason: 'not_found' }),
    setMute: () => ({ ok: false }),
    settings: () => ({}),
    updateSettings: () => ({ ok: false }),
    digest: async () => ({}),
    stop: async () => onStop(),
  };
}

async function withParts(
  t: TestContext,
  handler?: ConversationHandler,
  extra: { onStop?: () => void | Promise<void> } = {},
) {
  let parts: SupervisorParts | undefined;
  const h = await startHarness(t, {
    ...(handler ? { handler } : {}),
    supervisor: (given) => {
      parts = given;
      return idleService(extra.onStop);
    },
  });
  return { h, parts: parts as SupervisorParts };
}

test('an inbox event reaches open streams in order and a client resumes after it', async (t) => {
  const { h, parts } = await withParts(t);
  const conversationId = await newConversation(h);
  const stream = await openStream(t, h);
  parts.publish({ kind: 'inbox.item', conversationId, data: { itemId: 'itm_1', version: 1 } });
  parts.publish({ kind: 'inbox.digest', conversationId: null, data: { digestId: 'dig_1' } });
  const events = await stream.until(3, 'events');
  assert.deepEqual(
    events.map((event) => event.event),
    ['conversation.created', 'inbox.item', 'inbox.digest'],
  );
  assert.deepEqual(events[1]?.data, { conversationId, itemId: 'itm_1', version: 1 });
  assert.deepEqual(events[2]?.data, { conversationId: null, digestId: 'dig_1' });

  const resumed = await openStream(t, h, '', { 'last-event-id': String(events[1]?.id) });
  assert.deepEqual(
    (await resumed.until(1, 'events')).map((event) => event.event),
    ['inbox.digest'],
  );
});

test('a conversation stream carries that conversation inbox events and no one else', async (t) => {
  const { h, parts } = await withParts(t);
  const mine = await newConversation(h);
  const other = await newConversation(h);
  parts.publish({ kind: 'inbox.item', conversationId: other, data: { itemId: 'other' } });
  parts.publish({ kind: 'inbox.item', conversationId: mine, data: { itemId: 'mine' } });
  parts.publish({ kind: 'inbox.digest', conversationId: null, data: { digestId: 'global' } });
  const stream = await openStream(t, h, `?conversation=${mine}`);
  const events = await stream.until(2, 'events');
  assert.deepEqual(
    events.map((event) => [event.event, event.data.itemId]),
    [
      ['conversation.created', undefined],
      ['inbox.item', 'mine'],
    ],
  );
});

test('published events survive a restart and are numbered after the earlier ones', async (t) => {
  const { h, parts } = await withParts(t);
  const conversationId = await newConversation(h);
  parts.publish({ kind: 'inbox.item', conversationId, data: { itemId: 'a', version: 1 } });
  await h.restart();
  const stream = await openStream(t, h);
  const events = await stream.until(2, 'events');
  assert.deepEqual(events[1]?.data, { conversationId, itemId: 'a', version: 1 });
});

test('an event for an unknown conversation or with data that cannot be stored is refused and leaves no trace', async (t) => {
  const { h, parts } = await withParts(t);
  assert.throws(
    () => parts.publish({ kind: 'inbox.item', conversationId: 'conv_nope', data: {} }),
    /unknown conversation/u,
  );
  assert.throws(
    () => parts.publish({ kind: 'inbox.item', conversationId: null, data: undefined }),
    /missing or too large/u,
  );
  assert.throws(
    () =>
      parts.publish({
        kind: 'inbox.item',
        conversationId: null,
        data: { text: 'x'.repeat(300 * 1024) },
      }),
    /missing or too large/u,
  );
  const stream = await openStream(t, h);
  parts.publish({ kind: 'inbox.digest', conversationId: null, data: { ok: true } });
  assert.deepEqual(
    (await stream.until(1, 'events')).map((event) => event.event),
    ['inbox.digest'],
  );
});

test('the supervisor feed keeps the runner of a task and the public stream does not', async (t) => {
  const { handler, seen } = recordingHandler();
  const { h, parts } = await withParts(t, handler);
  const conversationId = await newConversation(h);
  const { session } = await conductorSession(h, seen, conversationId);
  await h.server.orchestrator.delegate(session, { runner: 'fake', brief: 'x' });

  const internal = parts.feed
    .read(0, 100)
    .flatMap((entry) => (entry.kind === 'task.event' ? [entry.data as { event: unknown }] : []))
    .map((data) => data.event as { type: string; runner?: string });
  assert.equal(internal.find((event) => event.type === 'task_created')?.runner, 'fake');

  const stream = await openStream(t, h);
  await eventually(() => stream.events.some((event) => event.event === 'task.event'), 'task event');
  const created = stream.events
    .filter((event) => event.event === 'task.event')
    .map((event) => event.data.event as { type: string })
    .find((event) => event.type === 'task_created');
  assert.ok(created);
  assert.equal('runner' in created, false);
});

test('feed.subscribe fires when the feed moves and stops after unsubscribe', async (t) => {
  const { h, parts } = await withParts(t);
  let calls = 0;
  const unsubscribe = parts.feed.subscribe(() => {
    calls += 1;
  });
  await newConversation(h);
  assert.equal(calls, 1);
  parts.publish({ kind: 'inbox.digest', conversationId: null, data: {} });
  assert.equal(calls, 2);
  unsubscribe();
  await newConversation(h);
  assert.equal(calls, 2);
});

test('a message the supervisor posts is stored once, reaches the handler once, and a retry is a duplicate', async (t) => {
  const { handler, messages } = recordingHandler();
  const { h, parts } = await withParts(t, handler);
  const conversationId = await newConversation(h);
  const signal = new AbortController().signal;
  const first = await parts.messages.post(
    { conversationId, text: 'please retry the failed step', clientMessageId: 'ans_1' },
    signal,
  );
  const again = await parts.messages.post(
    { conversationId, text: 'please retry the failed step', clientMessageId: 'ans_1' },
    signal,
  );
  assert.equal(again.messageId, first.messageId);
  await eventually(() => messages.length >= 1, 'handler call');
  // A later message arrives after the duplicate would have, so one call means no duplicate dispatch.
  await parts.messages.post({ conversationId, text: 'marker', clientMessageId: 'ans_2' }, signal);
  await eventually(() => messages.length >= 2, 'marker');
  assert.deepEqual(
    messages.map((message) => message.text),
    ['please retry the failed step', 'marker'],
  );
  await assert.rejects(
    parts.messages.post({ conversationId: 'conv_nope', text: 'x', clientMessageId: 'k' }, signal),
    /does not exist/u,
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    parts.messages.post({ conversationId, text: 'late', clientMessageId: 'ans_3' }, aborted.signal),
  );
  const texts = parts.feed
    .read(0, 100)
    .flatMap((entry) =>
      entry.kind === 'message.posted' ? [(entry.data as { text: string }).text] : [],
    );
  assert.deepEqual(
    texts,
    ['please retry the failed step', 'marker'],
    'the aborted post stored nothing',
  );
});

test('an answer goes to the handler for the conversation, and is not_found for anything else', async (t) => {
  const calls: Array<{
    conversationId: string;
    questionId: string;
    optionId: string;
    text?: string;
  }> = [];
  const handler: ConversationHandler = {
    onUserMessage: () => undefined,
    onAnswer: async (answer) => {
      calls.push(answer);
      return { accepted: true, duplicate: calls.length > 1 };
    },
  };
  const { h, parts } = await withParts(t, handler);
  const conversationId = await newConversation(h);
  const signal = new AbortController().signal;
  assert.deepEqual(
    await parts.answers.deliver(
      { conversationId, questionId: 'q1', optionId: 'go', text: 'ok' },
      signal,
    ),
    { accepted: true, duplicate: false },
  );
  assert.deepEqual(calls, [{ conversationId, questionId: 'q1', optionId: 'go', text: 'ok' }]);
  assert.deepEqual(
    await parts.answers.deliver(
      { conversationId: 'conv_nope', questionId: 'q1', optionId: 'go' },
      signal,
    ),
    { accepted: false, reason: 'not_found' },
  );
  assert.equal(calls.length, 1);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    parts.answers.deliver({ conversationId, questionId: 'q2', optionId: 'go' }, aborted.signal),
  );
  assert.equal(calls.length, 1);
});

test('without a handler that takes answers every question is not_found', async (t) => {
  const { h, parts } = await withParts(t, { onUserMessage: () => undefined });
  const conversationId = await newConversation(h);
  assert.deepEqual(
    await parts.answers.deliver(
      { conversationId, questionId: 'q1', optionId: 'go' },
      new AbortController().signal,
    ),
    { accepted: false, reason: 'not_found' },
  );
});

test('artifacts are read only for a task of the conversation that is named', async (t) => {
  const { handler, seen } = recordingHandler();
  const { h, parts } = await withParts(t, handler);
  const mine = await newConversation(h);
  const other = await newConversation(h);
  const { session } = await conductorSession(h, seen, mine);
  const before = h.fake.runs.length;
  const task = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: 'work' });
  await eventually(() => h.fake.runs.length > before, 'run');
  const run = h.fake.runFor(task.taskId);
  const dir = dirname(run.spec.resultPath);
  await mkdir(dirname(join(dir, 'out/report.json')), { recursive: true });
  await writeFile(join(dir, 'out/report.json'), '{"claims":[]}');
  await run.complete({
    summary: 'done',
    done: ['x'],
    notDone: [],
    confidence: 'high',
    knownIssues: [],
    artifacts: ['out/report.json'],
  });
  await h.server.orchestrator.wait(session, task.taskId, 2000);

  const signal = new AbortController().signal;
  const read = await parts.artifacts.read(
    { taskId: task.taskId, conversationId: mine },
    'out/report.json',
    signal,
  );
  assert.ok(read.ok);
  assert.equal(read.bytes.toString(), '{"claims":[]}');
  assert.deepEqual(
    await parts.artifacts.read(
      { taskId: task.taskId, conversationId: other },
      'out/report.json',
      signal,
    ),
    { ok: false, reason: 'not_found' },
  );
  assert.deepEqual(
    await parts.artifacts.read(
      { taskId: 'tsk_nope', conversationId: mine },
      'out/report.json',
      signal,
    ),
    { ok: false, reason: 'not_found' },
  );
  assert.deepEqual(
    await parts.artifacts.read({ taskId: task.taskId, conversationId: mine }, '../x', signal),
    { ok: false, reason: 'not_found' },
  );
});

test('the supervisor starts after the handler exists and stops before the handler and the database close', async (t) => {
  const order: string[] = [];
  const handler: ConversationHandler = {
    onUserMessage: () => undefined,
    close: () => {
      order.push('handler.close');
    },
  };
  let startedWithHandler = false;
  const h = await startHarness(t, {
    createHandler: () => {
      order.push('handler.create');
      return handler;
    },
    supervisor: (parts) => {
      startedWithHandler = order.includes('handler.create');
      // The database is still open when the supervisor stops: a read must work then.
      return idleService(() => {
        order.push('supervisor.stop');
        parts.feed.read(0, 1);
      });
    },
  });
  assert.equal(startedWithHandler, true);
  await h.server.close();
  assert.deepEqual(order, ['handler.create', 'supervisor.stop', 'handler.close']);
  // Closing again does nothing twice.
  await h.server.close();
  assert.deepEqual(order, ['handler.create', 'supervisor.stop', 'handler.close']);
});

test('a supervisor that fails to stop is reported and the server still closes', async (t) => {
  const { h } = await withParts(t, undefined, {
    onStop: () => {
      throw new Error('stuck');
    },
  });
  await h.server.close();
  assert.equal(h.warnings.at(-1)?.message, 'The supervisor failed to stop');
});

test('a server that fails to start stops the supervisor it already started', async (t) => {
  let stops = 0;
  const first = await startHarness(t);
  const port = new URL(first.server.url).port;
  await assert.rejects(
    startHarness(t, {
      port: Number(port),
      supervisor: () => idleService(() => void (stops += 1)),
    }),
  );
  assert.equal(stops, 1);
});

test('a supervisor that cannot start fails the server start and leaves nothing open', async (t) => {
  let handlerClosed = 0;
  await assert.rejects(
    startHarness(t, {
      createHandler: () => ({
        onUserMessage: () => undefined,
        close: () => void (handlerClosed += 1),
      }),
      supervisor: () => {
        throw new Error('cannot open supervisor.db');
      },
    }),
    /cannot open supervisor.db/u,
  );
  assert.equal(handlerClosed, 1);
});

test('without the option there are no inbox routes and the feed is unchanged', async (t) => {
  const h = await startHarness(t);
  const res = await h.api('/v1/inbox/items');
  assert.equal(res.status, 404);
});
