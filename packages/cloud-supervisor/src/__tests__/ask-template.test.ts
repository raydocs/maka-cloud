import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MANIFEST, MINUTE, rig } from './harness.js';

async function active(r: Awaited<ReturnType<typeof rig>>) {
  return r.supervisor.listItems({ state: 'open' }).items;
}

test('a rule’s ask carries the fixed sentence it was built from; the English ask and the options stay as they are', async () => {
  const r = await rig();
  await r.taskCreated('p', { title: 'parent' });
  await r.taskCreated('a', { parent: 'p', title: 'run “tests”' });
  await r.taskEvent({ type: 'task_failed', taskId: 'a', reason: 'tests failed' });
  await r.taskCreated('b', { parent: 'p', title: 'run “tests”' });
  await r.taskEvent({ type: 'task_failed', taskId: 'b', reason: 'tests failed again' });
  await r.supervisor.tick();
  const [failed] = await active(r);
  assert.equal(
    failed?.ask,
    "The step “run 'tests'” has failed 2 times. Last reason: “tests failed again”",
  );
  // The parts are what the English ask quotes, already made safe to put between quotes.
  assert.deepEqual(failed?.askTemplate, {
    id: 'failed_twice',
    title: "run 'tests'",
    count: 2,
    reason: 'tests failed again',
  });
  assert.deepEqual(
    failed?.options.map((option) => [option.id, option.label]),
    [
      ['retry', 'Ask the agent to try a different approach'],
      ['stop', 'Stop this work'],
      ['leave', 'Leave it'],
    ],
  );
  assert.deepEqual(r.host.interrupts.at(-1)?.items[0]?.askTemplate, failed?.askTemplate);
  await r.stop();
});

test('a stall and a low-confidence result carry their sentences; a conductor question has none', async () => {
  const r = await rig();
  await r.taskCreated('t', { title: '' });
  await r.taskEvent({ type: 'task_started', taskId: 't' });
  r.clock.advance(31 * MINUTE);
  await r.supervisor.tick();
  const [stall] = await active(r);
  assert.equal(stall?.ask, 'The task (untitled) has had no progress for 31 minutes.');
  assert.deepEqual(stall?.askTemplate, { id: 'stall', title: '', minutes: 31 });
  await r.taskEvent({ type: 'task_progress', taskId: 't', note: 'alive' });

  await r.taskCreated('top', { title: 'research' });
  await r.taskEvent({
    type: 'task_succeeded',
    taskId: 'top',
    manifest: { ...MANIFEST, confidence: 'low' },
  });
  const low = (await active(r)).find((item) => item.kind === 'decision');
  assert.deepEqual(low?.askTemplate, {
    id: 'low_confidence',
    title: 'research',
    summary: MANIFEST.summary,
  });

  await r.question('q_taste', 'taste');
  await r.supervisor.tick();
  const question = (await active(r)).find((item) => item.taskId === null);
  assert.ok(question);
  assert.equal(question.askTemplate, undefined, 'the conductor’s own words are not a template');
  await r.stop();
});
