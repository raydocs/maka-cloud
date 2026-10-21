import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  FakeRunner,
  MemoryTaskStore,
  Orchestrator,
  RunnerRegistry,
} from '@maka-cloud/orchestrator';
import { isRunning, reader, setup } from './harness.js';

async function handoffDir(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'runners-handoff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('through the real orchestrator: delegate, run in the sandbox, validated manifest comes back', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const orchestrator = await Orchestrator.create({
    store: new MemoryTaskStore(),
    runners: new RunnerRegistry(h.runners.runners),
    handoffRoot: await handoffDir(t),
  });
  const session = orchestrator.issueSession();
  const info = orchestrator.authenticate(session.token);
  assert.ok(info);

  const started = await orchestrator.delegate(info, {
    runner: 'claude-agent-sdk',
    brief: '# Brief\n\nSay hello.',
    title: 'hello',
  });
  const done = await orchestrator.wait(info, started.taskId, 20_000);
  assert.equal(done.state, 'succeeded', JSON.stringify(done));
  assert.equal(done.manifest?.summary, 'fake run complete');
  assert.ok(done.progress.includes('working on it'));

  const other = await orchestrator.delegate(info, { runner: 'codex', brief: 'again' });
  assert.equal((await orchestrator.wait(info, other.taskId, 20_000)).state, 'succeeded');
});

test('a failing CLI fails the task with its reason', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('fail');
  const orchestrator = await Orchestrator.create({
    store: new MemoryTaskStore(),
    runners: new RunnerRegistry(h.runners.runners),
    handoffRoot: await handoffDir(t),
  });
  const info = orchestrator.authenticate(orchestrator.issueSession().token);
  assert.ok(info);
  const started = await orchestrator.delegate(info, { runner: 'claude-agent-sdk', brief: 'x' });
  const done = await orchestrator.wait(info, started.taskId, 20_000);
  assert.equal(done.state, 'failed');
  assert.match(done.failureReason ?? '', /model said no/);
});

test('cancelling the task stops the CLI in the sandbox', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('hang');
  const orchestrator = await Orchestrator.create({
    store: new MemoryTaskStore(),
    runners: new RunnerRegistry(h.runners.runners),
    handoffRoot: await handoffDir(t),
  });
  const info = orchestrator.authenticate(orchestrator.issueSession().token);
  assert.ok(info);
  const started = await orchestrator.delegate(info, { runner: 'claude-agent-sdk', brief: 'x' });
  const pid = await h.runPid(started.taskId);
  assert.equal(await isRunning(pid), true);
  const cancelled = await orchestrator.cancel(info, started.taskId);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(await isRunning(pid), false);
});

/** The same runners without `recover`: a restart ends their unfinished tasks as orphaned. */
function withoutRecover<T extends object>(runners: T[]): T[] {
  return runners.map((runner) => Object.assign(Object.create(runner), { recover: undefined }));
}

/** A log that says a task is running, whose CLI runs in the sandbox; the process that wrote it is gone. */
async function leftRunning(
  h: Awaited<ReturnType<typeof setup>>,
  t: Parameters<typeof handoffDir>[0],
) {
  await h.setMode('hang');
  const store = new MemoryTaskStore();
  const handoffRoot = await handoffDir(t);
  const crashing = new FakeRunner({ name: 'claude-agent-sdk' });
  const before = await Orchestrator.create({
    store,
    runners: new RunnerRegistry([crashing]),
    handoffRoot,
  });
  const info = before.authenticate(before.issueSession().token);
  assert.ok(info);
  const task = await orchestrator_delegate(before, info);
  const spec = crashing.runs[0]?.spec;
  assert.ok(spec);
  const events = reader(await h.runners.claude.start(spec));
  await events.until((e) => e.type === 'progress' && e.note === 'working on it');
  const pid = await h.runPid(task);
  assert.equal(await isRunning(pid), true);
  return { store, handoffRoot, info, task, pid, events };
}

test('a restart finds the task left running and has the runner stop its CLI by task id; without a recover the task is orphaned', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const { store, handoffRoot, info, task, pid, events } = await leftRunning(h, t);

  // After the restart: new orchestrator, new runner objects, same log and same sandbox.
  const restarted = h.makeRunners();
  const after = await Orchestrator.create({
    store,
    runners: new RunnerRegistry(withoutRecover(restarted.runners)),
    handoffRoot,
  });
  assert.equal(await isRunning(pid), false);
  const view = after.status(info, task);
  assert.equal(view.state, 'failed');
  assert.deepEqual(after.orphanedTaskIds, [task]);
  await events.rest();
});

test('a restart stops the old CLI by task id and resumes the task in its recorded session', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const { store, handoffRoot, info, task, pid, events } = await leftRunning(h, t);

  const restarted = h.makeRunners();
  const after = await Orchestrator.create({
    store,
    runners: new RunnerRegistry(restarted.runners),
    handoffRoot,
  });
  t.after(() => after.close());
  assert.equal(await isRunning(pid), false, 'the old CLI was stopped');
  assert.deepEqual(after.resumedTaskIds, [task]);
  assert.deepEqual(after.orphanedTaskIds, []);
  assert.equal(after.status(info, task).state, 'running');

  // The resumed turn is a new run of the same session, told what happened.
  let resumedPid = 0;
  for (let i = 0; i < 200 && resumedPid === 0; i += 1) {
    resumedPid = await h.runPid(task, 't2').catch(() => 0);
    if (resumedPid === 0) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.notEqual(resumedPid, 0, 'the recovered run started');
  assert.equal(await isRunning(resumedPid), true);
  let call: Awaited<ReturnType<typeof h.cliCall>> | undefined;
  for (let i = 0; i < 200 && call === undefined; i += 1) {
    call = await h.cliCall('claude', 2).catch(() => undefined);
    if (call === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(call, 'the recovered CLI was called');
  const { argv } = call;
  assert.equal(argv[argv.indexOf('--resume') + 1], 'sess-1');
  assert.match(argv[argv.indexOf('-p') + 1] ?? '', /^The server running this task restarted/u);

  // The conductor's token died with the old process; the public API acts for the conversation.
  const cancelled = await after.cancelAs(
    { sessionId: info.sessionId, authorize: () => undefined },
    task,
  );
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(await isRunning(resumedPid), false);
  await events.rest();
});

async function orchestrator_delegate(
  orchestrator: Orchestrator,
  info: NonNullable<ReturnType<Orchestrator['authenticate']>>,
) {
  const view = await orchestrator.delegate(info, { runner: 'claude-agent-sdk', brief: 'x' });
  return view.taskId;
}

test('a run that fails on its own and could not be stopped leaves its task failed with the stop owed, and a stop by id clears it', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('fail');
  const orchestrator = await Orchestrator.create({
    store: new MemoryTaskStore(),
    runners: new RunnerRegistry(h.runners.runners),
    handoffRoot: await handoffDir(t),
    stopRetry: { firstMs: 5, maxMs: 5 },
  });
  t.after(() => orchestrator.close());
  const info = orchestrator.authenticate(orchestrator.issueSession().token);
  assert.ok(info);
  h.fake.onExec = (request) =>
    request.body.cmd.includes('SURVIVORS')
      ? { status: 503, error: { code: 'host_unavailable', message: 'down', retryable: false } }
      : undefined;
  const started = await orchestrator.delegate(info, { runner: 'claude-agent-sdk', brief: 'x' });
  const done = await orchestrator.wait(info, started.taskId, 20_000);
  assert.equal(done.state, 'failed');
  await orchestrator.settled();
  const owed = orchestrator.status(info, started.taskId);
  assert.equal(owed.stopPending, true, 'the failed task must not read as settleable');

  h.fake.onExec = undefined;
  for (let i = 0; i < 200 && orchestrator.status(info, started.taskId).stopPending; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(orchestrator.status(info, started.taskId).stopPending, undefined);
});
