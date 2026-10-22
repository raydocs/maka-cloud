import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLONE_SCRIPT } from '../scripts.js';
import {
  type AgentScript,
  type AgentTurn,
  collect,
  FIXED_ADD,
  fixes,
  gate,
  type Harness,
  isAlive,
  isCheck,
  readJson,
  recordedPids,
  reviewsNothing,
  recordPid,
  setup,
  terminal,
  writeRepro,
  zeroStats,
} from './harness.js';

/**
 * A reproduction test that records its pid under `hang` and runs until killed; with `onlyOnBase`,
 * it passes when add() is fixed, so it hangs only in the base check.
 */
async function hangingRepro(turn: AgentTurn, onlyOnBase = false): Promise<void> {
  const body = [
    'source lib/add.sh',
    onlyOnBase ? '[ "$(add 2 3)" = 5 ] && exit 0' : '',
    recordPid('hang'),
    'while :; do sleep 0.05; done',
  ].join('\n');
  await writeRepro(turn, `${body}\n`);
  await fs.writeFile(join(turn.workspace, 'lib', 'add.sh'), FIXED_ADD);
}

/** The pid of the hanging reproduction test, once it runs. */
async function hangingPid(h: Harness, until?: Promise<unknown>): Promise<number> {
  const [pid] = await recordedPids(h, 'hang', 1, until);
  return pid as number;
}

test('cancel while the repository is being fetched: nothing starts and the sandbox is released', async (t) => {
  const h = await setup(t);
  const held = gate();
  const reached = gate();
  h.hook = async (call, phase) => {
    if (phase === 'before' && call.script === CLONE_SCRIPT) {
      reached.open();
      await held.promise;
    }
  };
  const handle = await h.runner.start(await h.spec('tsk_cclone'));
  const events = collect(handle);
  await reached.promise;
  await handle.cancel();
  assert.equal(terminal(await events), undefined, 'a cancelled task reports no end of its own');
  held.open();
  assert.deepEqual(h.leases, { acquired: 1, released: 1 });
  assert.equal(h.claude.turns.length, 0);
  zeroStats(h.runner);
});

test('cancel while the agent runs: its run is cancelled and everything is released', async (t) => {
  const h = await setup(t);
  const running = gate();
  let aborted = false;
  h.claude.script = async (turn) => {
    running.open();
    await new Promise<void>((resolve) => turn.signal.addEventListener('abort', () => resolve()));
    aborted = true;
    return 'ok';
  };
  const handle = await h.runner.start(await h.spec('tsk_cagent'));
  const events = collect(handle);
  await running.promise;
  await handle.cancel();
  assert.equal(terminal(await events), undefined);
  assert.equal(aborted, true);
  assert.equal(h.claude.open, 0);
  assert.deepEqual(h.leases, { acquired: 1, released: 1 });
  zeroStats(h.runner);
});

test('an agent run that starts after the cancel is stopped when it arrives', {
  timeout: 20_000,
}, async (t) => {
  const h = await setup(t);
  const starting = gate();
  const proceed = gate();
  const start = h.claude.start.bind(h.claude);
  h.claude.start = async (spec) => {
    starting.open();
    await proceed.promise;
    return start(spec);
  };
  let aborted = false;
  h.claude.script = async (turn) => {
    await new Promise<void>((resolve) => turn.signal.addEventListener('abort', () => resolve()));
    aborted = true;
    return 'ok';
  };
  const handle = await h.runner.start(await h.spec('tsk_clate'));
  const events = collect(handle);
  await starting.promise;
  await handle.cancel();
  assert.equal(terminal(await events), undefined);
  proceed.open();
  // The late handle is released on arrival; wait for that release to finish.
  while (h.runner.stats.agentRuns > 0 || h.claude.open > 0 || h.claude.turns.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(aborted, true);
  zeroStats(h.runner);
});

test('cancel during a check stops the check process', async (t) => {
  const h = await setup(t);
  h.claude.script = async (turn) => {
    await hangingRepro(turn);
    return 'ok';
  };
  const handle = await h.runner.start(await h.spec('tsk_ccheck'));
  const events = collect(handle);
  const pid = await hangingPid(h, events);
  assert.equal(isAlive(pid), true);
  await handle.cancel();
  assert.equal(terminal(await events), undefined);
  assert.equal(isAlive(pid), false, 'the check was stopped');
  assert.deepEqual(h.leases, { acquired: 1, released: 1 });
  zeroStats(h.runner);
});

test('cancel during the base check stops it and puts the change back', async (t) => {
  const h = await setup(t);
  h.claude.script = async (turn) => {
    await hangingRepro(turn, true);
    return 'ok';
  };
  const cleanupErrors: string[] = [];
  h.runner = h.makeRunner({
    onCleanupError: (f) => cleanupErrors.push(`${f.step}: ${String(f.error)}`),
  });
  const handle = await h.runner.start(await h.spec('tsk_cbase'));
  const events = collect(handle);
  const pid = await hangingPid(h, events);
  const workspace = join(h.root, 'tsk_cbase', 'workspace');
  assert.notEqual(
    await fs.readFile(join(workspace, 'lib', 'add.sh'), 'utf8'),
    FIXED_ADD,
    'reverted for the check',
  );
  await handle.cancel();
  assert.equal(terminal(await events), undefined);
  assert.equal(isAlive(pid), false);
  assert.equal(
    await fs.readFile(join(workspace, 'lib', 'add.sh'), 'utf8'),
    FIXED_ADD,
    'the change is back',
  );
  assert.deepEqual(
    await fs.readdir(join(h.root, 'tsk_cbase', 'base-check')),
    [],
    'the backup is emptied',
  );
  assert.deepEqual(cleanupErrors, []);
  zeroStats(h.runner);
});

test('a sandbox error during a check fails the task and still stops the check', async (t) => {
  const h = await setup(t);
  h.claude.script = async (turn) => {
    await hangingRepro(turn);
    return 'ok';
  };
  // The check's exec loses its connection while the check runs in the sandbox.
  let running: Promise<unknown> | undefined;
  h.replace = (call, run) => {
    if (!isCheck(call)) return undefined;
    running = run().catch(() => undefined);
    return hangingPid(h, running).then(() => {
      throw new Error('socket hang up');
    });
  };
  const last = terminal(await collect(await h.runner.start(await h.spec('tsk_cthrow'))));
  assert.deepEqual(last, { type: 'failed', reason: 'socket hang up' });
  assert.equal(isAlive(await hangingPid(h)), false, 'the check was stopped');
  await running;
  zeroStats(h.runner);
});

test('an agent runner that throws on start fails the task and releases the sandbox', async (t) => {
  const h = await setup(t);
  h.claude.start = async () => {
    throw new Error('no capacity');
  };
  const last = terminal(await collect(await h.runner.start(await h.spec('tsk_athrow'))));
  assert.deepEqual(last, { type: 'failed', reason: 'no capacity' });
  assert.deepEqual(h.leases, { acquired: 1, released: 1 });
  zeroStats(h.runner);
});

test('the end of the task is reported only after everything it held is released', async (t) => {
  const h = await setup(t);
  h.claude.script = fixes;
  const handle = await h.runner.start(await h.spec('tsk_order'));
  for await (const event of handle.events) {
    if (event.type === 'finished' || event.type === 'failed') {
      assert.equal(event.type, 'finished');
      assert.deepEqual(h.leases, { acquired: 1, released: 1 });
      zeroStats(h.runner);
    }
  }
});

test('after a restart, stopOrphaned stops a check the old process left running', async (t) => {
  const h = await setup(t);
  h.claude.script = async (turn) => {
    await hangingRepro(turn);
    return 'ok';
  };
  const old = await h.runner.start(await h.spec('tsk_orphan'));
  const events = collect(old);
  const pid = await hangingPid(h, events);

  // A new process knows the task only by id.
  await h.makeRunner().stopOrphaned('tsk_orphan');
  assert.equal(isAlive(pid), false);

  await old.cancel();
  await events;
});

test('an edit loop stops the agent and hands the task to the other vendor', async (t) => {
  const h = await setup(t, { sampleIntervalMs: 5 });
  let stopped = false;
  h.claude.script = async (turn) => {
    // Its second run is the review of the other vendor's change.
    if (turn.n > 1) return reviewsNothing(turn);
    const file = join(turn.workspace, 'lib', 'add.sh');
    for (let i = 0; !turn.signal.aborted; i++) {
      await fs.writeFile(file, i % 2 === 0 ? 'add() { :; }\n' : 'add() { true; }\n');
      // Let two samples see this version before the next edit.
      for (let seen = 0; seen < 2 && !turn.signal.aborted; seen++) {
        await Promise.race([
          h.nextSample(),
          new Promise((resolve) => turn.signal.addEventListener('abort', resolve, { once: true })),
        ]);
      }
    }
    stopped = true;
    return 'ok';
  };
  h.codex.script = fixes;
  const spec = await h.spec('tsk_loop');
  assert.deepEqual(terminal(await collect(await h.runner.start(spec))), { type: 'finished' });
  assert.equal(stopped, true);
  assert.deepEqual(
    h.claude.turns.map((turn) => turn.kind),
    ['start', 'start'],
    'a loop is not repaired, it is handed over (the second run is the review)',
  );
  assert.equal(h.codex.turns.length, 1);
  const verification = await readJson(join(h.handoff, 'tsk_loop', 'verification.json'));
  assert.match(
    verification.attempts[0].end,
    /^edit loop: lib\/add.sh went back to an earlier version 3 times$/,
  );
  zeroStats(h.runner);
});

test('a cancel whose agent run could not be stopped is refused, not reported as done', async (t) => {
  const h = await setup(t);
  const running = gate();
  h.claude.script = async (turn) => {
    running.open();
    await new Promise<void>((resolve) => turn.signal.addEventListener('abort', () => resolve()));
    return 'ok';
  };
  const realStart = h.claude.start.bind(h.claude);
  h.claude.start = async (spec) => {
    const run = await realStart(spec);
    return {
      ...run,
      // The run stops, but the runner cannot confirm it.
      cancel: async () => {
        await run.cancel();
        throw new Error('sandbox unreachable');
      },
    };
  };
  const failures: string[] = [];
  h.runner = h.makeRunner({ onCleanupError: (failure) => failures.push(failure.step) });
  const handle = await h.runner.start(await h.spec('tsk_cnostop'));
  const events = collect(handle);
  await running.promise;
  await assert.rejects(handle.cancel(), /stop agent run failed: sandbox unreachable/);
  assert.equal(terminal(await events), undefined);
  assert.deepEqual(failures, ['stop agent run']);
  assert.deepEqual(h.leases, { acquired: 1, released: 1 }, 'the rest of the cleanup still ran');
  zeroStats(h.runner);
});

test('a cancel whose checks could not be stopped is refused, not reported as done', async (t) => {
  const h = await setup(t);
  h.claude.script = async (turn) => {
    await hangingRepro(turn);
    return 'ok';
  };
  const sandbox = h.runner.options.sandbox;
  h.runner = h.makeRunner({
    sandbox: {
      stopTask: (taskId, signal) => sandbox.stopTask(taskId, signal),
      open: async (taskId, signal) => {
        const workspace = await sandbox.open(taskId, signal);
        return {
          ...workspace,
          stopAll: async (stopSignal) => {
            await workspace.stopAll(stopSignal);
            throw new Error('sandbox unreachable');
          },
        };
      },
    },
  });
  const handle = await h.runner.start(await h.spec('tsk_cnocheck'));
  const events = collect(handle);
  await hangingPid(h, events);
  await assert.rejects(handle.cancel(), /stop checks failed: sandbox unreachable/);
  assert.equal(terminal(await events), undefined);
  zeroStats(h.runner);
});

/** A runner whose sandbox cannot confirm that the task's checks are stopped. */
function withFailingStopAll(h: Harness): void {
  const sandbox = h.runner.options.sandbox;
  h.runner = h.makeRunner({
    sandbox: {
      stopTask: (taskId, signal) => sandbox.stopTask(taskId, signal),
      open: async (taskId, signal) => {
        const workspace = await sandbox.open(taskId, signal);
        return {
          ...workspace,
          stopAll: async (stopSignal) => {
            await workspace.stopAll(stopSignal);
            throw new Error('sandbox unreachable');
          },
        };
      },
    },
  });
}

/** Whether the stream says why it sent no end. */
function saysNotStopped(events: Awaited<ReturnType<typeof collect>>): boolean {
  return events.some(
    (event) => event.type === 'progress' && /could not be confirmed stopped/.test(event.note),
  );
}

for (const exit of ['finished', 'failed'] as const) {
  const script: AgentScript =
    exit === 'finished' ? fixes : async () => ({ failed: 'the CLI crashed' });

  test(`a task that ${exit} on its own but whose checks could not be stopped publishes no end`, async (t) => {
    const h = await setup(t);
    h.claude.script = script;
    withFailingStopAll(h);
    const events = await collect(await h.runner.start(await h.spec(`tsk_achecks_${exit}`)));
    assert.equal(
      terminal(events),
      undefined,
      'an end was published for a task not known to be stopped',
    );
    assert.ok(saysNotStopped(events));
    zeroStats(h.runner);
  });

  test(`a task that ${exit} on its own but whose agent run could not be stopped publishes no end`, async (t) => {
    const h = await setup(t);
    h.claude.script = script;
    const realStart = h.claude.start.bind(h.claude);
    h.claude.start = async (spec) => {
      const run = await realStart(spec);
      return {
        ...run,
        cancel: async () => {
          await run.cancel();
          throw new Error('sandbox unreachable');
        },
      };
    };
    const events = await collect(await h.runner.start(await h.spec(`tsk_aagent_${exit}`)));
    assert.equal(terminal(events), undefined);
    assert.ok(saysNotStopped(events));
    zeroStats(h.runner);
  });
}
