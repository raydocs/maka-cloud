import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DutyEngine, type ScanResult } from '@maka-cloud/duties';
import { CardScheduler } from '../cards/schedule.js';

const OWNER = 'inv_000000000001';
const T0 = Date.UTC(2026, 9, 21, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OK: ScanResult = {
  ok: true,
  outcome: {
    created: [],
    kept: [],
    refreshed: [],
    retired: [],
    expired: [],
    skipped: [],
    ranked: 'fixed',
  },
} as unknown as ScanResult;

interface Deferred {
  release(result?: ScanResult): void;
  signal: AbortSignal | undefined;
}

function rig(options: { projects?: number; maxPerPass?: number } = {}) {
  const clock = { t: T0 };
  const engine = new DutyEngine({
    dbPath: ':memory:',
    webhookSecret: 'a-webhook-secret-of-sufficient-length',
    allowProject: () => true,
    now: () => clock.t,
  });
  const projectIds: string[] = [];
  for (let i = 0; i < (options.projects ?? 2); i += 1) {
    const added = engine.addProject(OWNER, {
      repo: `acme/repo${i}`,
      installationId: 7,
      defaultBranch: 'main',
      selfLogins: ['maka-bot'],
    });
    assert.ok(added.ok);
    projectIds.push(added.project.projectId);
  }
  const scanned: string[] = [];
  const holds = new Map<string, Deferred>();
  const results = new Map<string, ScanResult | Error>();
  let hold = false;
  const events: string[] = [];
  let released = 0;
  const warnings: string[] = [];
  const housekeeping = { fail: false };
  const scheduler = new CardScheduler({
    engine,
    cards: {
      scanProject: async (_owner, projectId, signal) => {
        scanned.push(projectId);
        const planned = results.get(projectId);
        if (planned instanceof Error) throw planned;
        if (hold) {
          await new Promise<void>((resolve) => {
            holds.set(projectId, { release: () => resolve(), signal });
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        return planned ?? OK;
      },
      maintain: () => {
        events.push('maintain');
        if (housekeeping.fail) throw new Error('housekeeping failed');
        return { resumed: 0, expired: 0 };
      },
    },
    settler: {
      settle: () => {
        events.push('settle');
        return 0;
      },
    },
    now: () => clock.t,
    every: () => () => {
      released += 1;
    },
    ...(options.maxPerPass === undefined ? {} : { maxPerPass: options.maxPerPass }),
    onWarning: (m) => warnings.push(m),
  });
  return {
    engine,
    scheduler,
    projectIds,
    scanned,
    holds,
    results,
    clock,
    events,
    warnings,
    housekeeping,
    holdScans: (on: boolean) => {
      hold = on;
    },
    released: () => released,
  };
}

test('every project is scanned once a day, and not again before a day has passed', async () => {
  const r = rig();
  await r.scheduler.pass();
  assert.deepEqual([...r.scanned].sort(), [...r.projectIds].sort());
  await r.scheduler.pass();
  assert.equal(r.scanned.length, 2, 'nothing is due');
  r.clock.t += DAY - 1;
  await r.scheduler.pass();
  assert.equal(r.scanned.length, 2);
  r.clock.t += 1;
  await r.scheduler.pass();
  assert.equal(r.scanned.length, 4);
  r.engine.close();
});

test('after days of downtime a project is scanned once, not once for each missed day', async () => {
  const r = rig({ projects: 1 });
  await r.scheduler.pass();
  r.clock.t += 5 * DAY;
  await r.scheduler.pass();
  await r.scheduler.pass();
  assert.equal(r.scanned.length, 2);
  r.engine.close();
});

test('a finished task asks for a scan soon, but not within the gap and not for another project', async () => {
  const r = rig();
  await r.scheduler.pass();
  r.scanned.length = 0;
  const [first] = r.projectIds;
  r.scheduler.taskFinished(first as string);
  r.clock.t += HOUR - 1;
  await r.scheduler.pass();
  assert.deepEqual(r.scanned, [], 'the last scan is too recent');
  r.clock.t += 1;
  await r.scheduler.pass();
  assert.deepEqual(r.scanned, [first], 'only the project whose task finished');
  await r.scheduler.pass();
  assert.deepEqual(r.scanned, [first], 'the request was spent');
  r.engine.close();
});

test('a pass asked for while one runs is that pass: no project is scanned twice at once', async () => {
  const r = rig({ projects: 1 });
  r.holdScans(true);
  const first = r.scheduler.pass();
  const second = r.scheduler.pass();
  assert.equal(first, second);
  // Wait for the scan to have begun, then let it finish.
  while (r.holds.size === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.scanned.length, 1);
  r.holds.get(r.projectIds[0] as string)?.release();
  await first;
  assert.equal(r.scanned.length, 1);
  assert.equal(r.engine.cards.lastScan(r.projectIds[0] as string), T0);
  r.engine.close();
});

test('stopping ends the scan in progress, starts no other and releases the timer', async () => {
  const r = rig();
  r.holdScans(true);
  r.scheduler.start();
  while (r.holds.size === 0) await new Promise((resolve) => setImmediate(resolve));
  const first = r.scanned[0];
  assert.equal(r.holds.get(first as string)?.signal?.aborted, false);
  await r.scheduler.stop();
  assert.equal(r.holds.get(first as string)?.signal?.aborted, true, 'the scan was told to stop');
  assert.equal(r.scanned.length, 1, 'the second project was not started');
  assert.equal(r.released(), 1);
  await r.scheduler.pass();
  r.scheduler.taskFinished(first as string);
  assert.equal(r.scanned.length, 1, 'nothing runs after stop');
  assert.throws(() => r.scheduler.start(), /already/);
  r.engine.close();
});

test('a scan that cannot read the project is not counted as done, and is tried again after a gap', async () => {
  const r = rig({ projects: 1 });
  const [id] = r.projectIds as [string];
  r.results.set(id, { ok: false, reason: 'read_failed' });
  await r.scheduler.pass();
  assert.equal(r.engine.cards.lastScan(id), undefined);
  assert.equal(r.warnings.length, 1);
  r.clock.t += HOUR - 1;
  await r.scheduler.pass();
  assert.equal(r.scanned.length, 1, 'not hammered while GitHub is down');
  r.clock.t += 1;
  r.results.set(id, new Error('boom'));
  await r.scheduler.pass();
  assert.equal(r.scanned.length, 2);
  assert.equal(r.warnings.length, 2, 'a throw is a warning too');
  r.clock.t += HOUR;
  r.results.delete(id);
  await r.scheduler.pass();
  assert.equal(r.engine.cards.lastScan(id), r.clock.t);
  r.engine.close();
});

test('at most a few scans start in one pass, and the rest follow on the next', async () => {
  const r = rig({ projects: 3, maxPerPass: 2 });
  await r.scheduler.pass();
  assert.equal(r.scanned.length, 2);
  await r.scheduler.pass();
  assert.deepEqual([...r.scanned].sort(), [...r.projectIds].sort());
  assert.equal(new Set(r.scanned).size, 3, 'none was scanned twice');
  r.engine.close();
});

test('housekeeping runs first on every pass, and one that fails does not stop the scans', async () => {
  const r = rig({ projects: 1 });
  r.housekeeping.fail = true;
  await r.scheduler.pass();
  assert.deepEqual(r.events, ['settle', 'maintain']);
  assert.equal(r.scanned.length, 1);
  assert.equal(r.warnings.length, 1);
  r.engine.close();
});

test('a project that was removed is not scanned', async () => {
  const r = rig({ projects: 2 });
  assert.ok(r.engine.removeProject(OWNER, r.projectIds[0] as string));
  await r.scheduler.pass();
  assert.deepEqual(r.scanned, [r.projectIds[1]]);
  r.engine.close();
});
