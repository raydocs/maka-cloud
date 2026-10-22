import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRunning, reader, setup, terminal, until } from './harness.js';

const WORKING = (event: { type: string; note?: string }) =>
  event.type === 'progress' && /working on it/u.test(event.note ?? '');

test('a run that is let go of for a closing process ends its stream with no end event, leaves nothing running in the server, and stops nothing on the sandbox', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('hang');
  const handle = await h.runners.claude.start(await h.spec('tsk_detach'));
  const events = reader(handle);
  await events.until(WORKING);
  const pid = await h.runPid('tsk_detach');
  assert.equal(await isRunning(pid), true);

  handle.detach?.();

  // The stream ends, and with no terminal event: the orchestrator must not read it as a result.
  assert.equal(terminal(await events.rest()), undefined);
  await until(() => h.runners.fleet.poller.watchCount() === 0);
  assert.equal(h.runners.fleet.openRuns, 0, 'the run is still counted open');
  assert.equal(h.runners.fleet.leaseRenewals, 0, 'the lease renewal timer still runs');
  // Nothing was stopped: the next process stops what is left when it takes the task over.
  assert.equal(await isRunning(pid), true, 'the agent process was stopped');
  // A second detach, and a cancel after it, are harmless.
  handle.detach?.();
  await handle.cancel();
});
