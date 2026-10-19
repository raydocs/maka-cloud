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

test('a restart finds the task left running and has the runner stop its CLI by task id', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('hang');
  const store = new MemoryTaskStore();
  const handoffRoot = await handoffDir(t);

  // Before the crash: the log says a task is running, and its CLI runs in the sandbox.
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

  // After the restart: new orchestrator, new runner objects, same log and same sandbox.
  const restarted = h.makeRunners();
  const after = await Orchestrator.create({
    store,
    runners: new RunnerRegistry(restarted.runners),
    handoffRoot,
  });
  assert.equal(await isRunning(pid), false);
  const view = after.status(info, task);
  assert.equal(view.state, 'failed');
  assert.deepEqual(after.orphanedTaskIds, [task]);
  await events.rest();
});

async function orchestrator_delegate(
  orchestrator: Orchestrator,
  info: NonNullable<ReturnType<Orchestrator['authenticate']>>,
) {
  const view = await orchestrator.delegate(info, { runner: 'claude-agent-sdk', brief: 'x' });
  return view.taskId;
}
