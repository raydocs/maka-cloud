import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CHECK_START_SCRIPT, CLONE_SCRIPT, CHECK_STATUS_SCRIPT } from '../scripts.js';
import {
  type AgentTurn,
  collect,
  FIXED_ADD,
  fixes,
  gate,
  type Harness,
  isAlive,
  readJson,
  setup,
  terminal,
  writeRepro,
  zeroStats,
} from './harness.js';

/** A reproduction test that records its pid and runs until killed; with `onlyOnBase`, it passes when add() is fixed. */
async function hangingRepro(turn: AgentTurn, onlyOnBase = false): Promise<void> {
  const body = [
    'echo $$ > "$MAKA_TEST_PIDS/$(basename "$PWD")-$RANDOM"',
    'source lib/add.sh',
    onlyOnBase ? '[ "$(add 2 3)" = 5 ] && exit 0' : '',
    'while :; do sleep 0.05; done',
  ].join('\n');
  await writeRepro(turn, `${body}\n`);
  await fs.writeFile(join(turn.workspace, 'lib', 'add.sh'), FIXED_ADD);
}

/** Holds the runner right after the named check started, and returns the pid it records. */
function holdAfterCheckStart(h: Harness, check: string) {
  const started = gate();
  const release = gate();
  h.hook = async (call, phase) => {
    if (
      phase === 'after' &&
      call.script === CHECK_START_SCRIPT &&
      call.envs.MAKA_CHECK?.endsWith(check)
    ) {
      started.open();
      await release.promise;
    }
  };
  return { started: started.promise, release: () => release.open() };
}

async function checkPid(h: Harness, taskId: string, check: string): Promise<number> {
  const dir = join(h.root, taskId);
  for (;;) {
    const name = (await fs.readdir(dir)).find((file) => file.endsWith(`${check}.pid`));
    const text = name ? (await fs.readFile(join(dir, name), 'utf8')).trim() : '';
    if (text) return Number(text);
    await new Promise((resolve) => setImmediate(resolve));
  }
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
  const hold = holdAfterCheckStart(h, 'repro');
  const handle = await h.runner.start(await h.spec('tsk_ccheck'));
  const events = collect(handle);
  await hold.started;
  const pid = await checkPid(h, 'tsk_ccheck', 'repro');
  assert.equal(isAlive(pid), true);
  const cancelled = handle.cancel();
  hold.release();
  await cancelled;
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
  const hold = holdAfterCheckStart(h, 'repro-base');
  const handle = await h.runner.start(await h.spec('tsk_cbase'));
  const events = collect(handle);
  await hold.started;
  const workspace = join(h.root, 'tsk_cbase', 'workspace');
  assert.notEqual(
    await fs.readFile(join(workspace, 'lib', 'add.sh'), 'utf8'),
    FIXED_ADD,
    'reverted for the check',
  );
  const pid = await checkPid(h, 'tsk_cbase', 'repro-base');
  const cancelled = handle.cancel();
  hold.release();
  await cancelled;
  assert.equal(terminal(await events), undefined);
  assert.equal(isAlive(pid), false);
  assert.equal(
    await fs.readFile(join(workspace, 'lib', 'add.sh'), 'utf8'),
    FIXED_ADD,
    'the change is back',
  );
  await assert.rejects(fs.stat(join(h.root, 'tsk_cbase', 'base-check')), { code: 'ENOENT' });
  assert.deepEqual(cleanupErrors, []);
  zeroStats(h.runner);
});

test('a sandbox error during a check fails the task and still stops the check', async (t) => {
  const h = await setup(t);
  h.claude.script = async (turn) => {
    await hangingRepro(turn);
    return 'ok';
  };
  const hold = holdAfterCheckStart(h, 'repro');
  const handle = await h.runner.start(await h.spec('tsk_cthrow'));
  const events = collect(handle);
  await hold.started;
  const pid = await checkPid(h, 'tsk_cthrow', 'repro');
  h.fake.onExec = (request) =>
    request.body?.cmd === CHECK_STATUS_SCRIPT
      ? { status: 400, error: { code: 'bad_request', message: 'broken', retryable: false } }
      : undefined;
  hold.release();
  const last = terminal(await events);
  assert.equal(last?.type, 'failed');
  h.fake.onExec = undefined;
  assert.equal(isAlive(pid), false, 'the check was stopped by the cleanup');
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
  const hold = holdAfterCheckStart(h, 'repro');
  const old = await h.runner.start(await h.spec('tsk_orphan'));
  const events = collect(old);
  await hold.started;
  const pid = await checkPid(h, 'tsk_orphan', 'repro');

  // A new process knows the task only by id.
  await h.makeRunner().stopOrphaned('tsk_orphan');
  assert.equal(isAlive(pid), false);

  const cancelled = old.cancel();
  hold.release();
  await cancelled;
  await events;
});

test('an edit loop stops the agent and hands the task to the other vendor', async (t) => {
  const h = await setup(t, { sampleIntervalMs: 5 });
  let stopped = false;
  h.claude.script = async (turn) => {
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
  assert.equal(h.claude.turns.length, 1, 'a loop is not repaired, it is handed over');
  assert.equal(h.codex.turns.length, 1);
  const verification = await readJson(join(h.handoff, 'tsk_loop', 'verification.json'));
  assert.match(
    verification.attempts[0].end,
    /^edit loop: lib\/add.sh went back to an earlier version 3 times$/,
  );
  zeroStats(h.runner);
});
