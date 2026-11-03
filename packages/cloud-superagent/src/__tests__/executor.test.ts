import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  EXECUTOR_SESSIONS_DOCUMENT,
  ExecutorCoder,
  FakeExecutor,
  RECOVERY_NOTE,
  STATUS_MARKER,
  StoreExecutorSessionStore,
  driveTurn,
  eventsOf,
  executorSystemPrompt,
  gitChanged,
  parseStatusLine,
  stripStatusLine,
  type ExecutorEvent,
} from '../executor.js';
import {
  ADD_FIXED,
  CodingLoopHandler,
  FakeGitHost,
  NodeFileTestPort,
  scratchFiles,
} from '../loop.js';
import { MemorySuperagentStore } from '../memory-store.js';
import { FakeSandbox } from '../sandbox.js';
import { actMandate, type NormalizedEvent, type WorkerRecord } from '../types.js';
import { initLocalRepo } from '../workspace.js';

const REPO = 'acme/app';

function event(type: string, summary = 'fix add'): NormalizedEvent {
  return {
    eventId: `e-${type}`,
    tenantId: 't',
    source: 'github',
    type,
    subject: { key: `${REPO}#1`, repo: REPO, kind: 'pr', number: 1 } as never,
    idempotencyKey: `k-${type}`,
    actor: { login: 'alice', kind: 'user' },
    occurredAt: 1,
    receivedAt: 1,
    summary,
    fields: [],
    closesSubject: false,
  } as NormalizedEvent;
}

function worker(workerId = 'w1'): WorkerRecord {
  return {
    workerId,
    tenantId: 't',
    subject: { key: `${REPO}#1`, repo: REPO },
    mandate: actMandate([REPO]),
    plan: 'fix add',
  } as unknown as WorkerRecord;
}

test('status line: ready, needs-person with options, blocked, and garbage', () => {
  assert.deepEqual(parseStatusLine(`done\n${STATUS_MARKER} {"status":"ready","summary":"ok"}`), {
    type: 'ready',
    summary: 'ok',
  });
  assert.deepEqual(
    parseStatusLine(
      `${STATUS_MARKER} {"status":"needs-person","question":"Which DB?","options":["pg","sqlite"],"reason":"schema"}`,
    ),
    {
      type: 'needs-person',
      ask: { question: 'Which DB?', options: ['pg', 'sqlite'], reason: 'schema' },
    },
  );
  assert.deepEqual(
    parseStatusLine(`\`${STATUS_MARKER}: {"status":"blocked","reason":"no access"}\``),
    {
      type: 'blocked',
      reason: 'no access',
    },
  );
  assert.equal(parseStatusLine('no marker here'), undefined);
  assert.equal(parseStatusLine(`${STATUS_MARKER} {not json`), undefined);
  assert.equal(stripStatusLine(`fixed it\n${STATUS_MARKER} {"status":"ready"}`), 'fixed it');
});

test('system prompt is byte-stable for one mandate and carries the status contract', () => {
  const mandate = actMandate([REPO]);
  const first = executorSystemPrompt(mandate, 'Use tabs.');
  assert.equal(first, executorSystemPrompt(actMandate([REPO]), 'Use tabs.'));
  assert.match(first, /Do not push/);
  assert.match(first, new RegExp(STATUS_MARKER));
  assert.match(first, /Team rules:\nUse tabs\./);
});

test('a turn without a terminal event counts as failed; usage deltas add up', async () => {
  const ran = await driveTurn({
    session: {} as never,
    events: eventsOf([
      { type: 'usage', usage: { inputTokens: 5, usdMicros: 10 } },
      { type: 'usage', usage: { inputTokens: 7, outputTokens: 2, turns: 1 } },
    ]),
  });
  assert.equal(ran.terminal.type, 'failed');
  assert.equal(ran.usage.inputTokens, 12);
  assert.equal(ran.usage.outputTokens, 2);
  assert.equal(ran.usage.usdMicros, 10);
});

test('gitChanged lists modified and untracked files, not deleted ones', async () => {
  const dir = await initLocalRepo(scratchFiles());
  await writeFile(join(dir, 'add.js'), ADD_FIXED);
  await writeFile(join(dir, 'new.txt'), 'x');
  assert.deepEqual((await gitChanged(dir)).sort(), ['add.js', 'new.txt']);
});

test('ExecutorCoder starts one session and sends follow-ups into the same session', async () => {
  const dir = await initLocalRepo(scratchFiles());
  const executor = new FakeExecutor({ files: { 'add.js': ADD_FIXED } });
  const coder = new ExecutorCoder(executor);
  const first = await coder.apply({
    dir,
    brief: 'fix add',
    event: event('pr_opened'),
    worker: worker(),
  });
  assert.deepEqual(first.changed, ['add.js']);
  assert.equal(first.files['add.js'], ADD_FIXED);
  assert.equal(first.usage?.tokens, 40);
  assert.equal(first.outcome, undefined);
  await coder.apply({ dir, brief: 'CI failed', event: event('ci_failed'), worker: worker() });
  await coder.apply({ dir, brief: 'nit', event: event('review_comment'), worker: worker() });
  assert.deepEqual(
    executor.calls.map((call) => [call.op, call.inputKind ?? null]),
    [
      ['start', null],
      ['send', 'ci'],
      ['send', 'review'],
    ],
  );
  assert.equal(new Set(executor.calls.map((call) => call.sessionId)).size, 1);
});

test('after a restart a stored session resumes with the recovery note; follow-ups stay in it', async () => {
  const dir = await initLocalRepo(scratchFiles());
  const store = new MemorySuperagentStore();
  const before = new FakeExecutor({ files: { 'add.js': ADD_FIXED } });
  await new ExecutorCoder(before, { sessions: new StoreExecutorSessionStore(store) }).apply({
    dir,
    brief: 'fix add',
    event: event('pr_opened'),
    worker: worker(),
  });
  const sessionId = before.calls[0]?.sessionId;
  assert.ok(store.getDocument('t', EXECUTOR_SESSIONS_DOCUMENT)?.includes(sessionId as string));
  assert.equal(store.getDocument('', EXECUTOR_SESSIONS_DOCUMENT), undefined, 'stored per tenant');

  // A new process: new coder and executor, same store.
  const after = new FakeExecutor({ files: { 'add.js': ADD_FIXED } });
  const coder = new ExecutorCoder(after, { sessions: new StoreExecutorSessionStore(store) });
  await coder.apply({ dir, brief: 'CI failed', event: event('ci_failed'), worker: worker() });
  await coder.apply({ dir, brief: 'nit', event: event('review_comment'), worker: worker() });
  assert.deepEqual(
    after.calls.map((call) => [call.op, call.sessionId]),
    [
      ['resume', sessionId],
      ['send', sessionId],
    ],
  );
  assert.equal(after.calls[0]?.text, `${RECOVERY_NOTE}\n\nCI failed`);
  assert.equal(after.calls[1]?.text, 'nit');

  // Another tenant's worker with the same id does not see this session.
  const other = new FakeExecutor({ files: { 'add.js': ADD_FIXED } });
  await new ExecutorCoder(other, { sessions: new StoreExecutorSessionStore(store) }).apply({
    dir,
    brief: 'fix add',
    event: event('pr_opened'),
    worker: { ...worker(), tenantId: 't2' } as WorkerRecord,
  });
  assert.equal(other.calls[0]?.op, 'start');
});

test('a session from a box that was rebuilt starts over instead of resuming', async () => {
  const store = new MemorySuperagentStore();
  const sessions = new StoreExecutorSessionStore(store);
  const sandbox = new FakeSandbox();
  const boxed = (sandboxRef: string) => ({ ...worker(), sandboxRef }) as WorkerRecord;
  const steps = () => [[{ type: 'ready', summary: 'ok' } as ExecutorEvent]];
  // The fake box has no checkout to read changes from; only the session choice matters here.
  const ignore = () => undefined;
  const first = new FakeExecutor({ steps: steps() });
  const box = { sandbox, workdir: '/w' };
  await new ExecutorCoder(first, { sessions, box })
    .apply({ brief: 'fix add', event: event('pr_opened'), worker: boxed('box-a') })
    .catch(ignore);
  assert.equal((await sessions.get('w1', 't'))?.boxId, 'box-a');
  const second = new FakeExecutor({ steps: steps() });
  await new ExecutorCoder(second, { sessions, box })
    .apply({ brief: 'CI failed', event: event('ci_failed'), worker: boxed('box-b') })
    .catch(ignore);
  assert.deepEqual(
    second.calls.map((call) => call.op),
    ['start'],
  );
});

test('different workers get different sessions', async () => {
  const executor = new FakeExecutor({ files: { 'a.txt': 'a' } });
  const coder = new ExecutorCoder(executor);
  await coder.apply({
    dir: await initLocalRepo(scratchFiles()),
    brief: 'a',
    event: event('pr_opened'),
    worker: worker('w1'),
  });
  await coder.apply({
    dir: await initLocalRepo(scratchFiles()),
    brief: 'b',
    event: event('pr_opened'),
    worker: worker('w2'),
  });
  assert.deepEqual(
    executor.calls.map((call) => call.op),
    ['start', 'start'],
  );
  assert.notEqual(executor.calls[0]?.sessionId, executor.calls[1]?.sessionId);
});

async function runLoopWith(steps: ExecutorEvent[][]) {
  const repoDir = await initLocalRepo(scratchFiles());
  const git = new FakeGitHost();
  const handler = new CodingLoopHandler({
    coder: new ExecutorCoder(new FakeExecutor({ steps })),
    tests: new NodeFileTestPort(),
    git,
    sandbox: new FakeSandbox(),
    repoUrl: repoDir,
  });
  const w = { ...worker(), sandboxRef: 'box-1' } as WorkerRecord;
  const result = await handler.handle(
    { worker: w, event: event('pr_opened') } as never,
    event('pr_opened'),
  );
  return { result, git };
}

test('needs-person stops before tests and push and waits on a human', async () => {
  const { result, git } = await runLoopWith([
    [
      { type: 'progress', text: 'reading' },
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, usdMicros: 900, turns: 2 } },
      {
        type: 'needs-person',
        ask: { question: 'Drop the legacy API?', options: ['yes', 'no'], reason: 'breaking' },
      },
    ],
  ]);
  assert.equal(git.pushes.length, 0);
  assert.equal(result.progressUpdate?.waiting?.kind, 'human');
  assert.match(result.progressUpdate?.waiting?.detail ?? '', /Drop the legacy API/);
  const ask = result.evidence?.find((row) => row.label === 'needs-person');
  assert.match(ask?.body ?? '', /- yes\n- no/);
  assert.equal(result.usage?.tokens, 120);
  assert.equal(
    result.evidence?.some((row) => row.kind === 'test'),
    false,
  );
});

test('blocked waits on a human; failed reports no progress and does not push', async () => {
  const blocked = await runLoopWith([[{ type: 'blocked', reason: 'no write access to vendor/' }]]);
  assert.equal(blocked.git.pushes.length, 0);
  assert.match(blocked.result.progressUpdate?.waiting?.detail ?? '', /blocked: no write access/);

  const failed = await runLoopWith([[{ type: 'failed', error: 'process exited 1' }]]);
  assert.equal(failed.git.pushes.length, 0);
  assert.equal(failed.result.progress, false);
  assert.match(failed.result.stepSignature ?? '', /^executor-failed:/);
});
