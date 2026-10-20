import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackupScheduler } from '../backup-schedule.js';

const DAY = 86_400_000;
const NOON = Date.UTC(2026, 9, 1, 12, 0, 0);

type Options = ConstructorParameters<typeof BackupScheduler>[0];

function scheduler(over: Partial<Omit<Options, 'latest'>> & { latest?: number | undefined }) {
  const warnings: string[] = [];
  let runs = 0;
  let clock = NOON;
  const { latest, ...options } = over;
  const made = new BackupScheduler({
    latest: async () => latest,
    run: async () => {
      runs += 1;
    },
    now: () => clock,
    onWarning: (message) => warnings.push(message),
    ...options,
  });
  return {
    made,
    warnings,
    runs: () => runs,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test('a backup is made when there is none, and not again the same UTC day', async () => {
  const none = scheduler({});
  await none.made.tick();
  assert.equal(none.runs(), 1);

  const today = scheduler({ latest: Date.UTC(2026, 9, 1, 0, 0, 1) });
  await today.made.tick();
  assert.equal(today.runs(), 0, 'one made just after midnight counts for the day');

  const yesterday = scheduler({ latest: Date.UTC(2026, 8, 30, 23, 59, 59) });
  await yesterday.made.tick();
  assert.equal(yesterday.runs(), 1, 'the next UTC day gets its own');
});

test('what is on disk decides, so a restart neither repeats the day’s backup nor skips it', async () => {
  let newest: number | undefined;
  let runs = 0;
  let clock = NOON;
  const make = () =>
    new BackupScheduler({
      latest: async () => newest,
      run: async () => {
        runs += 1;
        newest = clock;
      },
      now: () => clock,
    });
  await make().tick();
  await make().tick();
  assert.equal(runs, 1, 'a second process the same day finds the first one’s backup');
  clock += DAY;
  await make().tick();
  assert.equal(runs, 2);
});

test('a backup that fails is reported and not retried at once, then retried after the wait', async () => {
  let fail = true;
  const s = scheduler({
    retryAfterMs: 1000,
    run: async () => {
      if (fail) throw new Error('disk full');
    },
  });
  await s.made.tick();
  assert.deepEqual(s.warnings, ['The daily backup failed; trying again later']);
  await s.made.tick();
  assert.equal(s.warnings.length, 1, 'inside the wait nothing runs');
  fail = false;
  s.advance(1001);
  await s.made.tick();
  assert.equal(s.warnings.length, 1);
});

test('a tick while a backup runs joins it instead of starting another', async () => {
  let release = (): void => undefined;
  let started = (): void => undefined;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  let runs = 0;
  const s = scheduler({
    run: () => {
      runs += 1;
      started();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  const first = s.made.tick();
  await begun;
  const second = s.made.tick();
  release();
  await Promise.all([first, second]);
  assert.equal(runs, 1);
});

test('close ends the timers: no backup starts after it', async () => {
  const s = scheduler({ tickMs: 5, firstTickMs: 5 });
  s.made.start();
  await s.made.close();
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.equal(s.runs(), 0);
  await s.made.tick();
  assert.equal(s.runs(), 0, 'and a late tick does nothing');
});

test('the first look comes after the delay and then the timer keeps looking', async () => {
  let release = (): void => undefined;
  const second = new Promise<void>((resolve) => {
    release = resolve;
  });
  let looks = 0;
  const made = new BackupScheduler({
    latest: async () => {
      looks += 1;
      if (looks === 2) release();
      return Date.now();
    },
    run: async () => undefined,
    tickMs: 5,
    firstTickMs: 5,
  });
  made.start();
  // The scheduler's timers do not keep a process alive; the stack's sockets do. The test holds it.
  const hold = setInterval(() => undefined, 1000);
  try {
    await second;
  } finally {
    clearInterval(hold);
    await made.close();
  }
  assert.ok(looks >= 2);
});

test('close waits for a backup in flight, and gives up on one that hangs', async () => {
  let release = (): void => undefined;
  let started = (): void => undefined;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finished = false;
  const waiting = scheduler({
    run: () => {
      started();
      return new Promise<void>((resolve) => {
        release = () => {
          finished = true;
          resolve();
        };
      });
    },
  });
  void waiting.made.tick();
  await begun;
  let closed = false;
  const closing = waiting.made.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false, 'close is waiting for the backup');
  release();
  await closing;
  assert.equal(finished, true);
  assert.deepEqual(waiting.warnings, []);

  let hungStarted = (): void => undefined;
  const hungBegun = new Promise<void>((resolve) => {
    hungStarted = resolve;
  });
  const hung = scheduler({
    closeWaitMs: 20,
    run: () => {
      hungStarted();
      return new Promise<void>(() => undefined);
    },
  });
  void hung.made.tick();
  await hungBegun;
  await hung.made.close();
  assert.deepEqual(hung.warnings, ['A backup was still running when the stack closed']);
});

test('a failure to read the newest backup is reported like any other failure', async () => {
  const s = scheduler({
    latest: undefined,
  });
  const broken = new BackupScheduler({
    latest: () => Promise.reject(new Error('unreadable')),
    run: async () => {
      throw new Error('must not run');
    },
    onWarning: (message) => s.warnings.push(message),
  });
  await broken.tick();
  assert.deepEqual(s.warnings, ['The daily backup failed; trying again later']);
});
