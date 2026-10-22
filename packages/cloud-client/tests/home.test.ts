import { expect, test } from 'vitest';
import {
  doneSince,
  type InboxItem,
  nextRuns,
  type ProjectView,
  relativeTime,
  splitSuggestions,
  suggestionLine,
  type TaskView,
  verbOf,
} from '../src/index';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

const task = (over: Partial<TaskView>): TaskView => ({
  taskId: 't1',
  title: 'Fix the login loop',
  state: 'succeeded',
  createdAt: NOW - 3 * HOUR,
  finishedAt: NOW - HOUR,
  progress: [],
  cancelRequested: false,
  pauseRequested: false,
  manifest: {
    summary: 'The login page no longer loops. Tests pass.',
    done: [],
    notDone: [],
    confidence: 'high',
    knownIssues: [],
  },
  costUsd: 0.42,
  ...over,
});

test('done since: top-level finished tasks after the cut, newest first, with an outcome in words', () => {
  const tasks = new Map<string, TaskView[]>([
    [
      'c1',
      [
        task({ taskId: 'old', finishedAt: NOW - 30 * HOUR }),
        task({ taskId: 'sub', parentTaskId: 't1' }),
        task({ taskId: 'running', state: 'running', finishedAt: undefined }),
        task({ taskId: 'a', finishedAt: NOW - 2 * HOUR }),
      ],
    ],
    [
      'c2',
      [
        task({
          taskId: 'b',
          title: 'Upgrade deps',
          state: 'failed',
          finishedAt: NOW - HOUR,
          failureReason: 'The build broke on the new version. More detail follows.',
          manifest: undefined,
          costUsd: undefined,
        }),
        task({ taskId: 'c', state: 'cancelled', finishedAt: NOW - 10 * MIN, manifest: undefined }),
      ],
    ],
  ]);
  const entries = doneSince(tasks, NOW - 24 * HOUR);
  expect(entries.map((e) => e.taskId)).toEqual(['c', 'b', 'a']);
  expect(entries.map((e) => e.outcome)).toEqual([
    'Stopped before it finished.',
    'The build broke on the new version.',
    'The login page no longer loops.',
  ]);
  expect(entries[1]?.costUsd).toBeUndefined();
  expect(entries[0]?.conversationId).toBe('c2');
});

test('done since shows at most eight lines', () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    task({ taskId: `t${i}`, finishedAt: NOW - (i + 1) * MIN }),
  );
  expect(doneSince(new Map([['c', many]]), 0)).toHaveLength(8);
});

const duty = (over: Partial<ProjectView['duties'][number]>): ProjectView['duties'][number] => ({
  dutyId: 'd1',
  name: 'Nightly dependency check',
  trigger: { kind: 'schedule', everyMinutes: 60 },
  authority: 'open-pr',
  runBudgetUsd: 2,
  dailyCapUsd: 5,
  state: 'active',
  activatedAt: NOW - 150 * MIN,
  offReason: null,
  consecutiveFailures: 0,
  ...over,
});

test('what runs next: the next slot after now, soonest first; event duties are counted, off ones are not', () => {
  const projects: ProjectView[] = [
    {
      projectId: 'p1',
      repo: 'acme/web',
      defaultBranch: 'main',
      duties: [
        duty({}), // slots at +60, +120, +180 min after activation: the next is 30 min from now
        duty({
          dutyId: 'd2',
          name: 'Weekly sweep',
          trigger: { kind: 'schedule', everyMinutes: 15 },
          activatedAt: NOW - 7 * MIN,
        }),
        duty({ dutyId: 'd3', name: 'Fix CI', trigger: { kind: 'ci_failed_default_branch' } }),
        duty({ dutyId: 'd4', name: 'Off one', state: 'off' }),
        duty({ dutyId: 'd5', name: 'Not approved', state: 'proposed', activatedAt: null }),
      ],
    },
  ];
  const result = nextRuns(projects, NOW);
  expect(result.scheduled.map((r) => [r.name, r.at - NOW])).toEqual([
    ['Weekly sweep', 8 * MIN],
    ['Nightly dependency check', 30 * MIN],
  ]);
  expect(result.scheduled[0]?.repo).toBe('acme/web');
  expect(result.watching).toBe(1);
});

test('relative time and verbs', () => {
  expect(relativeTime(NOW + 20_000, NOW)).toBe('any moment now');
  expect(relativeTime(NOW + 8 * MIN, NOW)).toBe('in 8 min');
  expect(relativeTime(NOW + 3 * HOUR, NOW)).toBe('in 3 h');
  expect(relativeTime(NOW + 72 * HOUR, NOW)).toBe('in 3 days');
  expect(relativeTime(NOW - HOUR, NOW)).toBe('any moment now');
  expect(verbOf('approval')).toBe('Approve');
  expect(verbOf('finished')).toBe('Review');
  expect(verbOf('something_new')).toBe('Decide');
});

test('a suggestion has its own verb, and its line says mode, cost and repository in words', () => {
  expect(verbOf('suggestion')).toBe('Suggested');
  const facts = {
    kind: 'fix_main_ci',
    mode: 'standard' as const,
    estimateUsd: 3,
    typical: false,
    repo: 'acme/widgets',
    detail: '',
    external: false,
  };
  expect(suggestionLine(facts)).toBe('Standard · about $3.00 · acme/widgets');
  expect(suggestionLine({ ...facts, mode: 'quick', typical: true, estimateUsd: 0.5 })).toBe(
    'Quick · about $0.50 (typical) · acme/widgets',
  );
});

test('suggestions are kept apart from what needs a decision', () => {
  const item = (itemId: string, kind: InboxItem['kind']) => ({ itemId, kind }) as InboxItem;
  const { waiting, suggested } = splitSuggestions([
    item('a', 'approval'),
    item('b', 'suggestion'),
    item('c', 'finished'),
  ]);
  expect(waiting.map((i) => i.itemId)).toEqual(['a', 'c']);
  expect(suggested.map((i) => i.itemId)).toEqual(['b']);
});
