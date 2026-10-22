import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionInfo } from '../auth.js';
import type { FakeRunnerOptions } from '../fake-runner.js';
import { holdNote, type OrchestratorOptions } from '../orchestrator.js';
import { MemoryTaskStore } from '../store.js';
import { eventually, type Harness, makeHarness } from './harness.js';

/** A harness whose conductor sessions each belong to the group they were made for. */
async function grouped(
  t: Parameters<typeof makeHarness>[0],
  options: {
    perGroup?: number;
    store?: MemoryTaskStore;
    dir?: string;
    fake?: FakeRunnerOptions;
    groups?: Map<string, string>;
    orchestrator?: Partial<OrchestratorOptions>;
  } = {},
) {
  const groups = options.groups ?? new Map<string, string>();
  const h = await makeHarness(t, {
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.dir === undefined ? {} : { dir: options.dir }),
    ...(options.fake === undefined ? {} : { fake: options.fake }),
    orchestrator: {
      admission: {
        groupOf: (sessionId) => groups.get(sessionId),
        perGroup: options.perGroup ?? 1,
      },
      ...options.orchestrator,
    },
  });
  const conductor = (group: string): SessionInfo => {
    const session = h.session();
    groups.set(session.sessionId, group);
    return session;
  };
  return { h, conductor, groups };
}

const started = (h: Harness, taskId: string) => h.fake.runs.some((r) => r.spec.taskId === taskId);

test('a second task of one group waits, says why, and starts when the first one ends', async (t) => {
  const { h, conductor } = await grouped(t);
  const a = conductor('invite-1');
  const b = conductor('invite-1');
  const first = await h.orchestrator.delegate(a, {
    runner: 'fake',
    brief: 'one',
    title: 'Fix the login page',
  });
  await eventually(() => started(h, first.taskId), 'the first run');

  const second = await h.orchestrator.delegate(b, { runner: 'fake', brief: 'two' });
  assert.equal(second.state, 'queued');
  assert.equal(
    second.progress.at(-1),
    'One task runs at a time on this workspace for now. This one starts when "Fix the login page" finishes.',
  );
  await h.orchestrator.settled();
  assert.equal(started(h, second.taskId), false);
  assert.equal(h.orchestrator.stats().heldTasks, 1);

  await h.fake.runFor(first.taskId).complete();
  await eventually(() => started(h, second.taskId), 'the second run');
  await eventually(
    () => h.orchestrator.status(b, second.taskId).state === 'running',
    'the second task running',
  );
  assert.equal(h.orchestrator.stats().heldTasks, 0);
});

test('tasks of one conversation wait in order, and each says how many are before it', async (t) => {
  const { h, conductor } = await grouped(t);
  const c = conductor('invite-1');
  const first = await h.orchestrator.delegate(c, { runner: 'fake', brief: '1', title: 'First' });
  const second = await h.orchestrator.delegate(c, { runner: 'fake', brief: '2' });
  const third = await h.orchestrator.delegate(c, { runner: 'fake', brief: '3' });
  assert.equal(
    third.progress.at(-1),
    'One task runs at a time on this workspace for now. This one starts after "First" and the task waiting before it.',
  );
  await eventually(() => started(h, first.taskId), 'the first run');

  await h.fake.runFor(first.taskId).complete();
  await eventually(() => started(h, second.taskId), 'the second run');
  await h.orchestrator.settled();
  assert.equal(started(h, third.taskId), false);
  // The third one's note follows the line.
  await eventually(
    () =>
      h.orchestrator.status(c, third.taskId).progress.at(-1) ===
      'One task runs at a time on this workspace for now. This one starts when the running task finishes.',
    'the refreshed note',
  );

  await h.fake.runFor(second.taskId).complete();
  await eventually(() => started(h, third.taskId), 'the third run');
});

test('a task the running task delegates is not held by its own tree', async (t) => {
  const { h, conductor } = await grouped(t);
  const c = conductor('invite-1');
  const parent = await h.orchestrator.delegate(c, { runner: 'fake', brief: 'p' });
  await eventually(() => started(h, parent.taskId), 'the parent run');
  // Another top-level task waits, and the parent's child still starts.
  const waiting = await h.orchestrator.delegate(c, { runner: 'fake', brief: 'w' });
  const child = await h.orchestrator.delegate(h.executorSession(parent.taskId), {
    runner: 'fake',
    brief: 'c',
  });
  await eventually(() => started(h, child.taskId), 'the child run');
  const grandchild = await h.orchestrator.delegate(h.executorSession(child.taskId), {
    runner: 'fake',
    brief: 'g',
  });
  await eventually(() => started(h, grandchild.taskId), 'the grandchild run');
  await h.orchestrator.settled();
  assert.equal(started(h, waiting.taskId), false);
});

test('a tree holds its place until nothing of it runs, not only until its top task ends', async (t) => {
  const { h, conductor } = await grouped(t);
  const c = conductor('invite-1');
  const parent = await h.orchestrator.delegate(c, { runner: 'fake', brief: 'p' });
  await eventually(() => started(h, parent.taskId), 'the parent run');
  const child = await h.orchestrator.delegate(h.executorSession(parent.taskId), {
    runner: 'fake',
    brief: 'c',
  });
  await eventually(() => started(h, child.taskId), 'the child run');
  const waiting = await h.orchestrator.delegate(c, { runner: 'fake', brief: 'w' });
  // The child's cancel does not finish at once: until it does, its run may still be going.
  const childRun = h.fake.runFor(child.taskId);
  let letCancelFinish!: () => void;
  const cancelDone = new Promise<void>((resolve) => {
    letCancelFinish = resolve;
  });
  childRun.cancel = async () => {
    childRun.cancelCalls += 1;
    await cancelDone;
    childRun.end();
  };

  await h.fake.runFor(parent.taskId).complete();
  await eventually(() => childRun.cancelCalls === 1, 'the child cancel');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(started(h, waiting.taskId), false);

  letCancelFinish();
  await eventually(() => started(h, waiting.taskId), 'the waiting run');
});

test('groups do not wait for each other, and a task with no group is never held', async (t) => {
  const { h, conductor } = await grouped(t);
  const one = await h.orchestrator.delegate(conductor('invite-1'), { runner: 'fake', brief: '1' });
  const two = await h.orchestrator.delegate(conductor('invite-2'), { runner: 'fake', brief: '2' });
  const loose = h.session();
  const three = await h.orchestrator.delegate(loose, { runner: 'fake', brief: '3' });
  const four = await h.orchestrator.delegate(loose, { runner: 'fake', brief: '4' });
  for (const task of [one, two, three, four]) {
    await eventually(() => started(h, task.taskId), `run ${task.taskId}`);
  }
});

test('a cancelled waiting task never runs, and the line moves on past it', async (t) => {
  const { h, conductor } = await grouped(t);
  const c = conductor('invite-1');
  const first = await h.orchestrator.delegate(c, { runner: 'fake', brief: '1' });
  const second = await h.orchestrator.delegate(c, { runner: 'fake', brief: '2' });
  const third = await h.orchestrator.delegate(c, { runner: 'fake', brief: '3' });
  await eventually(() => started(h, first.taskId), 'the first run');

  const cancelled = await h.orchestrator.cancel(c, second.taskId);
  assert.equal(cancelled.state, 'cancelled');
  await h.fake.runFor(first.taskId).complete();
  await eventually(() => started(h, third.taskId), 'the third run');
  assert.equal(started(h, second.taskId), false);
  assert.equal(h.orchestrator.stats().heldTasks, 0);
});

test('with room for two, a third task waits for one of them', async (t) => {
  const { h, conductor } = await grouped(t, { perGroup: 2 });
  const c = conductor('invite-1');
  const first = await h.orchestrator.delegate(c, { runner: 'fake', brief: '1' });
  const second = await h.orchestrator.delegate(c, { runner: 'fake', brief: '2' });
  const third = await h.orchestrator.delegate(c, { runner: 'fake', brief: '3' });
  assert.equal(
    third.progress.at(-1),
    '2 tasks run at a time on this workspace for now. This one starts when one of them finishes.',
  );
  await eventually(() => started(h, first.taskId) && started(h, second.taskId), 'two runs');
  await h.orchestrator.settled();
  assert.equal(started(h, third.taskId), false);
  await h.fake.runFor(second.taskId).complete();
  await eventually(() => started(h, third.taskId), 'the third run');
});

test('after a restart a task that was waiting still waits for the one that is resumed', async (t) => {
  const store = new MemoryTaskStore();
  const groups = new Map<string, string>();
  const before = await grouped(t, { store, groups });
  const c = before.conductor('invite-1');
  const first = await before.h.orchestrator.delegate(c, {
    runner: 'fake',
    brief: '1',
    title: 'First',
  });
  await eventually(
    () => before.h.orchestrator.status(c, first.taskId).state === 'running',
    'the first task running',
  );
  const second = await before.h.orchestrator.delegate(c, { runner: 'fake', brief: '2' });
  before.h.orchestrator.close();

  const after = await grouped(t, { store, groups, dir: before.h.dir, fake: { recover: true } });
  await after.h.orchestrator.settled();
  await eventually(() => after.h.fake.recoveries.length === 1, 'the first one resumed');
  assert.equal(after.h.fake.recoveries[0]?.taskId, first.taskId);
  assert.equal(started(after.h, second.taskId), false);
  assert.equal(after.h.orchestrator.stats().heldTasks, 1);

  await after.h.fake.runFor(first.taskId).complete();
  await eventually(() => started(after.h, second.taskId), 'the second run');
});

test('without admission nothing is held', async (t) => {
  const h = await makeHarness(t);
  const c = h.session();
  const one = await h.orchestrator.delegate(c, { runner: 'fake', brief: '1' });
  const two = await h.orchestrator.delegate(c, { runner: 'fake', brief: '2' });
  await eventually(() => started(h, one.taskId) && started(h, two.taskId), 'both runs');
});

test('the note names no title it does not have', () => {
  assert.equal(
    holdNote(1, undefined, 0),
    'One task runs at a time on this workspace for now. This one starts when the running task finishes.',
  );
  assert.equal(
    holdNote(1, 'A', 3),
    'One task runs at a time on this workspace for now. This one starts after "A" and the 3 tasks waiting before it.',
  );
  assert.equal(
    holdNote(3, 'A', 1),
    '3 tasks run at a time on this workspace for now. This one starts after the task waiting before it.',
  );
});

test('a room of zero is refused', async (t) => {
  await assert.rejects(
    makeHarness(t, { orchestrator: { admission: { groupOf: () => 'g', perGroup: 0 } } }),
    RangeError,
  );
});
