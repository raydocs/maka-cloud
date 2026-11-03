import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { BoxDaemon, formatMiB, readVmRss } from '../box-daemon.js';
import { BoxPool } from '../box-pool.js';
import { MemorySuperagentStore } from '../memory-store.js';
import { FakeSandbox } from '../sandbox.js';
import { TENANT } from './harness.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function idleNodeRss(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
    stdio: 'ignore',
  });
  if (child.pid === undefined) throw new Error('idle node has no pid');
  await sleep(80);
  const rss = readVmRss(child.pid);
  child.kill();
  if (rss === undefined) throw new Error('could not read idle node RSS');
  return rss;
}

test('one daemon hosts many workers; cwd, env, and cancel stay isolated', async () => {
  const sandbox = new FakeSandbox();
  const store = new MemorySuperagentStore();
  const pool = new BoxPool({ sandbox, store });
  await pool.acquire({ tenantId: TENANT, workerId: 'wrk_a' });
  await pool.acquire({ tenantId: TENANT, workerId: 'wrk_b' });
  const daemon = pool.daemon(TENANT);
  assert.equal(daemon.size, 2);
  const a = daemon.session('wrk_a');
  const b = daemon.session('wrk_b');
  assert.equal(a?.workDir, 'work/wrk_a');
  assert.equal(b?.workDir, 'work/wrk_b');
  assert.equal(a?.env.HOME, 'work/wrk_a');
  assert.equal(b?.env.HOME, 'work/wrk_b');
  assert.notEqual(a?.abort, b?.abort);

  await daemon.exec('wrk_a', { cmd: 'echo secret-a > note.txt' });
  await daemon.exec('wrk_b', { cmd: 'echo secret-b > note.txt' });
  const readA = await daemon.exec('wrk_a', { cmd: 'cat note.txt' });
  const readB = await daemon.exec('wrk_b', { cmd: 'cat note.txt' });
  assert.match(readA.stdout, /secret-a/);
  assert.match(readB.stdout, /secret-b/);

  daemon.cancel('wrk_a');
  const cancelled = await daemon.exec('wrk_a', { cmd: 'echo still' });
  assert.equal(cancelled.exitCode, 1);
  assert.match(cancelled.stderr, /cancelled/);
  const stillB = await daemon.exec('wrk_b', { cmd: 'echo ok' });
  assert.equal(stillB.exitCode, 0);

  await pool.release(TENANT, 'wrk_a');
  await pool.release(TENANT, 'wrk_b');
  assert.equal(daemon.size, 0);
});

test('daemon per-session RSS is far below a per-process maka/node baseline', async () => {
  const samples: number[] = [];
  for (let i = 0; i < 3; i += 1) samples.push(await idleNodeRss());
  samples.sort((left, right) => left - right);
  const processRss = samples[1] ?? samples[0] ?? 0;
  assert.ok(processRss > 0, 'idle node RSS');

  const before = readVmRss(process.pid) ?? process.memoryUsage().rss;
  const daemon = new BoxDaemon({ tenantId: TENANT });
  const hold: unknown[] = [];
  for (let i = 0; i < 8; i += 1) {
    const session = daemon.attach(`wrk_${i}`, { env: { SLOT: String(i) } });
    hold.push(session, session.env, session.abort);
  }
  const after = readVmRss(process.pid) ?? process.memoryUsage().rss;
  const perSession = Math.max(0, after - before) / 8;

  assert.equal(daemon.size, 8);
  assert.ok(
    perSession < processRss / 4,
    `per-session ${formatMiB(perSession)} should be well under one process ${formatMiB(processRss)}; 8 sessions added ${formatMiB(Math.max(0, after - before))}. Owner-measured maka idle is 232–278 MiB/process.`,
  );
  void hold;
});
