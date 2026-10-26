import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { conductorSession, recordingHandler } from './conductor.js';
import { eventually, newConversation, openStream, postJson, startHarness } from './harness.js';

function fakeComputer() {
  const inputs: unknown[] = [];
  const signals: AbortSignal[] = [];
  let wake: (() => void) | undefined;
  return {
    inputs,
    signals,
    emit: () => wake?.(),
    source: {
      available: async () => true,
      async *watch(_task: string, signal: AbortSignal) {
        signals.push(signal);
        while (!signal.aborted) {
          yield { terminal: 'workspace $ ready\n' };
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }
      },
      input: async (_task: string, input: unknown, signal: AbortSignal) => {
        signal.throwIfAborted();
        inputs.push(input);
      },
    },
  };
}

test('computer handoff pauses before input, logs both ways, and keeps every route invite-scoped', async (t) => {
  const computer = fakeComputer();
  const handler = recordingHandler();
  const h = await startHarness(t, {
    ...{ computer: computer.source },
    fake: { pausable: true },
    handler: handler.handler,
  });
  const conversation = await newConversation(h);
  const { session } = await conductorSession(h, handler.seen, conversation);
  const task = await h.server.orchestrator.delegate(session, {
    runner: 'fake',
    brief: 'Fix the app',
  });
  await h.server.orchestrator.settled();
  const path = `/v1/tasks/${task.taskId}/computer`;
  const other = h.server.invites.create('other');
  for (const [suffix, method, body] of [
    ['', 'GET', undefined],
    ['/stream', 'GET', undefined],
    ['/takeover', 'POST', {}],
    ['/handback', 'POST', {}],
    ['/input', 'POST', { type: 'terminal', text: 'whoami\n' }],
  ] as const) {
    const response = await h.api(`${path}${suffix}`, {
      method,
      token: other.token,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(
      response.status,
      404,
      `${method} ${suffix} must not reveal another invite's computer`,
    );
  }
  assert.equal(computer.signals.length, 0);
  assert.equal(
    (await postJson(h, `${path}/input`, { type: 'terminal', text: 'pwd\n' })).status,
    409,
  );
  assert.equal((await postJson(h, `${path}/takeover`, {})).status, 200);
  assert.equal((await postJson(h, `${path}/takeover`, {})).status, 200);
  const tasks = (await (await h.api(`/v1/conversations/${conversation}/tasks`)).json()) as {
    tasks: { state: string }[];
  };
  assert.equal(tasks.tasks[0]?.state, 'paused');
  // An ordinary Resume must not bypass the computer's input lock.
  assert.equal((await postJson(h, `/v1/tasks/${task.taskId}/resume`, {})).status, 409);
  assert.equal(
    (await postJson(h, `${path}/input`, { type: 'terminal', text: 'pwd\n' })).status,
    200,
  );
  assert.deepEqual(computer.inputs, [{ type: 'terminal', text: 'pwd\n' }]);
  assert.equal((await postJson(h, `${path}/handback`, {})).status, 200);
  assert.equal(
    (await postJson(h, `${path}/input`, { type: 'terminal', text: 'no\n' })).status,
    409,
  );
  const resumed = (await (await h.api(`/v1/conversations/${conversation}/tasks`)).json()) as {
    tasks: { state: string }[];
  };
  assert.equal(resumed.tasks[0]?.state, 'running');
  const events = await openStream(t, h, `?conversation=${conversation}`);
  await eventually(
    () => events.events.filter((event) => event.event === 'conductor.notice').length === 2,
    'handoff log',
  );
  const text = JSON.stringify(events.events);
  events.close();
  assert.equal((text.match(/Computer control taken/g) ?? []).length, 1);
  assert.equal((text.match(/Computer control returned/g) ?? []).length, 1);
});

test('computer stream closes on revoke, including an idle source, and no more input is accepted', async (t) => {
  const computer = fakeComputer();
  const handler = recordingHandler();
  const h = await startHarness(t, {
    ...{ computer: computer.source },
    fake: { pausable: true },
    handler: handler.handler,
  });
  const conversation = await newConversation(h);
  const { session } = await conductorSession(h, handler.seen, conversation);
  const task = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: 'Fix' });
  await h.server.orchestrator.settled();
  const path = `/v1/tasks/${task.taskId}/computer`;
  const stream = await h.api(`${path}/stream`);
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /workspace \$ ready/);
  h.server.invites.revoke(h.inviteId);
  await eventually(() => computer.signals[0]?.aborted === true, 'source abort on revoke');
  assert.equal((await reader.read()).done, true);
  computer.emit();
  assert.equal((await postJson(h, `${path}/takeover`, {})).status, 401);
  assert.equal(computer.inputs.length, 0);
});

test('a runner without pause support never grants computer input', async (t) => {
  const computer = fakeComputer();
  const handler = recordingHandler();
  const h = await startHarness(t, {
    ...{ computer: computer.source },
    fake: { pausable: false },
    handler: handler.handler,
  });
  const conversation = await newConversation(h);
  const { session } = await conductorSession(h, handler.seen, conversation);
  const task = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: 'Fix' });
  await h.server.orchestrator.settled();
  const path = `/v1/tasks/${task.taskId}/computer`;
  assert.equal((await postJson(h, `${path}/takeover`, {})).status, 409);
  assert.equal(
    (await postJson(h, `${path}/input`, { type: 'terminal', text: 'no\n' })).status,
    409,
  );
  assert.equal(computer.inputs.length, 0);
});

test('revoke while pause is pending never grants control, even after the runner acknowledges', async (t) => {
  const computer = fakeComputer();
  const handler = recordingHandler();
  const h = await startHarness(t, { computer: computer.source, handler: handler.handler });
  const conversation = await newConversation(h);
  const { session } = await conductorSession(h, handler.seen, conversation);
  const task = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: 'Fix' });
  await h.server.orchestrator.settled();
  const hold = h.fake.runs[0]!.holdPause();
  const path = `/v1/tasks/${task.taskId}/computer`;
  const taking = postJson(h, `${path}/takeover`, {});
  await eventually(() => h.fake.runs[0]!.pauseCalls === 1, 'pause waiting');
  assert.equal(
    (await postJson(h, `${path}/input`, { type: 'terminal', text: 'too early\n' })).status,
    409,
  );
  h.server.invites.revoke(h.inviteId);
  hold.release();
  assert.equal((await taking).status, 401);
  assert.equal(computer.inputs.length, 0);
});

test('a failed handback leaves the task paused; pending handback accepts no input; retry resumes', async (t) => {
  const computer = fakeComputer();
  const handler = recordingHandler();
  const h = await startHarness(t, { computer: computer.source, handler: handler.handler });
  const conversation = await newConversation(h);
  const { session } = await conductorSession(h, handler.seen, conversation);
  const task = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: 'Fix' });
  await h.server.orchestrator.settled();
  const path = `/v1/tasks/${task.taskId}/computer`;
  assert.equal((await postJson(h, `${path}/takeover`, {})).status, 200);
  const hold = h.fake.runs[0]!.holdResume();
  const returning = postJson(h, `${path}/handback`, {});
  await eventually(() => h.fake.runs[0]!.resumeCalls === 1, 'resume waiting');
  assert.equal(
    (await postJson(h, `${path}/input`, { type: 'terminal', text: 'too late\n' })).status,
    409,
  );
  hold.fail(new Error('fake resume failure'));
  assert.equal((await returning).status, 409);
  assert.equal(h.fake.runs[0]!.paused, true);
  assert.equal(
    (await postJson(h, `${path}/input`, { type: 'terminal', text: 'still held\n' })).status,
    200,
  );
  assert.equal((await postJson(h, `${path}/handback`, {})).status, 200);
  assert.equal(h.fake.runs[0]!.paused, false);
});

test('CLI revoke closes an idle computer and aborts an input still waiting at the adapter', async (t) => {
  const computer = fakeComputer();
  const handler = recordingHandler();
  let waiting: AbortSignal | undefined;
  const h = await startHarness(t, {
    computer: {
      ...computer.source,
      input: async (_task, _input, signal) => {
        waiting = signal;
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        signal.throwIfAborted();
      },
    },
    handler: handler.handler,
    http: { revokeCheckMs: 10 },
  });
  const conversation = await newConversation(h);
  const { session } = await conductorSession(h, handler.seen, conversation);
  const task = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: 'Fix' });
  await h.server.orchestrator.settled();
  const path = `/v1/tasks/${task.taskId}/computer`;
  assert.equal((await postJson(h, `${path}/takeover`, {})).status, 200);
  const stream = await h.api(`${path}/stream`);
  const reader = stream.body!.getReader();
  await reader.read();
  const input = postJson(h, `${path}/input`, { type: 'terminal', text: 'pending\n' });
  await eventually(() => waiting !== undefined, 'input waiting');
  await promisify(execFile)(process.execPath, [
    new URL('../cli.js', import.meta.url).pathname,
    'invite',
    'revoke',
    h.inviteId,
    '--invites',
    h.options.invitesPath,
  ]);
  await eventually(
    () => waiting?.aborted === true && computer.signals[0]?.aborted === true,
    'external revoke aborts input and stream',
  );
  assert.equal((await reader.read()).done, true);
  assert.equal((await input).status, 401);
  assert.equal(computer.inputs.length, 0);
});

test('stream setup rechecks authorization after the adapter lookup and before opening any stream', async (t) => {
  const computer = fakeComputer();
  const handler = recordingHandler();
  let release!: (available: boolean) => void;
  const lookup = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  let looking = false;
  const h = await startHarness(t, {
    computer: {
      ...computer.source,
      available: () => {
        looking = true;
        return lookup;
      },
    },
    handler: handler.handler,
  });
  const conversation = await newConversation(h);
  const { session } = await conductorSession(h, handler.seen, conversation);
  const task = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: 'Fix' });
  await h.server.orchestrator.settled();
  const response = h.api(`/v1/tasks/${task.taskId}/computer/stream`);
  await eventually(() => looking, 'adapter lookup');
  h.server.invites.revoke(h.inviteId);
  release(true);
  assert.equal((await response).status, 401);
  assert.equal(computer.signals.length, 0);
  assert.equal(h.server.openStreams(), 0);
});

test('computer streams share feed quotas, release slots on disconnect, and close on task cancel', async (t) => {
  const computer = fakeComputer();
  const handler = recordingHandler();
  const h = await startHarness(t, {
    computer: computer.source,
    handler: handler.handler,
    http: { streamsPerInvite: 1 },
  });
  const conversation = await newConversation(h);
  const { session } = await conductorSession(h, handler.seen, conversation);
  const task = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: 'Fix' });
  await h.server.orchestrator.settled();
  const path = `/v1/tasks/${task.taskId}/computer`;
  const first = await h.api(`${path}/stream`);
  assert.equal(first.status, 200);
  assert.equal((await h.api(`${path}/stream`)).status, 429);
  assert.equal((await h.api('/v1/events')).status, 429);
  await first.body!.cancel();
  await eventually(() => h.server.openStreams() === 0, 'disconnect releases quota');
  const second = await h.api(`${path}/stream`);
  assert.equal(second.status, 200);
  const reader = second.body!.getReader();
  await reader.read();
  assert.equal((await postJson(h, `/v1/tasks/${task.taskId}/cancel`, {})).status, 200);
  assert.equal((await reader.read()).done, true);
  assert.equal((await postJson(h, `${path}/takeover`, {})).status, 409);
});

test('computer inputs have a separate typing budget and cannot exhaust control actions', async (t) => {
  const computer = fakeComputer();
  const handler = recordingHandler();
  const h = await startHarness(t, {
    computer: computer.source,
    fake: { pausable: true },
    handler: handler.handler,
  });
  const conversation = await newConversation(h);
  const { session } = await conductorSession(h, handler.seen, conversation);
  const task = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: 'Type' });
  await h.server.orchestrator.settled();
  const path = `/v1/tasks/${task.taskId}/computer`;
  assert.equal((await postJson(h, `${path}/takeover`, {})).status, 200);
  let accepted = 0;
  let throttled = 0;
  for (let i = 0; i < 60; i++) {
    const response = await postJson(h, `${path}/input`, { type: 'key', key: 'a' });
    if (response.status === 200) accepted++;
    else {
      assert.equal(response.status, 429);
      assert.ok(response.headers.get('retry-after'));
      throttled++;
    }
  }
  assert.ok(accepted >= 20, 'typing burst is accepted');
  assert.ok(throttled > 0, 'typing remains rate limited');
  assert.equal((await postJson(h, `${path}/handback`, {})).status, 200);
  assert.equal((await postJson(h, `/v1/tasks/${task.taskId}/cancel`, {})).status, 200);
});

test('computer input burst and refill rate follow the configured HTTP limits', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const computer = fakeComputer();
  const handler = recordingHandler();
  const h = await startHarness(t, {
    computer: computer.source,
    fake: { pausable: true },
    handler: handler.handler,
    http: { inputPerMinute: 60, inputBurst: 2 },
  });
  const conversation = await newConversation(h);
  const { session } = await conductorSession(h, handler.seen, conversation);
  const task = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: 'Type' });
  await h.server.orchestrator.settled();
  const path = `/v1/tasks/${task.taskId}/computer`;
  assert.equal((await postJson(h, `${path}/takeover`, {})).status, 200);
  const input = () => postJson(h, `${path}/input`, { type: 'key', key: 'a' });
  assert.equal((await input()).status, 200);
  assert.equal((await input()).status, 200);
  assert.equal((await input()).status, 429, 'the configured two-input burst is exhausted');
  now += 999;
  assert.equal((await input()).status, 429, 'the configured rate refills one token per second');
  now += 1;
  assert.equal((await input()).status, 200);
  assert.equal((await input()).status, 429, 'only one token was replenished');
  assert.equal(computer.inputs.length, 3);
  assert.equal((await postJson(h, `${path}/handback`, {})).status, 200);
});
