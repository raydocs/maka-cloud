import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signalOf } from '../events.js';

test('a narration line or a panel of a task is no signal: the supervisor reads none of it', () => {
  for (const event of [
    { type: 'task_narration', taskId: 't1', line: 'Running the tests' },
    {
      type: 'task_panel',
      taskId: 't1',
      panelId: 'tests',
      kind: 'tests',
      state: 'running',
      title: 'Repository tests',
      summary: 'running',
    },
  ]) {
    assert.equal(
      signalOf({ id: 1, kind: 'task.event', conversationId: 'c1', at: 1, data: { event } }),
      undefined,
    );
  }
  // The task's own progress still counts, so a run with panels is not mistaken for a stalled one.
  assert.equal(
    signalOf({
      id: 2,
      kind: 'task.event',
      conversationId: 'c1',
      at: 2,
      data: { event: { type: 'task_progress', taskId: 't1', note: 'n' } },
    })?.type,
    'task',
  );
});
