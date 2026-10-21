import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { CHECK_STOP_SCRIPT, checkAttemptMark, checkTagPrefix } from '../scripts.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A process that carries `tag` as an argument, as a check's processes do. */
function tagged(tag: string): number {
  const child = spawn('bash', ['-c', 'sleep 60; :', tag], { stdio: 'ignore', detached: true });
  child.unref();
  return child.pid as number;
}

function stop(prefix: string, upTo?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', CHECK_STOP_SCRIPT], {
      env: {
        ...process.env,
        MAKA_CHECK_TAG: prefix,
        ...(upTo === undefined ? {} : { MAKA_CHECK_UP_TO: String(upTo) }),
      },
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', () => resolve(out.trim()));
  });
}

test('the stop of checks for an earlier attempt leaves the checks of a later attempt running', async (t) => {
  const prefix = checkTagPrefix('tsk_checks');
  const second = tagged(`${prefix}${checkAttemptMark(2)}1-aaaa`);
  const third = tagged(`${prefix}${checkAttemptMark(3)}1-bbbb`);
  const older = tagged(`${prefix}1-cccc`);
  t.after(() => {
    for (const pid of [second, third, older]) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(await stop(prefix, 2), 'STOPPED');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(second), false, 'attempt 2 asked, its check is stopped');
  assert.equal(alive(older), false, 'a check from before attempts were named is older');
  assert.equal(alive(third), true, 'the check of attempt 3 is not attempt 2 to stop');

  assert.equal(await stop(prefix), 'STOPPED', 'a stop that names no attempt takes every check');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(third), false);
});
