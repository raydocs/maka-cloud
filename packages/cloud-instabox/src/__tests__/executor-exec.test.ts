import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { INSTABOX_WORKSPACE_EXECUTOR_FACTS } from '../facts.js';
import { InstaboxTransportError } from '../errors.js';
import { isAlive } from './fake-instabox.js';
import { setup, type Harness } from './harness.js';

describe('InstaboxWorkspaceExecutor.exec', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const exec = (command: string, extra: Record<string, unknown> = {}) =>
    h.executor.exec({ command, cwd: h.work, timeoutMs: 30_000, ...extra });

  it('reports remote-sandbox facts', () => {
    assert.deepEqual(h.executor.facts, INSTABOX_WORKSPACE_EXECUTOR_FACTS);
    assert.equal(h.executor.facts.isolation, 'remote');
    assert.equal(h.executor.facts.writesAffectHost, false);
    assert.equal(h.executor.facts.writeBack, 'diff_review');
    assert.equal(h.executor.facts.network, 'sandbox');
    assert.equal(h.executor.facts.secrets, 'none');
  });

  it('runs in the requested cwd and returns collected output', async () => {
    const chunks: [string, string][] = [];
    const result = await exec('pwd; echo oops >&2', {
      emitOutput: (stream: string, chunk: string) => chunks.push([stream, chunk]),
    });
    assert.deepEqual(result, {
      stdout: `${h.work}\n`,
      stderr: 'oops\n',
      exitCode: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false,
    });
    assert.deepEqual(chunks, [
      ['stdout', `${h.work}\n`],
      ['stderr', 'oops\n'],
    ]);
    assert.equal(h.fake.execRequests[0]?.body.cwd, h.work);
  });

  it('returns a non-zero exit as a result, not an error', async () => {
    const result = await exec('exit 7');
    assert.equal(result.exitCode, 7);
    assert.equal(result.timedOut, false);
  });

  it('flags truncated output', async () => {
    const result = await exec('head -c 1100000 /dev/zero | tr "\\0" a');
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stdout.length, 1024 * 1024);
  });

  it('maps a timeout to exit code 124 and rounds the timeout up to whole seconds', async () => {
    const result = await h.executor.exec({ command: 'sleep 30', cwd: h.work, timeoutMs: 1_200 });
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 124);
    assert.equal(h.fake.execRequests[0]?.body.timeoutSeconds, 2);
  });

  it('clamps the timeout to the 600 second maximum', async () => {
    await exec('true', { timeoutMs: 900_000 });
    assert.equal(h.fake.execRequests[0]?.body.timeoutSeconds, 600);
  });

  it('forwards only valid, string environment variables', async () => {
    const result = await exec('echo "$FOO|$BAR"', {
      env: { FOO: 'one', BAR: undefined, 'bad-name': 'x' },
    });
    assert.equal(result.stdout, 'one|\n');
    const envs = h.fake.execRequests[0]?.body.envs;
    assert.equal(envs.FOO, 'one');
    assert.ok(!('BAR' in envs) && !('bad-name' in envs));
  });

  it('rejects host-sandbox argv and fd inputs', async () => {
    await assert.rejects(exec('true', { argv: ['true'] }), /argv/);
    await assert.rejects(exec('true', { fdInputs: [{}] }), /fd inputs/);
    assert.equal(h.fake.execRequests.length, 0);
  });

  it('requires an absolute sandbox cwd', async () => {
    await assert.rejects(
      h.executor.exec({ command: 'true', cwd: 'work', timeoutMs: 1000 }),
      /absolute/,
    );
  });

  it('resumes a paused sandbox and runs the command once', async () => {
    h.fake.machineState = 'suspended';
    const result = await exec('echo awake');
    assert.equal(result.stdout, 'awake\n');
    assert.equal(h.fake.requestsTo('POST', /\/resume$/).length, 1);
    // 409 first (not started), then the single real run.
    assert.equal(h.fake.execRequests.length, 2);
  });

  it('does not replay a command after the connection drops', async () => {
    h.fake.onExec = () => ({ drop: true });
    await assert.rejects(exec('touch ran'), InstaboxTransportError);
    assert.equal(h.fake.execRequests.length, 1);
  });

  it('kills the remote process group when aborted', async () => {
    const controller = new AbortController();
    const pending = exec('sleep 60 & echo $! > pid; wait', { abortSignal: controller.signal });
    // Wait until the command is running in the fake sandbox.
    for (let i = 0; i < 100 && !(await pidWritten(h.work)); i++) await delay(50);
    const sleepPid = await pidWritten(h.work);
    assert.ok(sleepPid && isAlive(sleepPid), 'sleep should be running before the abort');

    controller.abort();
    const result = await pending;
    assert.equal(result.aborted, true);
    assert.equal(result.exitCode, 130);

    for (let i = 0; i < 100 && isAlive(sleepPid as number); i++) await delay(50);
    assert.equal(isAlive(sleepPid as number), false, 'abort must stop the remote process');
    const kill = h.fake.execRequests.at(-1)?.body;
    assert.match(kill.cmd, /MAKA_EXEC_TOKEN/);
    assert.equal(kill.envs.MAKA_KILL_TOKEN, h.fake.execRequests[0]?.body.envs.MAKA_EXEC_TOKEN);
  });
});

async function pidWritten(dir: string): Promise<number | undefined> {
  const { readFile } = await import('node:fs/promises');
  try {
    const value = Number((await readFile(`${dir}/pid`, 'utf8')).trim());
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
