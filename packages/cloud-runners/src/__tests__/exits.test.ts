import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RunnerEvent } from '@maka-cloud/orchestrator';
import { MemorySessionStore } from '../session-store.js';
import {
  children,
  collect,
  exists,
  filesUnder,
  isRunning,
  reader,
  setup,
  settles,
  terminal,
  until,
  type Harness,
} from './harness.js';
import { Tracking } from './tracking.js';

const WORKING = (event: { type: string; note?: string }) =>
  event.type === 'progress' && event.note === 'working on it';

interface Row {
  name: string;
  /** What the run ends with: `finished`, `failed`, or nothing (a cancelled run). */
  ends: 'finished' | 'failed' | 'nothing';
  /** The fake CLI leaves a TERM-proof child behind. Default true. */
  orphan?: boolean;
  /** Expected number of runs of the CLI in the sandbox. */
  cliRuns?: number;
  options?(tr: Tracking, sessions: MemorySessionStore): Parameters<typeof setup>[0];
  /** Runs the task to its end and returns what the stream said. */
  exercise(h: Harness, tr: Tracking, name: string): Promise<RunnerEvent[]>;
}

const INSTALL_HANGS = `touch "$HOME/install-started"
while [ ! -e "$HOME/go" ]; do sleep 0.05; done
exit 1`;

const runToEnd = async (h: Harness, _tr: Tracking, name: string): Promise<RunnerEvent[]> => {
  const events = await settles(collect(await h.runners.claude.start(await h.spec(name))));
  assert.notEqual(events, 'stuck', 'the event stream never closed');
  return events as RunnerEvent[];
};

const ROWS: Row[] = [
  { name: 'finished', ends: 'finished', exercise: runToEnd },
  {
    name: 'the CLI fails',
    ends: 'failed',
    options: () => ({}),
    async exercise(h, tr, name) {
      await h.setMode('fail');
      return await runToEnd(h, tr, name);
    },
  },
  {
    name: 'EOF without a result',
    ends: 'failed',
    async exercise(h, tr, name) {
      await h.setMode('noresult');
      return await runToEnd(h, tr, name);
    },
  },
  {
    name: 'cancel',
    ends: 'nothing',
    async exercise(h, _tr, name) {
      await h.setMode('hang');
      const handle = await h.runners.claude.start(await h.spec(name));
      const events = reader(handle);
      await events.until(WORKING);
      assert.notEqual(await settles(handle.cancel()), 'stuck');
      const rest = await settles(events.rest());
      assert.notEqual(rest, 'stuck', 'the event stream never closed');
      return rest as RunnerEvent[];
    },
  },
  {
    name: 'cancel while the install hangs',
    ends: 'nothing',
    orphan: false,
    cliRuns: 0,
    options: (tr) => ({
      installClis: false,
      cloud: {
        modelAccess: tr.access,
        sandboxes: tr.sandboxes,
        installCommands: { 'claude-agent-sdk': INSTALL_HANGS },
      },
    }),
    async exercise(h, _tr, name) {
      const handle = await h.runners.claude.start(await h.spec(name));
      await until(() => exists(join(h.home, 'install-started')));
      assert.notEqual(await settles(handle.cancel()), 'stuck');
      const events = (await settles(collect(handle))) as RunnerEvent[];
      // The install is shared with other tasks, so it goes on after the cancel; let it end.
      await fs.writeFile(join(h.home, 'go'), '');
      await until(() => h.runners.fleet.poller.watchCount() === 0);
      return events;
    },
  },
  {
    name: 'cancel while a revoke never answers',
    ends: 'nothing',
    options: (tr) => {
      tr.revokeMode = 'hang';
      return {
        cloud: { modelAccess: tr.access, sandboxes: tr.sandboxes, cleanupTimeoutMs: 1_500 },
      };
    },
    async exercise(h, _tr, name) {
      await h.setMode('hang');
      const handle = await h.runners.claude.start(await h.spec(name));
      const events = reader(handle);
      await events.until(WORKING);
      // The revoke never answers: the cancel is not held up, and it does not say the run is stopped.
      const cancelled = await settles(
        handle.cancel().then(
          () => 'stopped',
          (error: unknown) => String(error),
        ),
      );
      assert.notEqual(cancelled, 'stuck');
      assert.match(cancelled, /revoke model access failed/);
      return (await settles(events.rest())) as RunnerEvent[];
    },
  },
  {
    name: 'the install throws',
    ends: 'failed',
    orphan: false,
    cliRuns: 0,
    options: () => ({
      installClis: false,
      cloud: { installCommands: { 'claude-agent-sdk': 'echo no network; exit 4' } },
    }),
    exercise: runToEnd,
  },
  {
    name: 'the snapshot throws',
    ends: 'finished',
    async exercise(h, tr, name) {
      h.fake.failNextSnapshot = true;
      return await runToEnd(h, tr, name);
    },
  },
  {
    name: 'the model access provider throws',
    ends: 'failed',
    orphan: false,
    cliRuns: 0,
    async exercise(h, tr, name) {
      tr.issueFails = new Error('gateway down');
      return await runToEnd(h, tr, name);
    },
  },
  {
    name: 'the sandbox provider throws',
    ends: 'failed',
    orphan: false,
    cliRuns: 0,
    async exercise(h, tr, name) {
      tr.acquireFails = new Error('no capacity');
      return await runToEnd(h, tr, name);
    },
  },
  {
    name: 'the revoke throws synchronously',
    ends: 'finished',
    options: (tr) => {
      tr.revokeMode = 'sync-throw';
      return { cloud: { modelAccess: tr.access, sandboxes: tr.sandboxes } };
    },
    exercise: runToEnd,
  },
  {
    name: 'the revoke rejects',
    ends: 'finished',
    options: (tr) => {
      tr.revokeMode = 'reject';
      return { cloud: { modelAccess: tr.access, sandboxes: tr.sandboxes } };
    },
    exercise: runToEnd,
  },
  {
    name: 'the sandbox release throws synchronously',
    ends: 'finished',
    options: (tr) => {
      tr.releaseMode = 'sync-throw';
      return { cloud: { modelAccess: tr.access, sandboxes: tr.sandboxes } };
    },
    exercise: runToEnd,
  },
  {
    name: 'writing the session record fails',
    ends: 'failed',
    orphan: false,
    cliRuns: 0,
    options: (tr, sessions) => {
      const put = sessions.put.bind(sessions);
      let first = true;
      sessions.put = async (record) => {
        if (first) {
          first = false;
          throw new Error('disk full');
        }
        return await put(record);
      };
      return { cloud: { modelAccess: tr.access, sandboxes: tr.sandboxes, sessions } };
    },
    exercise: runToEnd,
  },
];

for (const row of ROWS) {
  test(`every exit releases everything: ${row.name}`, async (t) => {
    const tr = new Tracking();
    const sessions = new MemorySessionStore();
    const base = row.options?.(tr, sessions) ?? {};
    const h = await setup({
      ...base,
      cloud: { modelAccess: tr.access, sandboxes: tr.sandboxes, sessions, ...base.cloud },
    });
    t.after(() => h.cleanup());
    if (row.orphan !== false) await fs.writeFile(join(h.home, 'fake-cli', 'orphan'), '');

    const events = await row.exercise(h, tr, `tsk_exit_${ROWS.indexOf(row)}`);

    const end = terminal(events);
    assert.equal(end?.type ?? 'nothing', row.ends, JSON.stringify(events));

    // The process group and everything under it is gone.
    assert.deepEqual(
      await h.runners.fleet.machine(h.fake.machineId).liveTaskDirs(),
      [],
      'a process of the task is still alive',
    );
    const left = await children(h);
    if (row.orphan !== false) assert.ok(left.length >= 1, 'the CLI left a child behind');
    for (const pid of left) assert.equal(await isRunning(pid), false, `child ${pid} survived`);
    assert.equal(await h.cliCalls('claude'), row.cliRuns ?? (await h.cliCalls('claude')));
    assert.deepEqual(await filesUnder(h.logRoot), [], 'raw output left behind');

    // Every handle is back.
    const { fleet } = h.runners;
    assert.equal(fleet.openRuns, 0, 'openRuns');
    assert.equal(fleet.poller.watchCount(), 0, 'poll watches');
    assert.equal(fleet.leaseRenewals, 0, 'lease renewal timers');
    assert.equal(h.fake.leases.size, 0, 'activity lease');
    assert.equal(tr.released, tr.acquired, 'sandbox lease');
    assert.equal(tr.revoked, tr.issued, 'model access');
  });
}
