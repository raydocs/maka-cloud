// @vitest-environment node
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  ApiError,
  applyEvent,
  CloudClient,
  type ConversationState,
  emptyState,
  type FeedEvent,
  readEvents,
  routes,
  totalCost,
  Unsupported,
} from '@maka-cloud/client';
import { MANIFEST, type Stack, startStack } from '../support/stack';

/**
 * The client and the event reducer against the real cloud-server (SQLite, the
 * orchestrator, the public API and the event stream) with a fake runner as the
 * only model. Nothing here is mocked at the HTTP boundary.
 */
let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack.close();
});

const NAMES = /claude|codex|gpt|anthropic|openai|gemini|sonnet|haiku|opus/iu;

function clientFor(token: string, onRevoked?: () => void) {
  return new CloudClient(token, { baseUrl: stack.url, ...(onRevoked ? { onRevoked } : {}) });
}

async function until<T>(
  read: () => T | undefined | false | Promise<T | undefined | false>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** What a conversation view holds: the reducer fed by the real stream. */
function watch(client: CloudClient, conversationId: string) {
  const watcher = {
    state: emptyState() as ConversationState,
    frames: [] as FeedEvent[],
    statuses: [] as string[],
  };
  const abort = new AbortController();
  const done = client.subscribe(
    conversationId,
    (event) => {
      watcher.frames.push(event);
      watcher.state = applyEvent(watcher.state, event);
    },
    (status) => watcher.statuses.push(status),
    abort.signal,
  );
  return {
    ...watcher,
    get state() {
      return watcher.state;
    },
    frames: watcher.frames,
    statuses: watcher.statuses,
    until: (check: (state: ConversationState) => unknown, what: string) =>
      until<ConversationState>(() => (check(watcher.state) ? watcher.state : undefined), what),
    stop: async () => {
      abort.abort();
      await done;
    },
  };
}

async function fresh() {
  const invite = stack.newInvite();
  const client = clientFor(invite.token);
  const { conversationId } = await client.createConversation();
  return { invite, client, conversationId };
}

test('one sentence starts a conversation; the assistant answers; a retried send is one message', async () => {
  const { client, conversationId } = await fresh();
  const view = watch(client, conversationId);
  const first = await client.postMessage(conversationId, 'Research solid-state batteries', 'c1');
  const again = await client.postMessage(conversationId, 'Research solid-state batteries', 'c1');
  expect(again.messageId).toBe(first.messageId);
  const state = await view.until(
    (s) => s.messages.some((m) => m.role === 'assistant'),
    'the assistant reply',
  );
  expect(state.messages.map((m) => [m.role, m.text])).toEqual([
    ['user', 'Research solid-state batteries'],
    ['assistant', 'Got it. I will start on that.'],
  ]);
  await view.stop();
});

test('a task tree: the reducer agrees with the server on state, steps and cost', async () => {
  const { client, conversationId } = await fresh();
  const view = watch(client, conversationId);
  const root = await stack.delegate(conversationId, { title: 'Write the report', budgetUsd: 2 });
  const child = await stack.delegate(conversationId, { title: 'Collect sources', parent: root });
  const rootRun = await stack.run(root);
  const childRun = await stack.run(child);
  rootRun.progress('Outlining');
  childRun.progress('Reading source 1');
  childRun.progress('Reading source 2');
  rootRun.usage(0.1);
  childRun.usage(0.04);
  const state = await view.until(
    (s) => s.tasks[root]?.costUsd === 0.14 && s.tasks[child]?.progress.length === 2,
    'progress and cost',
  );
  const listed = await client.listTasks(conversationId);
  for (const task of listed) {
    const mine = state.tasks[task.taskId];
    expect(mine?.state, task.taskId).toBe(task.state);
    expect(mine?.parentTaskId, task.taskId).toBe(task.parentTaskId);
    expect(mine?.progress.at(-1), task.taskId).toBe(task.progress.at(-1));
    expect(mine?.costUsd, task.taskId).toBe(task.costUsd);
    expect(mine?.budgetUsd, task.taskId).toBe(task.budgetUsd);
  }
  // Cost belongs to the top-level task and covers its subtasks.
  expect(state.tasks[root]?.costUsd).toBe(0.14);
  expect(state.tasks[child]?.costUsd).toBeUndefined();
  expect(totalCost(Object.values(state.tasks))).toEqual({ usd: 0.14, complete: true });
  await rootRun.complete();
  await childRun.complete();
  await view.until((s) => s.tasks[root]?.state === 'succeeded', 'the root to finish');
  // A view opened later replays the conversation and ends up in the same place.
  const late = watch(client, conversationId);
  const replayed = await late.until((s) => s.tasks[root]?.state === 'succeeded', 'the replay');
  expect(replayed.tasks).toEqual(view.state.tasks);
  await late.stop();
  await view.stop();
});

test('pause, resume and cancel use the real control routes and show up through the stream', async () => {
  const { client, conversationId } = await fresh();
  const view = watch(client, conversationId);
  const root = await stack.delegate(conversationId, { title: 'Long job' });
  const child = await stack.delegate(conversationId, { title: 'Part of it', parent: root });
  await stack.run(root);
  await stack.run(child);
  await view.until((s) => s.tasks[root]?.state === 'running', 'the task to run');

  await client.control(root, 'pause');
  await view.until((s) => s.tasks[root]?.state === 'paused', 'the pause');
  await client.control(root, 'resume');
  await view.until((s) => s.tasks[root]?.state === 'running', 'the resume');
  await client.control(root, 'cancel');
  const state = await view.until(
    (s) => s.tasks[root]?.state === 'cancelled' && s.tasks[child]?.state === 'cancelled',
    'the cancel to reach the whole tree',
  );
  expect(state.tasks[root]?.cancelRequested).toBe(true);

  // An ended task refuses a pause with a code the UI can word.
  const refused = await client.control(root, 'pause').catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ApiError);
  expect(refused).toMatchObject({ status: 409, code: 'invalid_state' });
  await view.stop();
});

test('a runner that cannot pause is refused with pause_unsupported', async () => {
  const solo = await startStack({ pausable: false });
  try {
    const client = new CloudClient(solo.token, { baseUrl: solo.url });
    const { conversationId } = await client.createConversation();
    const task = await solo.delegate(conversationId, { title: 'No pause here' });
    await solo.run(task);
    const refused = await client.control(task, 'pause').catch((error: unknown) => error);
    expect(refused).toMatchObject({ status: 409, code: 'pause_unsupported' });
  } finally {
    await solo.close();
  }
});

test('a decision: recommended option, held action, one recorded answer, duplicates and conflicts', async () => {
  const { client, conversationId, invite } = await fresh();
  const view = watch(client, conversationId);
  stack.ask(conversationId, {
    questionId: 'q1',
    reason: 'irreversible',
    question: 'Open the pull request?',
    options: [
      { id: 'no', label: 'Not yet' },
      { id: 'yes', label: 'Open it' },
    ],
    recommended: 'yes',
    note: 'It changes two files.',
    action: { tool: 'open_pull_request', args: { branch: 'fix-1' } },
  });
  const asked = await view.until((s) => s.questions.q1, 'the question');
  expect(asked.questions.q1).toMatchObject({
    reason: 'irreversible',
    recommended: 'yes',
    note: 'It changes two files.',
    action: { tool: 'open_pull_request', args: { branch: 'fix-1' } },
  });

  expect(
    await client.answer(conversationId, { questionId: 'q1', optionId: 'yes', text: 'Go' }),
  ).toEqual({
    accepted: true,
    duplicate: false,
  });
  expect(await client.answer(conversationId, { questionId: 'q1', optionId: 'yes' })).toEqual({
    accepted: true,
    duplicate: true,
  });
  await view.until((s) => s.answers.q1 === 'yes', 'the recorded answer');
  const codes = await Promise.all(
    [
      { questionId: 'q1', optionId: 'no' },
      { questionId: 'q1', optionId: 'maybe' },
      { questionId: 'nope', optionId: 'yes' },
    ].map((answer) =>
      client.answer(conversationId, answer).catch((error: ApiError) => [error.status, error.code]),
    ),
  );
  expect(codes).toEqual([
    [409, 'conflict'],
    [400, 'unknown_option'],
    [404, 'not_found'],
  ]);
  expect(stack.answers.filter((a) => a.questionId === 'q1')).toEqual([
    { questionId: 'q1', optionId: 'yes', text: 'Go', caller: invite.inviteId },
  ]);
  await view.stop();
});

test('results: files are listed by name and read as text, links come back as links', async () => {
  const { client, conversationId } = await fresh();
  const root = await stack.delegate(conversationId, { title: 'Research' });
  const run = await stack.run(root);
  await stack.writeArtifact(root, 'out/report.md', '# Findings\n\n<script>alert(1)</script>');
  await run.complete({
    ...MANIFEST,
    artifacts: ['out/report.md', 'https://github.com/example/repo/pull/7', '../../etc/passwd'],
  });
  await until(
    async () => (await client.listTasks(conversationId)).find((t) => t.state === 'succeeded'),
    'the task to finish',
  );
  const { artifacts, total } = await client.listArtifacts(root);
  expect(total).toBe(3);
  expect(artifacts.slice(0, 2)).toEqual([
    { index: 0, name: 'report.md', kind: 'file' },
    { index: 1, name: 'github.com', kind: 'link', url: 'https://github.com/example/repo/pull/7' },
  ]);
  expect(await client.readArtifact(root, 0)).toEqual({
    kind: 'text',
    name: 'report.md',
    text: '# Findings\n\n<script>alert(1)</script>',
  });
  expect(await client.readArtifact(root, 1)).toEqual({
    kind: 'link',
    url: 'https://github.com/example/repo/pull/7',
  });
  // A path that leaves the task's directory is not read, and the reason is not shown.
  await expect(client.readArtifact(root, 2)).rejects.toMatchObject({ status: 404 });
  await expect(client.readArtifact(root, 9)).rejects.toMatchObject({ status: 404 });
});

test('results: a screenshot arrives as a picture, a file that only claims to be one stays text', async () => {
  const { client, conversationId } = await fresh();
  const root = await stack.delegate(conversationId, { title: 'Fix the login page' });
  const run = await stack.run(root);
  const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7);
  await stack.writeArtifact(root, 'out/proof.png', png);
  await stack.writeArtifact(root, 'out/fake.png', '<svg onload="alert(1)"/>');
  await run.complete({ ...MANIFEST, artifacts: ['out/proof.png', 'out/fake.png'] });
  await until(
    async () => (await client.listTasks(conversationId)).find((t) => t.state === 'succeeded'),
    'the task to finish',
  );
  const { artifacts } = await client.listArtifacts(root);
  expect(artifacts).toEqual([
    { index: 0, name: 'proof.png', kind: 'file', image: true },
    { index: 1, name: 'fake.png', kind: 'file', image: true },
  ]);
  const picture = await client.readArtifact(root, 0);
  expect(picture.kind).toBe('image');
  expect(picture.kind === 'image' && picture.blob.type).toBe('image/png');
  expect(picture.kind === 'image' && picture.blob.size).toBe(png.length);
  expect(await client.readArtifact(root, 1)).toEqual({
    kind: 'text',
    name: 'fake.png',
    text: '<svg onload="alert(1)"/>',
  });
});

test('another invite sees nothing of a conversation: every route and the stream answer 404', async () => {
  const mine = await fresh();
  const task = await stack.delegate(mine.conversationId, { title: 'Private work' });
  await stack.run(task);
  stack.ask(mine.conversationId, {
    questionId: 'qp',
    question: 'Private?',
    options: [{ id: 'a', label: 'A' }],
    recommended: 'a',
  });
  const otherInvite = stack.newInvite();
  const other = clientFor(otherInvite.token);
  const status = (promise: Promise<unknown>) =>
    promise.then(
      () => 200,
      (error: unknown) => (error instanceof ApiError ? error.status : -1),
    );
  expect((await other.listConversations()).conversations).toEqual([]);
  expect(
    await Promise.all([
      status(other.postMessage(mine.conversationId, 'hello', 'x')),
      status(other.listTasks(mine.conversationId)),
      status(other.answer(mine.conversationId, { questionId: 'qp', optionId: 'a' })),
      status(other.control(task, 'cancel')),
      status(other.control(task, 'pause')),
      status(other.listArtifacts(task)),
      status(other.readArtifact(task, 0)),
    ]),
  ).toEqual([404, 404, 404, 404, 404, 404, 404]);
  // Nothing was done on the owner's behalf.
  expect(stack.answers.some((a) => a.questionId === 'qp')).toBe(false);
  expect((await mine.client.listTasks(mine.conversationId)).map((t) => t.state)).toEqual([
    'running',
  ]);

  const statuses: string[] = [];
  await other.subscribe(
    mine.conversationId,
    () => {},
    (s) => statuses.push(s),
    AbortSignal.timeout(2000),
  );
  expect(statuses).toEqual(['This conversation is not available.']);

  // The unfiltered stream carries only the invite's own conversations.
  const ownConversation = (await other.createConversation()).conversationId;
  const abort = new AbortController();
  const response = await fetch(`${stack.url}/v1/events`, {
    headers: { authorization: `Bearer ${otherInvite.token}` },
    signal: abort.signal,
  });
  const frames: FeedEvent[] = [];
  const reading = readEvents(response, (frame) => frames.push(frame)).catch(() => {});
  await until(() => frames.length > 0, 'the invite’s own events');
  await new Promise((resolve) => setTimeout(resolve, 200));
  abort.abort();
  await reading;
  expect(new Set(frames.map((frame) => frame.data.conversationId))).toEqual(
    new Set([ownConversation]),
  );
});

test('a revoked invite loses its stream and every request, and the client says so', async () => {
  const invite = stack.newInvite();
  let revoked = 0;
  const client = clientFor(invite.token, () => {
    revoked += 1;
  });
  const { conversationId } = await client.createConversation();
  const view = watch(client, conversationId);
  await view.until(() => view.statuses.includes('Live'), 'the stream');
  expect(stack.server.invites.revoke(invite.inviteId)).toBe(true);
  await until(
    () => view.statuses.includes('Invite expired. Reconnect with a valid invite.'),
    'the stream to end',
  );
  expect(revoked).toBeGreaterThan(0);
  await expect(client.postMessage(conversationId, 'still there?', 'r1')).rejects.toMatchObject({
    status: 401,
  });
  await view.stop();
});

test('no runner, model or vendor name reaches the client, even in a failure a runner wrote', async () => {
  const { client, conversationId } = await fresh();
  const view = watch(client, conversationId);
  const task = await stack.delegate(conversationId, { title: 'Doomed' });
  (await stack.run(task)).fail('Claude Code crashed while OpenAI gpt-5 answered');
  const state = await view.until((s) => s.tasks[task]?.state === 'failed', 'the failure');
  const everything = JSON.stringify([view.frames, await client.listTasks(conversationId)]);
  expect(everything).not.toMatch(NAMES);
  expect(everything).not.toContain('"runner"');
  expect(state.tasks[task]?.failureReason).toBe(
    'assistant Code crashed while assistant assistant-5 answered',
  );
  await view.stop();
});

test('a server without Web Push says so with a 404, and the client hides the control instead of guessing', async () => {
  const bare = await startStack({ push: false });
  try {
    const client = new CloudClient(bare.token, { baseUrl: bare.url });
    await expect(client.request(routes.pushKey, {}, 'push')).rejects.toBeInstanceOf(Unsupported);
    expect(client.unsupported.has('push')).toBe(true);
  } finally {
    await bare.close();
  }
  // With push configured, the same route answers with the public key, to an invite only.
  const keyed = await fetch(`${stack.url}${routes.pushKey}`, {
    headers: { authorization: `Bearer ${stack.token}` },
  });
  expect(keyed.status).toBe(200);
  expect(Object.keys(await keyed.json())).toEqual(['publicKey']);
  expect((await fetch(`${stack.url}${routes.pushKey}`)).status).toBe(401);
});

/** Finishes a top-level task and waits for the supervisor's "finished" item to reach the view. */
async function finishedItem(view: ReturnType<typeof watch>, conversationId: string, title: string) {
  const task = await stack.delegate(conversationId, { title });
  (await stack.run(task)).complete(MANIFEST);
  const state = await view.until(
    (s) => Object.values(s.inbox).some((item) => item.taskId === task && item.kind === 'finished'),
    'the finished item',
  );
  return Object.values(state.inbox).find(
    (item) => item.taskId === task && item.kind === 'finished',
  );
}

test('a finished task reaches the inbox with the supervisor’s own words, and one answer closes it once', async () => {
  const { client, conversationId } = await fresh();
  const view = watch(client, conversationId);
  const item = await finishedItem(view, conversationId, 'Weekly report');
  if (!item) throw new Error('no item');
  // The label is the supervisor's: with no verification configured it says so itself.
  expect(item.ask).toContain('(not independently checked)');
  expect(item.ask).not.toContain('(independently checked)');
  expect(item.state).toBe('open');
  expect(item.options.map((o) => [o.id, o.recommended])).toEqual([['ok', true]]);
  expect(JSON.stringify(view.frames)).not.toMatch(NAMES);

  // An answer to a state the person did not see is refused with the item as it is now.
  const stale = await client
    .answerInbox(item.itemId, { answerId: 'a_stale', optionId: 'ok', preconditionHash: 'not-it' })
    .catch((error: unknown) => error);
  expect(stale).toBeInstanceOf(ApiError);
  expect(stale).toMatchObject({ status: 409, code: 'stale' });
  expect((stale as ApiError).body).toMatchObject({ item: { itemId: item.itemId } });

  const answered = await client.answerInbox(item.itemId, {
    answerId: 'a_one',
    optionId: 'ok',
    preconditionHash: item.preconditionHash,
  });
  expect(answered.duplicate).toBe(false);
  expect(answered.item.state).toBe('closed');
  const closed = await view.until(
    (s) => s.inbox[item.itemId]?.state === 'closed',
    'the item to close in the view',
  );
  expect(closed.inbox[item.itemId]?.closeReason).toBe('acknowledged');

  // The same answer again is the same answer; a different one comes too late.
  const again = await client.answerInbox(item.itemId, {
    answerId: 'a_one',
    optionId: 'ok',
    preconditionHash: item.preconditionHash,
  });
  expect(again.duplicate).toBe(true);
  await expect(
    client.answerInbox(item.itemId, {
      answerId: 'a_two',
      optionId: 'ok',
      preconditionHash: item.preconditionHash,
    }),
  ).rejects.toMatchObject({ status: 409 });
  await view.stop();
});

test('another invite cannot see or answer an item, and a revoked invite cannot either', async () => {
  const { client, conversationId } = await fresh();
  const view = watch(client, conversationId);
  const item = await finishedItem(view, conversationId, 'Private report');
  if (!item) throw new Error('no item');
  const other = stack.newInvite();
  const outsider = clientFor(other.token);
  await expect(
    outsider.answerInbox(item.itemId, {
      answerId: 'x_one',
      optionId: 'ok',
      preconditionHash: item.preconditionHash,
    }),
  ).rejects.toMatchObject({ status: 404 });
  // Nothing happened to it, and the outsider's own stream never carried it.
  expect(
    (await view.until((s) => s.inbox[item.itemId], 'the item')).inbox[item.itemId]?.state,
  ).toBe('open');
  const abort = new AbortController();
  const response = await fetch(`${stack.url}/v1/events`, {
    headers: { authorization: `Bearer ${other.token}`, accept: 'text/event-stream' },
    signal: abort.signal,
  });
  const seen: FeedEvent[] = [];
  const reading = readEvents(response, (frame) => seen.push(frame)).catch(() => {});
  // Its own conversation proves the stream flows; the item is not in it.
  await outsider.createConversation();
  await until(() => seen.length > 0, 'the outsider’s own events');
  await new Promise((resolve) => setTimeout(resolve, 300));
  abort.abort();
  await reading;
  expect(JSON.stringify(seen)).not.toContain(item.itemId);

  const own = stack.newInvite();
  const ownClient = clientFor(own.token);
  const mine = await ownClient.createConversation();
  const ownView = watch(ownClient, mine.conversationId);
  const ownItem = await finishedItem(ownView, mine.conversationId, 'Mine');
  if (!ownItem) throw new Error('no item');
  expect(stack.server.invites.revoke(own.inviteId)).toBe(true);
  await expect(
    ownClient.answerInbox(ownItem.itemId, {
      answerId: 'r_one',
      optionId: 'ok',
      preconditionHash: ownItem.preconditionHash,
    }),
  ).rejects.toMatchObject({ status: 401 });
  await ownView.stop();
  await view.stop();
});
