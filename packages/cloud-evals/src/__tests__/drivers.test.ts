import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryCodingDeliveries } from '@maka-cloud/playbooks/coding';
import { PlaybookDriver, VendorAloneDriver } from '../drivers.js';
import { DriverError } from '../types.js';
import { BASE_SHA, FakeRunner, FakeSandbox, deferred, finishWith } from './fakes.js';
import { driverInput } from './fixtures.js';

function alone(log: string[], sandbox: FakeSandbox, runner: FakeRunner) {
  return new VendorAloneDriver({ runner, sandbox });
}

test('a vendor alone: clone, run, stop, then read the change, then give the sandbox back', async (t) => {
  const log: string[] = [];
  const sandbox = new FakeSandbox({ log, patch: 'diff --git a/a b/a\n+x\n' });
  const runner = new FakeRunner('claude-agent-sdk', log);
  runner.onStart = finishWith(0.42);
  const result = await alone(log, sandbox, runner).run(await driverInput(t));

  assert.deepEqual(log, [
    'open',
    'clone',
    'start',
    'stopAll:start',
    'stopAll:done',
    'collect',
    'release',
  ]);
  assert.equal(result.end, 'finished');
  assert.equal(result.costUsd, 0.42);
  assert.equal(result.outcome?.patch, 'diff --git a/a b/a\n+x\n');
  assert.deepEqual(result.outcome?.files, ['src/x.py']);
  assert.equal(
    result.outcome?.sha256,
    createHash('sha256').update('diff --git a/a b/a\n+x\n').digest('hex'),
  );
  assert.equal(runner.runs[0]?.cancels, 1, 'the run handle was cancelled');
  assert.equal(runner.runs[0]?.spec.budgetUsd, 2, 'the run got the cell cap');
});

test('nothing is collected until the stop has finished', async (t) => {
  const log: string[] = [];
  const gate = deferred();
  const sandbox = new FakeSandbox({ log, stopGate: gate });
  const runner = new FakeRunner('codex', log);
  runner.onStart = finishWith(1);
  const running = alone(log, sandbox, runner).run(await driverInput(t));
  await until(() => log.includes('stopAll:start'));
  assert.ok(!log.includes('collect'), 'collected while the run could still be alive');
  gate.resolve();
  await running;
  assert.ok(log.indexOf('stopAll:done') < log.indexOf('collect'));
});

test('a stop that cannot be confirmed is an infrastructure failure that keeps the cost, with no collection', async (t) => {
  const log: string[] = [];
  const sandbox = new FakeSandbox({ log, stopFails: true });
  const runner = new FakeRunner('codex', log);
  runner.onStart = finishWith(0.7);
  await assert.rejects(alone(log, sandbox, runner).run(await driverInput(t)), (error) => {
    assert.ok(error instanceof DriverError);
    assert.equal(error.costUsd, 0.7);
    assert.match(error.message, /could not confirm the run stopped/u);
    return true;
  });
  assert.ok(!log.includes('collect'));
  assert.equal(sandbox.released, 1, 'the lease is still given back');
});

test('a failed run reports its cost and leaves no outcome; the workspace is not read', async (t) => {
  const log: string[] = [];
  const sandbox = new FakeSandbox({ log });
  const runner = new FakeRunner('codex', log);
  runner.onStart = (run) => {
    run.push({ type: 'usage', costUsd: 1.5 });
    run.push({ type: 'failed', reason: 'budget of $2.00 reached' });
  };
  const result = await alone(log, sandbox, runner).run(await driverInput(t));
  assert.equal(result.end, 'failed');
  assert.equal(result.costUsd, 1.5);
  assert.equal(result.outcome, null);
  assert.equal(result.failureReason, 'budget of $2.00 reached');
  assert.ok(!log.includes('collect'));
  assert.equal(sandbox.released, 1);
});

test('an abort stops the run, stops the sandbox work and gives the lease back', async (t) => {
  const log: string[] = [];
  const sandbox = new FakeSandbox({ log });
  const runner = new FakeRunner('codex', log);
  const controller = new AbortController();
  const running = alone(log, sandbox, runner).run(
    await driverInput(t, { signal: controller.signal }),
  );
  const run = await runner.started.promise;
  run.push({ type: 'usage', costUsd: 0.3 });
  controller.abort();
  const result = await running;
  assert.equal(result.end, 'cancelled');
  assert.equal(result.costUsd, 0.3);
  assert.equal(run.cancels, 1);
  assert.equal(sandbox.stopAlls, 1);
  assert.equal(sandbox.released, 1);
  assert.ok(!log.includes('collect'));
});

test('a run past its time limit is cancelled and ends as a timeout', async (t) => {
  const log: string[] = [];
  const sandbox = new FakeSandbox({ log });
  const runner = new FakeRunner('codex', log);
  const result = await alone(log, sandbox, runner).run(await driverInput(t, { timeoutMs: 5 }));
  assert.equal(result.end, 'timeout');
  assert.equal(result.costUsd, null);
  assert.equal(runner.runs[0]?.cancels, 1);
  assert.equal(sandbox.stopAlls, 1);
  assert.equal(sandbox.released, 1);
});

test('a runner that throws on start still stops the sandbox work and gives the lease back', async (t) => {
  const log: string[] = [];
  const sandbox = new FakeSandbox({ log });
  const runner = new FakeRunner('codex', log);
  runner.startFails = new Error('no model key');
  await assert.rejects(alone(log, sandbox, runner).run(await driverInput(t)), /no model key/u);
  assert.equal(sandbox.stopAlls, 1);
  assert.equal(sandbox.released, 1);
});

test('a sandbox that cannot be opened fails the attempt as infrastructure', async (t) => {
  const log: string[] = [];
  const sandbox = new FakeSandbox({ log });
  sandbox.openFails = new Error('no machine');
  const runner = new FakeRunner('codex', log);
  await assert.rejects(alone(log, sandbox, runner).run(await driverInput(t)), /no machine/u);
  assert.equal(runner.runs.length, 0);
});

test('a clone that fails is an infrastructure failure and nothing is started', async (t) => {
  const log: string[] = [];
  const sandbox = new FakeSandbox({
    log,
    cloneStdout: 'CLONE_FAILED\nfatal: repository not found\n',
  });
  const runner = new FakeRunner('codex', log);
  await assert.rejects(
    alone(log, sandbox, runner).run(await driverInput(t)),
    /repository not found/u,
  );
  assert.equal(runner.runs.length, 0);
  assert.equal(sandbox.released, 1);
});

test('a change the collector refuses leaves no outcome and says why', async (t) => {
  const log: string[] = [];
  const sandbox = new FakeSandbox({ log, files: [{ path: 'link', mode: '120000' }] });
  const runner = new FakeRunner('codex', log);
  runner.onStart = finishWith(0.5);
  const result = await alone(log, sandbox, runner).run(await driverInput(t));
  assert.equal(result.end, 'finished');
  assert.equal(result.outcome, null);
  assert.match(result.failureReason ?? '', /symlink/u);
});

test('the brief of a vendor alone carries the issue and the rules, and never a test', async (t) => {
  const log: string[] = [];
  const sandbox = new FakeSandbox({ log });
  const runner = new FakeRunner('codex', log);
  runner.onStart = finishWith(0.1);
  const input = await driverInput(t);
  await alone(log, sandbox, runner).run(input);
  const brief = await readFile(runner.runs[0]?.spec.briefPath as string, 'utf8');
  assert.match(brief, /pallets\/flask/u);
  assert.match(brief, new RegExp(BASE_SHA));
  assert.match(brief, /Calling the thing twice raises\./u);
  assert.match(brief, /Never look for, fetch or use hidden or held-out tests/u);
});

// -- the playbook as a subject ---------------------------------------------------------------------

async function deliver(
  deliveries: MemoryCodingDeliveries,
  input: { taskId: string; hostDir: string },
  patch: string,
  files = ['src/x.py'],
  recordedSha?: string,
): Promise<void> {
  await mkdir(input.hostDir, { recursive: true });
  const changes = JSON.stringify({
    repo: 'pallets/flask',
    baseSha: BASE_SHA,
    files: files.map((path) => ({ path })),
  });
  await writeFile(join(input.hostDir, 'changes.json'), changes);
  await writeFile(join(input.hostDir, 'change.patch'), patch);
  await deliveries.record({
    taskId: input.taskId,
    repo: 'pallets/flask',
    baseRef: BASE_SHA,
    baseSha: BASE_SHA,
    changesPath: join(input.hostDir, 'changes.json'),
    changesSha256: recordedSha ?? createHash('sha256').update(changes).digest('hex'),
    verificationPath: join(input.hostDir, 'verification.json'),
  });
}

function playbook(log: string[], runner: FakeRunner, deliveries: MemoryCodingDeliveries) {
  const sandbox = new FakeSandbox({ log });
  return { sandbox, driver: new PlaybookDriver({ runner, deliveries, sandbox }) };
}

test('the playbook subject: its verified delivery is the outcome, after its leftovers are stopped', async (t) => {
  const log: string[] = [];
  const runner = new FakeRunner('coding', log);
  const deliveries = new MemoryCodingDeliveries();
  const { sandbox, driver } = playbook(log, runner, deliveries);
  const input = await driverInput(t);
  runner.onStart = async (run) => {
    await deliver(deliveries, input, 'diff --git a/s b/s\n+1\n');
    finishWith(1.25)(run);
  };
  const result = await driver.run(input);
  assert.equal(result.end, 'finished');
  assert.equal(result.costUsd, 1.25);
  assert.equal(result.outcome?.patch, 'diff --git a/s b/s\n+1\n');
  assert.deepEqual(result.outcome?.files, ['src/x.py']);
  assert.equal(sandbox.stopTasks, 1);
  const brief = await readFile(runner.runs[0]?.spec.briefPath as string, 'utf8');
  assert.match(brief, /```coding-task/u);
  assert.match(brief, /"repo":"pallets\/flask"/u);
  assert.match(brief, /Calling the thing twice raises\./u, 'the full issue is in the brief');
  assert.match(brief, /import flask/u, 'the visible test command is the repository smoke test');
  assert.equal(result.proof, null, 'no verification record is no proof, not a failure');
});

test('the playbook subject: its verification record is read as the proof', async (t) => {
  const log: string[] = [];
  const runner = new FakeRunner('coding', log);
  const deliveries = new MemoryCodingDeliveries();
  const { driver } = playbook(log, runner, deliveries);
  const input = await driverInput(t);
  runner.onStart = async (run) => {
    await deliver(deliveries, input, 'diff --git a/s b/s\n+1\n');
    await writeFile(
      join(input.hostDir, 'verification.json'),
      JSON.stringify({
        baseSha: BASE_SHA,
        repro: { command: 'pytest t.py', files: ['t.py'] },
        attempts: [{ vendor: 'claude' }, { vendor: 'claude' }],
        review: { status: 'reviewed', reviewer: 'codex', counts: { P1: 0, P2: 2, P3: 1 } },
      }),
    );
    finishWith(1)(run);
  };
  const result = await driver.run(input);
  assert.deepEqual(result.proof, {
    reproduced: true,
    reviewed: true,
    crossVendor: true,
    open: { P1: 0, P2: 2, P3: 1 },
    attempts: 2,
    kept: false,
  });
});

test('the playbook subject: giving up delivers nothing', async (t) => {
  const log: string[] = [];
  const runner = new FakeRunner('coding', log);
  runner.onStart = finishWith(3.1);
  const { driver } = playbook(log, runner, new MemoryCodingDeliveries());
  const result = await driver.run(await driverInput(t));
  assert.equal(result.outcome, null);
  assert.equal(result.costUsd, 3.1);
  assert.match(result.failureReason ?? '', /without a verified change/u);
});

test('the playbook subject: a cut patch is not graded', async (t) => {
  const log: string[] = [];
  const runner = new FakeRunner('coding', log);
  const deliveries = new MemoryCodingDeliveries();
  const { driver } = playbook(log, runner, deliveries);
  const input = await driverInput(t);
  runner.onStart = async (run) => {
    await deliver(deliveries, input, 'diff\n[change.patch cut at 10 of 99 bytes]\n');
    finishWith(1)(run);
  };
  const result = await driver.run(input);
  assert.equal(result.outcome, null);
  assert.match(result.failureReason ?? '', /cut for size/u);
});

test('the playbook subject: a delivery that no longer matches its record is an infrastructure failure', async (t) => {
  const log: string[] = [];
  const runner = new FakeRunner('coding', log);
  const deliveries = new MemoryCodingDeliveries();
  const { driver } = playbook(log, runner, deliveries);
  const input = await driverInput(t);
  runner.onStart = async (run) => {
    await deliver(deliveries, input, 'diff\n', ['a'], 'f'.repeat(64));
    finishWith(2)(run);
  };
  await assert.rejects(driver.run(input), (error) => {
    assert.ok(error instanceof DriverError);
    assert.equal(error.costUsd, 2);
    return true;
  });
});

test('the playbook subject: abort and timeout stop the run and its sandbox leftovers', async (t) => {
  for (const mode of ['abort', 'timeout'] as const) {
    const log: string[] = [];
    const runner = new FakeRunner('coding', log);
    const { sandbox, driver } = playbook(log, runner, new MemoryCodingDeliveries());
    const controller = new AbortController();
    const running = driver.run(
      await driverInput(t, {
        signal: controller.signal,
        timeoutMs: mode === 'timeout' ? 5 : 30_000,
      }),
    );
    if (mode === 'abort') {
      await runner.started.promise;
      controller.abort();
    }
    const result = await running;
    assert.equal(result.end, mode === 'abort' ? 'cancelled' : 'timeout');
    assert.equal(runner.runs[0]?.cancels, 1);
    assert.equal(sandbox.stopTasks, 1);
  }
});

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !condition(); i += 1) await new Promise((r) => setImmediate(r));
  assert.ok(condition(), 'condition never became true');
}
