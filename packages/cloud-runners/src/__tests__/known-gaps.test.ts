import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import type { RunHandle, RunnerEvent, StepLog } from '@maka-cloud/orchestrator';
import { crashInsideNeverStep } from './drill.js';
import { collect, exists, isRunning, until } from './harness.js';
import { sdkSetup } from './sdk-harness.js';

/**
 * A known gap of the durable-task machinery, kept as a test that says what should hold. It fails
 * today, and that is what the entry expects: the test passes while the assertion fails. When the
 * owner closes the gap the assertion holds, the entry fails with "the gap is closed", and the
 * entry (and its row in `docs/fork/design/durable-tasks.md`, section 8) is removed with the fix.
 * Only a failed assertion counts: any other error is a broken test and fails it.
 */
function knownGap(
  owner: string,
  name: string,
  body: (t: { after(fn: () => Promise<void>): void }) => Promise<void>,
): void {
  test(`known gap (${owner}): ${name}`, async (t) => {
    let failure: unknown;
    try {
      await body(t);
    } catch (error) {
      failure = error;
    }
    if (failure === undefined) {
      assert.fail('the gap is closed: remove this entry and its row in durable-tasks.md');
    }
    assert.ok(
      failure instanceof assert.AssertionError,
      `the entry broke instead of showing the gap: ${String(failure)}`,
    );
  });
}

knownGap(
  'T27',
  'a child that left the run’s process group outlives the stop of its task, and its late write lands in the workspace',
  async (t) => {
    const { childPid, go, late } = await crashInsideNeverStep(t);
    // The second process stopped the old run by task id, and took the task over.
    await fs.writeFile(go, '');
    // Whatever the child does next must not land. Give it time to do it.
    await until(async () => !(await isRunning(childPid)) || (await exists(late)), 5_000).catch(
      () => undefined,
    );
    assert.equal(await isRunning(childPid), false, 'the child is still running');
    assert.equal(await exists(late), false, 'the child’s late write landed');
  },
);

knownGap(
  'T28 (agent side)',
  'a turn that makes no tool call never reads a message sent to it',
  async (t) => {
    const h = await sdkSetup(t);
    await h.setMode('ok');
    const steps: StepLog = {
      intent: async () => ({ status: 'recorded' }),
      outcome: async () => 'recorded',
    };
    const handle = (await h.runners.claude.start(
      await h.spec('tsk_gap_steer', { steps }),
    )) as RunHandle;
    handle.steer?.({ steerId: 'm1', text: 'Use the v2 API.' });
    const events: RunnerEvent[] = await collect(handle);
    const read = events.flatMap((event) => (event.type === 'steered' ? [event.steerId] : []));
    assert.deepEqual(read, ['m1'], 'the agent never read it');
  },
);

knownGap('T27', 'the Codex runner takes no messages for a running task', async (t) => {
  const h = await sdkSetup(t);
  assert.equal(h.runners.codex.steerable, true);
});

knownGap('T28 follow-up', 'a runner reports the tokens of a run, not only its dollars', async (t) => {
  const h = await sdkSetup(t);
  await h.setMode('spend');
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_gap_tokens')));
  const usage = events.filter((event) => event.type === 'usage');
  assert.ok(usage.length > 0, 'the run reported no usage at all');
  assert.ok(
    usage.every((event) => 'inputTokens' in event && 'outputTokens' in event),
    'a usage report carries dollars only',
  );
});
