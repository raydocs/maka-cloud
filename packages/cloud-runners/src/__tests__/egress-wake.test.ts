import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './harness.js';

// The rules of a box that was restored or resumed: nothing, and the guard cannot put them back.
const REFUSED = new Error('egress guard: the rules cannot be built');

function asleepBox(h: { fake: { machineState: string; autoSuspendedAt?: string } }): void {
  h.fake.machineState = 'suspended';
  h.fake.autoSuspendedAt = new Date().toISOString();
}

test('a guard that fails after the box was woken is final: no retry reaches the box with task code', async (t) => {
  let calls = 0;
  const h = await setup({
    cloud: {
      egressGuard: async () => {
        calls += 1;
        if (calls === 1) {
          asleepBox(h);
          return;
        }
        throw REFUSED;
      },
    },
  });
  t.after(() => h.cleanup());
  const reached: string[] = [];
  h.fake.onExec = (request) => {
    if (
      typeof request.body?.stdin === 'string' &&
      request.body.stdin.includes('task-code-marker')
    ) {
      reached.push('launch');
    }
    return undefined;
  };
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await machine.prepare('tsk_wake_final');
  asleepBox(h);
  await assert.rejects(
    machine.launch({
      dirName: 'tsk_wake_final',
      run: 't1',
      preamble: '',
      program: 'echo',
      args: ['task-code-marker'],
      envs: {},
      runToken: 'token-wake-final',
      workdir: `${h.root}/tsk_wake_final`,
    }),
    /rules cannot be built/u,
  );
  assert.deepEqual(reached, [], 'task code reached a box whose guard had failed');
});

test('repo code run by a plain exec is guarded after a wake too, and a refused box stays refused', async (t) => {
  let refuse = false;
  const h = await setup({
    cloud: {
      egressGuard: async () => {
        if (refuse) throw REFUSED;
      },
    },
  });
  t.after(() => h.cleanup());
  const reached: string[] = [];
  h.fake.onExec = (request) => {
    if (typeof request.body?.cmd === 'string' && request.body.cmd.includes('repo-check-marker')) {
      reached.push('check');
    }
    return undefined;
  };
  const machine = h.runners.fleet.machine(h.fake.machineId);
  asleepBox(h);
  refuse = true;
  await assert.rejects(
    machine.exec('echo repo-check-marker', { taskCode: true }),
    /rules cannot be built/u,
  );
  // The box is awake now, and still has no rules: it is not trusted because it is running.
  await assert.rejects(
    machine.exec('echo repo-check-marker', { taskCode: true }),
    /rules cannot be built/u,
  );
  assert.deepEqual(reached, []);
  // Once the guard holds again, the same box runs checks.
  refuse = false;
  const ok = await machine.exec('echo repo-check-marker', { taskCode: true });
  assert.equal(ok.exitCode, 0);
  assert.deepEqual(reached, ['check']);
});

test('host scripts still wake a sleeping box without being held up by the guard', async (t) => {
  const h = await setup({
    cloud: {
      egressGuard: async () => {
        throw REFUSED;
      },
    },
  });
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  asleepBox(h);
  // Stopping a task must work on a box that cannot be closed.
  const out = await machine.exec('echo stopping');
  assert.equal(out.exitCode, 0);
});
