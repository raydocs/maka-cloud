import { expect, test } from 'vitest';
import type { FeedEvent } from '../src/contract';
import { applyEvent, emptyState } from '../src/state';

type TaskEventData = Extract<FeedEvent, { kind: 'task.event' }>['data']['event'];

const frames = (events: TaskEventData[]): FeedEvent[] =>
  events.map((event, i) => ({
    id: i + 1,
    kind: 'task.event',
    data: { conversationId: 'c1', seq: i + 1, at: 1000 + i, event },
  }));
const fold = (events: TaskEventData[]) => frames(events).reduce(applyEvent, emptyState()).tasks.t1;

const created: TaskEventData = {
  type: 'task_created',
  taskId: 't1',
  sessionId: 's',
  mode: 'async',
};
const started: TaskEventData = { type: 'task_started', taskId: 't1' };
const panel = (over: Record<string, unknown> = {}): TaskEventData =>
  ({
    type: 'task_panel',
    taskId: 't1',
    panelId: 'tests',
    kind: 'tests',
    state: 'running',
    title: 'Repository tests',
    summary: 'running',
    ...over,
  }) as TaskEventData;

test('the narration line replaces the last, and a panel is replaced where it stands by its id', () => {
  const task = fold([
    created,
    started,
    { type: 'task_narration', taskId: 't1', line: 'Running the tests' },
    panel(),
    panel({ panelId: 'diff', kind: 'diff', state: 'passed', title: 'Change', summary: '1 file' }),
    { type: 'task_narration', taskId: 't1', line: 'Reviewing the change' },
    panel({ state: 'passed', summary: '41 passed', tail: 'ok' }),
  ]);
  expect(task?.narration).toBe('Reviewing the change');
  expect(task?.panels?.map((p) => [p.panelId, p.state, p.summary])).toEqual([
    ['tests', 'passed', '41 passed'],
    ['diff', 'passed', '1 file'],
  ]);
  expect(task?.panels?.[0]).not.toHaveProperty('type');
  expect(task?.panels?.[0]).not.toHaveProperty('taskId');
});

test('replaying the same stream rebuilds the same panels, and a second start of the story does not double them', () => {
  const stream: TaskEventData[] = [
    created,
    started,
    { type: 'task_narration', taskId: 't1', line: 'Running the tests' },
    panel(),
    panel({ state: 'failed', summary: '41 passed, 1 failed' }),
  ];
  const once = fold(stream);
  const twice = fold([...stream, ...stream.slice(1)]);
  expect(twice?.panels).toEqual(once?.panels);
  expect(twice?.narration).toBe(once?.narration);
});

test('a task that ends or restarts shows no panel as running and no line for what it is doing', () => {
  for (const end of [
    { type: 'task_failed', taskId: 't1', reason: 'boom' },
    { type: 'task_cancelled', taskId: 't1' },
    {
      type: 'task_succeeded',
      taskId: 't1',
      manifest: { summary: 's', done: [], notDone: [], confidence: 'high', knownIssues: [] },
    },
  ] as TaskEventData[]) {
    const task = fold([
      created,
      started,
      { type: 'task_narration', taskId: 't1', line: 'Running the tests' },
      panel(),
      panel({ panelId: 'diff', kind: 'diff', state: 'passed', title: 'Change', summary: '1 file' }),
      end,
    ]);
    expect(task?.panels?.map((p) => p.state)).toEqual(['stopped', 'passed']);
    expect(task?.narration).toBeUndefined();
  }
  const restarted = fold([
    created,
    started,
    panel(),
    { type: 'task_restarted', taskId: 't1', epoch: 2, text: 'back' },
    panel({ state: 'passed', summary: 'passed' }),
  ]);
  expect(restarted?.panels?.map((p) => p.state)).toEqual(['passed']);
});

test('a task keeps a bounded number of panels', () => {
  const task = fold([
    created,
    started,
    ...Array.from({ length: 40 }, (_, i) => panel({ panelId: `p${i}` })),
  ]);
  expect(task?.panels).toHaveLength(12);
  expect(task?.panels?.at(-1)?.panelId).toBe('p39');
});

test('a panel or line for a task the client does not know changes nothing', () => {
  const state = frames([
    { type: 'task_narration', taskId: 'nope', line: 'x' },
    panel({ taskId: 'nope' }),
  ]).reduce(applyEvent, emptyState());
  expect(state.tasks).toEqual({});
});

test('a message and a notice keep when the server posted them, so a view can place work between them', () => {
  const posted: FeedEvent[] = [
    {
      id: 1,
      kind: 'message.posted',
      data: { conversationId: 'c1', messageId: 'm1', role: 'user', text: 'Fix it', at: 10 },
    },
    {
      id: 2,
      kind: 'conductor.notice',
      data: { conversationId: 'c1', noticeId: 'n1', text: 'Started', at: 20 },
    },
  ];
  const state = posted.reduce(applyEvent, emptyState());
  expect(state.messages.map((message) => [message.id, message.at])).toEqual([
    ['m1', 10],
    ['n1', 20],
  ]);
});
