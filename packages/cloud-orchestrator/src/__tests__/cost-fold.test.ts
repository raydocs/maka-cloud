import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEvent, type TaskMap } from '../reducer.js';
import type { TaskEvent } from '../types.js';

const T = 'tsk_cost';

function start(): TaskMap {
  const tasks: TaskMap = new Map();
  applyEvent(tasks, {
    seq: 1,
    at: 1,
    event: { type: 'task_created', taskId: T, sessionId: 'ses_a', runner: 'fake', mode: 'async' },
  });
  return tasks;
}

const cost = (from: number, usd: number, epoch = 1): TaskEvent => ({
  type: 'task_cost',
  taskId: T,
  fromTaskId: `tsk_run${from}`,
  epoch,
  costUsd: usd,
});

test('a cost report does not add up every run the task has had', () => {
  const tasks = start();
  const task = tasks.get(T);
  assert.ok(task);
  let walks = 0;
  task.spendByRun = new Proxy<Record<string, number>>(
    {},
    {
      ownKeys(target) {
        walks += 1;
        return Reflect.ownKeys(target);
      },
    },
  );
  for (let i = 0; i < 1000; i += 1)
    applyEvent(tasks, { seq: 2 + i, at: 2 + i, event: cost(i, 0.001) });
  // At most the one walk that starts the running total; a walk per report is what made a long log quadratic.
  assert.ok(walks <= 1, `${walks} walks over the runs for 1000 reports`);
  assert.equal(tasks.get(T)?.costUsd, 1);
});

test('the total is the highest figure of each run, rounded, whatever order the reports come in', () => {
  const tasks = start();
  const reports = [
    cost(1, 0.3),
    cost(2, 0.1),
    cost(1, 0.2), // a lower figure for a run already at 0.3 changes nothing
    cost(2, 0.25),
    cost(1, 0.1, 2), // the same task in another attempt is another run
    cost(3, 0.1 + 0.2),
  ];
  const best = new Map<string, number>();
  for (const [i, event] of reports.entries()) {
    applyEvent(tasks, { seq: 2 + i, at: 2 + i, event });
    if (event.type !== 'task_cost') continue;
    const key = `${event.epoch}:${event.fromTaskId}`;
    best.set(key, Math.max(best.get(key) ?? 0, event.costUsd));
    const expected = Math.round([...best.values()].reduce((a, b) => a + b, 0) * 1e9) / 1e9;
    assert.equal(tasks.get(T)?.costUsd, expected, `after report ${i}`);
  }
  assert.equal(tasks.get(T)?.costUsd, 0.3 + 0.25 + 0.1 + 0.3);
});
