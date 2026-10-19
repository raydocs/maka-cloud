import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { DriverInput, PublicTask } from '../types.js';
import { BASE_SHA } from './fakes.js';

export const TASK: PublicTask = {
  id: 'pallets__flask-1',
  suite: 'swe-bench-verified',
  repo: 'pallets/flask',
  baseCommit: BASE_SHA,
  statement: 'Calling the thing twice raises.',
  testCommand: null,
};

export async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-evals-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export async function driverInput(
  t: TestContext,
  over: Partial<DriverInput> = {},
): Promise<DriverInput> {
  return {
    task: TASK,
    taskId: 'tsk_0123456789abcdef0123456789abcdef',
    hostDir: join(await tempDir(t), 'attempt'),
    budgetUsd: 2,
    timeoutMs: 30_000,
    signal: new AbortController().signal,
    ...over,
  };
}
