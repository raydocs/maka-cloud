import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskPanel, TaskView } from '@maka-cloud/client';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { TaskPill, WorkBlock } from '@/components/Work';
import { ReduceMotion } from '@/lib/appearance';
import { type Language, LanguageProvider, translator } from '@/lib/i18n';
import { LIGHT, ThemeContext } from '@/lib/theme';
import {
  chatTimeline,
  doneSummary,
  panelSummary,
  RUNNER_WORDS,
  runnerWords,
  workSteps,
} from '@/lib/work';

const task = (over: Partial<TaskView> = {}): TaskView => ({
  taskId: 't1',
  title: 'Fix the login loop',
  state: 'running',
  createdAt: 100,
  startedAt: 100,
  progress: [],
  cancelRequested: false,
  pauseRequested: false,
  ...over,
});

const panel = (over: Partial<TaskPanel>): TaskPanel => ({
  panelId: 'tests',
  kind: 'tests',
  state: 'running',
  title: 'Repository tests',
  summary: 'running',
  ...over,
});

const shown = (node: ReactElement, language: Language = 'en', reduce = false) =>
  render(
    <LanguageProvider language={language}>
      <ReduceMotion.Provider value={reduce}>
        <ThemeContext.Provider value={LIGHT}>{node}</ThemeContext.Provider>
      </ReduceMotion.Provider>
    </LanguageProvider>,
  );

test('the chat in time order: a message, its work, its task, the reply, and the result where it finished', () => {
  const messages = [
    { id: 'm1', role: 'user' as const, text: 'Fix it', at: 50 },
    { id: 'm2', role: 'assistant' as const, text: 'On it', at: 120 },
    { id: 'm3', role: 'user' as const, text: 'Also the docs', at: 300 },
  ];
  const fixed = task({ state: 'succeeded', finishedAt: 400 });
  const items = chatTimeline(messages, [fixed]);
  expect(items.map((item) => item.key)).toEqual([
    'm1',
    'work-m1',
    'task-t1',
    'm2',
    'm3',
    // The latest message always has its block: it carries the "working" line before any task.
    'work-m3',
    'result-t1',
  ]);
  const work = items.find((item) => item.key === 'work-m1');
  expect(work?.type === 'work' && work.tasks.map((t) => t.taskId)).toEqual(['t1']);
  expect(work?.type === 'work' && work.last).toBe(false);
});

test('a task from before any message (a standing duty) has a block of its own at the top', () => {
  const items = chatTimeline([{ id: 'm1', role: 'user', text: 'Hi', at: 500 }], [task()]);
  expect(items.map((item) => item.key)).toEqual(['work-lead', 'task-t1', 'm1', 'work-m1']);
});

test('steps: a panel has its state; a task with no panels shows its noted steps, only the current one running', () => {
  const coding = task({
    panels: [
      panel({
        panelId: 'diff',
        kind: 'diff',
        state: 'passed',
        title: 'Change',
        summary: '2 files',
      }),
      panel({ state: 'failed', summary: '41 passed, 1 failed' }),
    ],
  });
  const research = task({ taskId: 't2', progress: ['step: Reading the docs', 'step: Comparing'] });
  expect(workSteps([coding, research]).map((step) => [step.title, step.state])).toEqual([
    ['Change', 'passed'],
    ['Repository tests', 'failed'],
    ['Reading the docs', 'noted'],
    ['Comparing', 'running'],
  ]);
  // Once it ended, no noted step is said to be running.
  expect(workSteps([{ ...research, state: 'succeeded' }]).map((step) => step.state)).toEqual([
    'noted',
    'noted',
  ]);
});

test('a finished block says how long it worked and how many steps, and only what is known', () => {
  const say = translator('en').t;
  const done = task({
    state: 'succeeded',
    startedAt: 0,
    finishedAt: 4 * 60_000,
    panels: [panel({ state: 'passed', summary: 'passed' })],
  });
  expect(doneSummary([done], say)).toBe('Worked for 4 min · 1 step');
  expect(doneSummary([{ ...done, finishedAt: 20_000 }], say)).toBe(
    'Worked for under a minute · 1 step',
  );
  expect(doneSummary([{ ...done, finishedAt: 125 * 60_000 }], say)).toBe(
    'Worked for 2 h 5 min · 1 step',
  );
  // A task that has not finished has no time to report.
  expect(doneSummary([{ ...done, state: 'paused', finishedAt: undefined }], say)).toBe('1 step');
  expect(translator('zh-Hans').t('work.minutes', { count: 4 })).toBe('用时 4 分钟');
});

test('every fixed panel summary has its words, the same in English as the server sent them', () => {
  const shapes = [
    'running',
    'stopped',
    'passed',
    'failed',
    'timed out',
    'could not run',
    'not available',
    'no changes',
    'exit 2',
    'failed (exit 1)',
    '41 passed',
    '3 failed',
    '41 passed, 1 failed',
    '1 file',
    '2 files',
    '+12 −3 in 1 file',
    '+12 −3 in 2 files',
    '0 P1, 2 P2, 1 P3',
    '1 result',
    '7 results',
  ];
  const en = translator('en').t;
  const zh = translator('zh-Hans').t;
  const hant = translator('zh-Hant').t;
  for (const shape of shapes) {
    expect(panelSummary(shape, en)).toBe(shape);
    expect([shape, panelSummary(shape, zh) === shape]).toEqual([shape, false]);
    expect([shape, panelSummary(shape, hant) === shape]).toEqual([shape, false]);
  }
  expect(panelSummary('41 passed, 1 failed', zh)).toBe('41 个通过，1 个失败');
  expect(panelSummary('+12 −3 in 2 files', hant)).toBe('2 個檔案，+12 −3');
  // Anything else is shown as sent.
  expect(panelSummary('almost there', zh)).toBe('almost there');
});

// The runner's lines are the server's own words: each must still be written there, word for word.
test('every translated runner line and panel title is one the coding runner writes', () => {
  const read = (path: string) => readFileSync(join(__dirname, '../..', path), 'utf8');
  const source =
    read('cloud-playbooks/src/coding/runner.ts') + read('cloud-playbooks/src/coding/panels.ts');
  for (const [english] of RUNNER_WORDS) {
    const quoted = english.includes("'") ? `"${english}"` : `'${english}'`;
    expect([english, source.includes(quoted)]).toEqual([english, true]);
  }
  expect(runnerWords('Fetching the repository', translator('zh-Hant').t)).toBe('正在取得存放庫');
  expect(runnerWords('Doing something new', translator('zh-Hans').t)).toBe('Doing something new');
});

test('while it works: the thinking mark, the narration as the live line, and a row per step', async () => {
  const working = task({
    narration: "Running the repository's tests",
    panels: [
      panel({
        panelId: 'diff',
        kind: 'diff',
        state: 'passed',
        title: 'Change',
        summary: '2 files',
      }),
      panel({
        panelId: 'repro',
        state: 'failed',
        title: 'Reproduction test with the change',
        summary: 'failed',
      }),
      panel({}),
    ],
  });
  await shown(<WorkBlock tasks={[working]} working />, 'zh-Hans');
  expect(screen.getByTestId('thinking', { includeHiddenElements: true })).toBeTruthy();
  expect(screen.getByText('正在运行仓库的测试')).toBeTruthy();
  expect(screen.getByText('改动')).toBeTruthy();
  expect(screen.getByText('2 个文件')).toBeTruthy();
  expect(screen.getByTestId('step-passed', { includeHiddenElements: true })).toBeTruthy();
  expect(screen.getByTestId('step-failed', { includeHiddenElements: true })).toBeTruthy();
  expect(screen.getByTestId('spinner', { includeHiddenElements: true })).toBeTruthy();
  expect(screen.getByLabelText('带改动的复现测试：失败，未通过')).toBeTruthy();
});

test('once done it folds to one line, which opens the steps again', async () => {
  const done = task({
    state: 'succeeded',
    startedAt: 0,
    finishedAt: 6 * 60_000,
    panels: [panel({ state: 'passed', summary: '41 passed' })],
  });
  await shown(<WorkBlock tasks={[done]} working={false} />);
  expect(screen.getByText('Worked for 6 min · 1 step')).toBeTruthy();
  expect(screen.queryByText('Repository tests')).toBeNull();
  expect(screen.queryByTestId('thinking', { includeHiddenElements: true })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: /Show the steps/u }));
  expect(screen.getByText('Repository tests')).toBeTruthy();
  expect(screen.getByText('41 passed')).toBeTruthy();
});

test('a finished turn with nothing known to show draws nothing', async () => {
  await shown(<WorkBlock tasks={[]} working={false} />);
  expect(screen.queryByTestId('work-block')).toBeNull();
});

test('under Reduce Motion nothing turns: the spinner is a still ring and the line does not breathe', async () => {
  await shown(<WorkBlock tasks={[task({ panels: [panel({})] })]} working />, 'en', true);
  expect(screen.queryByTestId('spinner', { includeHiddenElements: true })).toBeNull();
  expect(screen.getByTestId('spinner-still', { includeHiddenElements: true })).toBeTruthy();
  expect(screen.queryByTestId('shimmer', { includeHiddenElements: true })).toBeNull();
});

test('a task pill shows its live state: a spinner, a check, a cross, or the attention dot while it waits', async () => {
  const pill = (over: Partial<TaskView>, waiting = false) => (
    <TaskPill task={task(over)} waiting={waiting} open={false} onToggle={() => {}} />
  );
  const view = await shown(pill({}));
  expect(
    screen.getByRole('button', { name: 'Task: Fix the login loop, In progress' }),
  ).toBeTruthy();
  expect(screen.getByTestId('spinner', { includeHiddenElements: true })).toBeTruthy();
  await act(async () => {
    view.rerender(
      <LanguageProvider language="zh-Hant">
        <ThemeContext.Provider value={LIGHT}>{pill({}, true)}</ThemeContext.Provider>
      </LanguageProvider>,
    );
  });
  expect(screen.getByRole('button', { name: '任務：Fix the login loop，等你回覆' })).toBeTruthy();
  expect(screen.getByTestId('mark-attention', { includeHiddenElements: true })).toBeTruthy();
});
