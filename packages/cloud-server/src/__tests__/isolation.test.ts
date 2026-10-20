import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { AnswerOutcome } from '../http.js';
import type { ConversationHandler, SupervisorParts } from '../cloud-server.js';
import type { InboxService } from '../inbox.js';
import { conductorSession, recordingHandler } from './conductor.js';
import {
  eventually,
  type Harness,
  newConversation,
  openStream,
  postJson,
  startHarness,
} from './harness.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
const run = promisify(execFile);

/** The command line, in a process of its own, as an operator runs it. */
async function cli(...args: string[]): Promise<string> {
  const { stdout } = await run(process.execPath, [CLI, ...args]);
  return stdout;
}

/** Fails with `what` instead of hanging when `promise` does not settle in time. */
async function within<T>(promise: Promise<T>, what: string, ms = 3000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Inbox items kept the way the supervisor keeps them: by conversation, scoped by the caller's. */
function scopedInbox() {
  const items = new Map<string, { itemId: string; conversationId: string }>();
  const answered: unknown[] = [];
  const service: InboxService = {
    list: async (query) => ({
      items: [...items.values()].filter((item) =>
        query.conversations.includes(item.conversationId),
      ),
      next: null,
    }),
    answer: async (request) => {
      const item = items.get(request.itemId);
      if (!item || !request.conversations.includes(item.conversationId)) {
        return { ok: false, reason: 'not_found' };
      }
      answered.push(request);
      return { ok: true, duplicate: false, item: { state: 'closed' } };
    },
    setMute: () => ({ ok: false }),
    settings: () => ({}),
    updateSettings: () => ({ ok: false }),
    digest: async () => ({}),
    stop: async () => undefined,
  };
  return { service, items, answered };
}

/** A harness with the server's internal feed at hand, to see every row whatever its owner. */
async function withFeed(t: TestContext, options: Parameters<typeof startHarness>[1] = {}) {
  let parts: SupervisorParts | undefined;
  const h = await startHarness(t, {
    ...options,
    supervisor: (given) => {
      parts = given;
      return scopedInbox().service;
    },
  });
  const kinds = () => (parts as SupervisorParts).feed.read(0, 1000).map((entry) => entry.kind);
  return { h, kinds };
}

/** A handler that takes messages and answers and remembers both. */
function fullHandler() {
  const recording = recordingHandler();
  const answers: unknown[] = [];
  const handler: ConversationHandler = {
    ...recording.handler,
    onAnswer: async (answer) => {
      answers.push(answer);
      return { accepted: true, duplicate: false } satisfies AnswerOutcome;
    },
  };
  return { ...recording, handler, answers };
}

/** A request whose body is sent only after `beforeBody` ran, once the server is reading it. */
function slowRequest(
  h: Harness,
  method: string,
  path: string,
  token: string,
  body: unknown,
  beforeBody: () => void | Promise<void>,
): Promise<{ status: number; body: string }> {
  const payload = Buffer.from(JSON.stringify(body));
  const url = new URL(path, h.server.url);
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': String(payload.length),
          // The server answers 100 Continue and starts the handler (authentication
          // included) in one step, so once it arrives the request is past its first check.
          expect: '100-continue',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.on('continue', () => {
      void Promise.resolve(beforeBody()).then(() => req.end(payload), reject);
    });
  });
}

/** Everything one invite (A) owns: a conversation with a message, a finished task with an artifact, a running task, an inbox item. */
async function ownedWorld(t: TestContext, http = {}) {
  const inbox = scopedInbox();
  const handler = fullHandler();
  let parts: SupervisorParts | undefined;
  const h = await startHarness(t, {
    handler: handler.handler,
    supervisor: (given) => {
      parts = given;
      return inbox.service;
    },
    http,
  });
  const conversationId = await newConversation(h, 'A only');
  const { session } = await conductorSession(h, handler.seen, conversationId);
  const finished = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: 'done' });
  await eventually(() => h.fake.runs.length === 1, 'first run');
  const finishedRun = h.fake.runFor(finished.taskId);
  const dir = dirname(finishedRun.spec.resultPath);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'report.md'), '# A only');
  await finishedRun.complete({
    summary: 'done',
    done: ['x'],
    notDone: [],
    confidence: 'high',
    knownIssues: [],
    artifacts: ['report.md'],
  });
  await h.server.orchestrator.wait(session, finished.taskId, 2000);
  const running = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: 'run' });
  await eventually(
    () => h.server.orchestrator.status(session, running.taskId).state === 'running',
    'running',
  );
  (parts as SupervisorParts).publish({
    kind: 'inbox.item',
    conversationId,
    data: { itemId: 'itm_a' },
  });
  inbox.items.set('itm_a', { itemId: 'itm_a', conversationId });
  const b = h.server.invites.create('b');
  return {
    h,
    inbox,
    handler,
    conversationId,
    finishedTaskId: finished.taskId,
    runningTaskId: running.taskId,
    b,
  };
}

test("invite B gets 404 or nothing for every one of A's objects, on every route and the event stream", async (t) => {
  const w = await ownedWorld(t);
  const { h, b, conversationId: mine } = w;
  // A sees its own: the setup is real.
  assert.equal(
    ((await (await h.api('/v1/conversations')).json()) as { conversations: unknown[] })
      .conversations.length,
    1,
  );
  assert.equal((await h.api(`/v1/tasks/${w.finishedTaskId}/artifacts/0`)).status, 200);
  assert.equal(
    ((await (await h.api('/v1/inbox/items')).json()) as { items: unknown[] }).items.length,
    1,
  );

  const messagesBefore = w.handler.messages.length;
  const notFound = JSON.stringify({ error: 'not_found' });
  const routes: Array<[string, string, unknown?]> = [
    ['POST', `/v1/conversations/${mine}/messages`, { text: 'from B' }],
    ['POST', `/v1/conversations/${mine}/answers`, { questionId: 'q', optionId: 'a' }],
    ['GET', `/v1/conversations/${mine}/tasks`],
    ['GET', `/v1/tasks/${w.finishedTaskId}/artifacts`],
    ['GET', `/v1/tasks/${w.finishedTaskId}/artifacts/0`],
    ['POST', `/v1/tasks/${w.runningTaskId}/cancel`],
    ['POST', `/v1/tasks/${w.runningTaskId}/pause`],
    ['POST', `/v1/tasks/${w.runningTaskId}/resume`],
    [
      'POST',
      '/v1/inbox/items/itm_a/answer',
      { answerId: 'ans_b', optionId: 'a', preconditionHash: 'h' },
    ],
    ['GET', `/v1/events?conversation=${mine}`],
  ];
  for (const [method, path, body] of routes) {
    const res = await h.api(path, {
      method,
      token: b.token,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Exactly what an object that does not exist gets: never 403, nothing to tell them apart.
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal(await res.text(), notFound, `${method} ${path}`);
    const missing = await h.api(
      path
        .replace(mine, 'cnv_missing')
        .replace(/tsk_\w+/u, 'tsk_missing')
        .replace('itm_a', 'itm_missing'),
      {
        method,
        token: b.token,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    assert.equal(missing.status, 404, `missing ${method} ${path}`);
  }
  assert.deepEqual(await (await h.api('/v1/conversations', { token: b.token })).json(), {
    conversations: [],
  });
  assert.deepEqual(await (await h.api('/v1/inbox/items', { token: b.token })).json(), {
    items: [],
  });
  assert.equal(w.handler.messages.length, messagesBefore, 'nothing B sent reached the handler');
  assert.deepEqual(w.handler.answers, []);
  assert.deepEqual(w.inbox.answered, []);
  const runningRun = h.fake.runFor(w.runningTaskId);
  assert.deepEqual([runningRun.cancelCalls, runningRun.pauseCalls], [0, 0]);

  // B's whole stream: B's own conversation, created after all of A's rows, and nothing else.
  const stream = await openStream(t, h, '', {}, b.token);
  const created = await postJson(h, '/v1/conversations', { title: 'B only' }, b.token);
  const { conversationId: own } = (await created.json()) as { conversationId: string };
  await stream.until(1, "B's own conversation");
  assert.deepEqual(
    stream.events.map((event) => [event.event, event.data.conversationId]),
    [['conversation.created', own]],
  );
  // And A's whole stream carries none of B's.
  const aStream = await openStream(t, h);
  await eventually(
    () => aStream.events.some((event) => event.event === 'inbox.item'),
    "A's history",
  );
  assert.ok(aStream.events.every((event) => event.data.conversationId === mine));
});

test('an open stream ends when its invite is revoked through the server, and gets nothing after', async (t) => {
  const h = await startHarness(t);
  const conversationId = await newConversation(h);
  const stream = await openStream(t, h);
  await stream.until(1, 'history');
  h.server.invites.revoke(h.inviteId);
  await within(stream.closed, 'the stream to end on revoke');
  h.server.publisher.publish({
    kind: 'notice',
    eventId: 'evt_after',
    conversationId,
    text: 'after the revoke',
  });
  assert.deepEqual(
    stream.events.map((event) => event.event),
    ['conversation.created'],
  );
  assert.equal(h.server.openStreams(), 0);
});

test('a revoke made by the command line from another process ends open streams', async (t) => {
  const h = await startHarness(t, { http: { revokeCheckMs: 20 } });
  await newConversation(h);
  const stream = await openStream(t, h);
  await stream.until(1, 'history');
  await cli('invite', 'revoke', '--invites', h.options.invitesPath, h.inviteId);
  await within(stream.closed, 'the stream to end after the command-line revoke');
  assert.equal(h.server.openStreams(), 0);
});

test('a frame is never sent after a revoke from another process, even before the stream notices it', async (t) => {
  // The periodic check is far off; only the check before each frame can stop this one.
  const h = await startHarness(t, { http: { revokeCheckMs: 3_600_000 } });
  const conversationId = await newConversation(h);
  const stream = await openStream(t, h);
  await stream.until(1, 'history');
  await cli('invite', 'revoke', '--invites', h.options.invitesPath, h.inviteId);
  h.server.publisher.publish({
    kind: 'notice',
    eventId: 'evt_after',
    conversationId,
    text: 'after the revoke',
  });
  await within(stream.closed, 'the stream to end at the next frame');
  assert.deepEqual(
    stream.events.map((event) => event.event),
    ['conversation.created'],
  );
});

test('a message whose body is still arriving when the invite is revoked is refused and not stored', async (t) => {
  const { handler, messages } = recordingHandler();
  const { h, kinds } = await withFeed(t, { handler });
  const conversationId = await newConversation(h);
  const res = await slowRequest(
    h,
    'POST',
    `/v1/conversations/${conversationId}/messages`,
    h.token,
    { text: 'sent while revoked' },
    () => void h.server.invites.revoke(h.inviteId),
  );
  assert.equal(res.status, 401);
  assert.deepEqual(messages, []);
  assert.deepEqual(kinds(), ['conversation.created'], 'no message was stored');
});

test('an approval whose body is still arriving when the invite is revoked never reaches the handler', async (t) => {
  const { handler, answers } = fullHandler();
  const h = await startHarness(t, { handler });
  const conversationId = await newConversation(h);
  const res = await slowRequest(
    h,
    'POST',
    `/v1/conversations/${conversationId}/answers`,
    h.token,
    { questionId: 'q_irreversible', optionId: 'approve' },
    () => void h.server.invites.revoke(h.inviteId),
  );
  assert.equal(res.status, 401);
  assert.deepEqual(answers, []);
});

test('an inbox answer whose body is still arriving when the invite is revoked never reaches the supervisor', async (t) => {
  const inbox = scopedInbox();
  const h = await startHarness(t, { supervisor: () => inbox.service });
  const conversationId = await newConversation(h);
  inbox.items.set('itm_1', { itemId: 'itm_1', conversationId });
  const res = await slowRequest(
    h,
    'POST',
    '/v1/inbox/items/itm_1/answer',
    h.token,
    { answerId: 'ans_1', optionId: 'a', preconditionHash: 'h' },
    () => void h.server.invites.revoke(h.inviteId),
  );
  assert.equal(res.status, 401);
  assert.deepEqual(inbox.answered, []);
});

test('a conversation whose create request is still arriving when the invite is revoked is not created', async (t) => {
  const { h, kinds } = await withFeed(t);
  const res = await slowRequest(
    h,
    'POST',
    '/v1/conversations',
    h.token,
    { title: 'late' },
    () => void h.server.invites.revoke(h.inviteId),
  );
  assert.equal(res.status, 401);
  assert.deepEqual(kinds(), []);
});

test('the rate limit answers before the body is read', async (t) => {
  const h = await startHarness(t, { http: { messagesPerMinute: 1 } });
  const conversationId = await newConversation(h);
  const path = `/v1/conversations/${conversationId}/messages`;
  assert.equal((await postJson(h, path, { text: 'first' })).status, 202);
  // The body is never sent: only a limit taken before reading it can answer.
  const status = await within(
    new Promise<number>((resolve, reject) => {
      const req = request(new URL(path, h.server.url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${h.token}`,
          'content-type': 'application/json',
          'content-length': '100',
          expect: '100-continue',
        },
      });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
        req.destroy();
      });
      req.on('error', () => undefined);
      req.on('close', () => reject(new Error('closed without a response')));
      req.flushHeaders();
    }),
    'an answer without a body',
  );
  assert.equal(status, 429);
});

test('error text in tasks and events carries no model or vendor names', async (t) => {
  const { handler, seen } = recordingHandler();
  const h = await startHarness(t, { handler });
  const conversationId = await newConversation(h);
  const { session } = await conductorSession(h, seen, conversationId);
  const task = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: 'x' });
  await eventually(() => h.fake.runs.length === 1, 'run');
  h.fake.runFor(task.taskId).fail('codex exited with code 1; Claude and OpenAI said nothing');
  await h.server.orchestrator.wait(session, task.taskId, 2000);
  const tasks = (await (await h.api(`/v1/conversations/${conversationId}/tasks`)).json()) as {
    tasks: Array<{ failureReason?: string }>;
  };
  const reason = tasks.tasks[0]?.failureReason ?? '';
  assert.ok(reason.includes('exited with code 1'), reason);
  assert.doesNotMatch(reason, /codex|claude|openai/iu);
  const stream = await openStream(t, h, `?conversation=${conversationId}`);
  await eventually(
    () =>
      stream.events.some(
        (event) => (event.data.event as { type?: string } | undefined)?.type === 'task_failed',
      ),
    'the failure event',
  );
  assert.doesNotMatch(JSON.stringify(stream.events), /codex|claude|openai/iu);
});

test('inbox asks built from failure reasons carry no model or vendor names', async (t) => {
  const ask =
    'The step “x” has failed 2 times. Last reason: “codex exited; Claude/OpenAI unavailable”';
  let conversationId = '';
  let parts: SupervisorParts | undefined;
  const item = () => ({ itemId: 'itm_v', conversationId, ask, state: 'open' });
  const service: InboxService = {
    list: async () => ({ items: [item()], next: null }),
    answer: async () => ({ ok: false, reason: 'stale', item: item() }),
    setMute: () => ({ ok: false }),
    settings: () => ({}),
    updateSettings: () => ({ ok: false }),
    digest: async () => ({}),
    stop: async () => undefined,
  };
  const h = await startHarness(t, {
    supervisor: (given) => {
      parts = given;
      return service;
    },
  });
  conversationId = await newConversation(h);
  const stream = await openStream(t, h, `?conversation=${conversationId}`);
  (parts as SupervisorParts).publish({ kind: 'inbox.item', conversationId, data: item() });
  await stream.until(2, 'the item');
  const listed = await (await h.api('/v1/inbox/items')).text();
  const refused = await (
    await postJson(h, '/v1/inbox/items/itm_v/answer', {
      answerId: 'ans_1',
      optionId: 'retry',
      preconditionHash: 'h',
    })
  ).text();
  for (const seen of [listed, refused, JSON.stringify(stream.events)]) {
    assert.match(seen, /exited; assistant\/assistant unavailable/u);
    assert.doesNotMatch(seen, /codex|claude|openai/iu);
  }
  // The supervisor's own reads stay as written.
  const internal = (parts as SupervisorParts).feed
    .read(0, 100)
    .find((e) => e.kind === 'inbox.item');
  assert.equal((internal?.data as { ask?: string } | undefined)?.ask, ask);
});

test('a queued inbox answer takes effect only while its caller is active and owns the conversation', async (t) => {
  const { handler, answers, messages } = fullHandler();
  let parts: SupervisorParts | undefined;
  const h = await startHarness(t, {
    handler,
    supervisor: (given) => {
      parts = given;
      return scopedInbox().service;
    },
  });
  const p = parts as SupervisorParts;
  const conversationId = await newConversation(h);
  const signal = new AbortController().signal;
  const b = h.server.invites.create('b');
  const answer = { conversationId, questionId: 'q_1', optionId: 'approve' };
  // Not the owner, or no caller at all: nothing is applied or posted.
  for (const caller of [b.inviteId, undefined]) {
    assert.deepEqual(
      await p.answers.deliver({ ...answer, ...(caller ? { caller } : {}) }, signal),
      {
        accepted: false,
        reason: 'not_found',
      },
    );
    assert.deepEqual(
      await p.messages.post(
        {
          conversationId,
          text: 'x',
          clientMessageId: `k_${caller}`,
          ...(caller ? { caller } : {}),
        },
        signal,
      ),
      { refused: 'not_found' },
    );
  }
  // The owner, revoked after answering and before delivery.
  h.server.invites.revoke(h.inviteId);
  assert.deepEqual(await p.answers.deliver({ ...answer, caller: h.inviteId }, signal), {
    accepted: false,
    reason: 'not_found',
  });
  assert.deepEqual(
    await p.messages.post(
      { conversationId, text: 'x', clientMessageId: 'k_owner', caller: h.inviteId },
      signal,
    ),
    { refused: 'not_found' },
  );
  assert.deepEqual(answers, []);
  assert.deepEqual(messages, []);
  assert.deepEqual(
    p.feed.read(0, 100).map((entry) => entry.kind),
    ['conversation.created'],
  );
});

test('the server hands the conductor a check of the caller it can run where an approval takes effect', async (t) => {
  let authorized: ((caller: string, conversationId: string) => boolean) | undefined;
  const h = await startHarness(t, {
    createHandler: (context) => {
      authorized = context.authorized;
      return { onUserMessage: () => undefined };
    },
  });
  const check = authorized as (caller: string, conversationId: string) => boolean;
  const conversationId = await newConversation(h);
  const b = h.server.invites.create('b');
  assert.equal(check(h.inviteId, conversationId), true);
  assert.equal(check(b.inviteId, conversationId), false, 'not the owner');
  assert.equal(check(h.inviteId, 'cnv_missing'), false);
  h.server.invites.revoke(h.inviteId);
  assert.equal(check(h.inviteId, conversationId), false, 'revoked');
});

test('the server names the invite that owns a task, from the task alone, and never guesses', async (t) => {
  let ownerOfTask: ((taskId: string) => string | undefined) | undefined;
  const { handler, seen } = recordingHandler();
  const h = await startHarness(t, {
    createHandler: (context) => {
      ownerOfTask = context.ownerOfTask;
      return handler;
    },
  });
  const owner = ownerOfTask as (taskId: string) => string | undefined;
  const b = h.server.invites.create('b');
  const mine = await newConversation(h);
  const theirs = (await (await postJson(h, '/v1/conversations', {}, b.token)).json()) as {
    conversationId: string;
  };
  const sessionOf = async (conversationId: string, token: string) => {
    await postJson(h, `/v1/conversations/${conversationId}/messages`, { text: 'go' }, token);
    await eventually(() => seen.has(conversationId), 'handler call');
    const session = h.server.orchestrator.authenticate(
      seen.get(conversationId)?.rotateToken() ?? '',
    );
    if (!session) throw new Error('conductor token did not resolve');
    return session;
  };
  const first = await h.server.orchestrator.delegate(await sessionOf(mine, h.token), {
    runner: 'fake',
    brief: 'a',
  });
  const second = await h.server.orchestrator.delegate(
    await sessionOf(theirs.conversationId, b.token),
    { runner: 'fake', brief: 'b' },
  );
  assert.equal(owner(first.taskId), h.inviteId);
  assert.equal(owner(second.taskId), b.inviteId);
  assert.equal(owner('tsk_missing'), undefined);
  // A session that belongs to no conversation owns nothing.
  const loose = h.server.orchestrator.authenticate(h.server.orchestrator.issueSession().token);
  assert.ok(loose);
  const orphan = await h.server.orchestrator.delegate(loose, { runner: 'fake', brief: 'c' });
  assert.equal(owner(orphan.taskId), undefined);
});
