import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Dispatcher, type RunLauncher } from '../dispatcher.js';
import { issueOpened, rig, spec } from './harness.js';

class Gate {
  open!: () => void;
  readonly promise = new Promise<void>((resolve) => {
    this.open = resolve;
  });
}

test('requests are launched oldest first, once each, and become started with their conversation', async () => {
  const r = await rig();
  const [duty] = (await r.activate(
    spec({ trigger: { kind: 'issue_opened' }, dailyCapUsd: 20 }),
  )) as [string];
  const launched: string[] = [];
  const launcher: RunLauncher = {
    start: async (request) => {
      launched.push(request.brief.split('\n').find((line) => line.startsWith('title:')) as string);
      return { conversationId: `cnv_${launched.length}` };
    },
  };
  const dispatcher = new Dispatcher({ engine: r.engine, launcher, now: r.clock.now });
  for (const n of [1, 2, 3]) {
    r.clock.advance(1);
    r.deliver('issues', issueOpened({ number: n, title: `issue ${n}` }));
  }
  await dispatcher.settled();
  assert.deepEqual(launched, ['title: "issue 1"', 'title: "issue 2"', 'title: "issue 3"']);
  assert.deepEqual(
    r.engine.requestsOf(duty).map((request) => request.state),
    ['started', 'started', 'started'],
  );
  assert.equal(r.engine.startedRequests().length, 3);
  await dispatcher.close();
  r.cleanup();
});

test('work that arrives while a launch is running is picked up by the same dispatcher, and nothing starts twice', async () => {
  const r = await rig();
  await r.activate(spec({ trigger: { kind: 'issue_opened' }, dailyCapUsd: 20 }));
  const gate = new Gate();
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const starts: string[] = [];
  const dispatcher = new Dispatcher({
    engine: r.engine,
    launcher: {
      start: async (request) => {
        starts.push(request.requestId);
        if (starts.length === 1) {
          entered();
          await gate.promise;
        }
        return { conversationId: `cnv_${starts.length}` };
      },
    },
    now: r.clock.now,
  });
  r.deliver('issues', issueOpened({ number: 1 }));
  await inside;
  // A second event and extra kicks arrive while the first launch is held.
  r.deliver('issues', issueOpened({ number: 2 }));
  dispatcher.kick();
  dispatcher.kick();
  gate.open();
  await dispatcher.settled();
  assert.equal(starts.length, 2);
  assert.equal(new Set(starts).size, 2);
  await dispatcher.close();
  r.cleanup();
});

test('closing releases the retry timer and later events start nothing', async () => {
  const r = await rig();
  await r.activate(spec({ trigger: { kind: 'issue_opened' } }));
  const timers = new Set<number>();
  let next = 0;
  const dispatcher = new Dispatcher({
    engine: r.engine,
    launcher: {
      start: async () => {
        throw new Error('later');
      },
    },
    now: r.clock.now,
    setTimer: () => {
      const id = ++next;
      timers.add(id);
      return () => timers.delete(id);
    },
  });
  r.deliver('issues', issueOpened({ number: 1 }));
  await dispatcher.settled();
  assert.equal(timers.size, 1, 'a retry is scheduled');
  assert.equal(dispatcher.stats().timers, 1);
  await dispatcher.close();
  assert.equal(timers.size, 0);
  assert.equal(dispatcher.stats().timers, 0);
  r.deliver('issues', issueOpened({ number: 2 }));
  await dispatcher.settled();
  assert.equal(r.engine.due().length, 1, 'the second event waits for the next start');
  r.cleanup();
});
