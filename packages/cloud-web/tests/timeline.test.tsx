import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { CloudClient, type TaskView, type TimelineStep } from '@maka-cloud/client';
import { TaskPage } from '../src/TaskPage';
import { LanguageProvider } from '../src/i18n';

afterEach(cleanup);
test.each(['en', 'zh-Hans', 'zh-Hant'] as const)(
  'timeline distinguishes interrupted, failed and done in %s',
  async (language) => {
    const client = new CloudClient('test');
    vi.spyOn(client, 'listArtifacts').mockResolvedValue({ artifacts: [], total: 0 });
    vi.spyOn(client, 'listInbox').mockResolvedValue([]);
    vi.spyOn(client, 'listSources').mockResolvedValue({ sources: [], total: 0 });
    vi.spyOn(client, 'timeline').mockResolvedValue({
      timeline: {
        taskId: 't',
        state: 'failed',
        createdAt: 0,
        runMs: 25,
        turns: [],
        turnsTotal: 0,
        stepsTotal: 3,
        cost: [],
        costReports: 0,
        messages: { sent: 0, read: 0, unseen: 0, withdrawn: 0 },
        content: false,
        steps: ['done', 'failed', 'interrupted'].map((state, i) => ({
          stepId: String(i),
          kind: 'shell',
          state,
          replay: 'never',
          epoch: 1,
          attempts: 1,
          startedAt: 0,
          durationMs: 25,
        })) as TimelineStep[],
      },
    });
    render(
      <LanguageProvider language={language}>
        <TaskPage
          client={client}
          task={
            {
              taskId: 't',
              state: 'failed',
              createdAt: 0,
              progress: [],
              cancelRequested: false,
              pauseRequested: false,
            } as TaskView
          }
          onBack={() => {}}
        />
      </LanguageProvider>,
    );
    await waitFor(() => expect(document.querySelectorAll('[data-state]')).toHaveLength(3));
    const interrupted = document.querySelector('[data-state="interrupted"]')!;
    expect(interrupted.textContent).toContain(
      {
        en: 'May or may not have happened — check before redoing it',
        'zh-Hans': '可能已执行，也可能未执行——重试前请先检查',
        'zh-Hant': '可能已執行，也可能未執行——重試前請先檢查',
      }[language],
    );
    expect(interrupted.textContent).toContain('25');
    expect(document.querySelector('[data-state="done"]')?.textContent).not.toEqual(
      interrupted.textContent,
    );
  },
);

test('progress ticks preserve loaded pages; terminal and visible refreshes deduplicate steps', async () => {
  const client = new CloudClient('test');
  vi.spyOn(client, 'listArtifacts').mockResolvedValue({ artifacts: [], total: 0 });
  vi.spyOn(client, 'listInbox').mockResolvedValue([]);
  vi.spyOn(client, 'listSources').mockResolvedValue({ sources: [], total: 0 });
  const step = (stepId: string, state = 'running') =>
    ({
      stepId,
      kind: 'shell',
      state,
      replay: 'never',
      epoch: 1,
      attempts: 1,
      startedAt: 0,
    }) as TimelineStep;
  const timeline = vi.spyOn(client, 'timeline').mockImplementation(async (_task, page) => ({
    timeline: {
      taskId: 't',
      state: 'running',
      createdAt: 0,
      runMs: 0,
      turns: [],
      turnsTotal: 0,
      stepsTotal: 3,
      cost: [],
      costReports: 0,
      messages: { sent: 0, read: 0, unseen: 0, withdrawn: 0 },
      content: false,
      steps: page?.after === undefined ? [step('1')] : [step('1', 'done'), step('2')],
      stepsNext: page?.after === undefined ? 1 : undefined,
    },
  }));
  const task = {
    taskId: 't',
    state: 'running',
    createdAt: 0,
    progress: [],
    cancelRequested: false,
    pauseRequested: false,
  } as TaskView;
  const view = (task: TaskView) => (
    <LanguageProvider language="en">
      <TaskPage client={client} task={task} onBack={() => {}} />
    </LanguageProvider>
  );
  const { rerender } = render(view(task));
  await screen.findByRole('button', { name: 'Load more steps' });
  fireEvent.click(screen.getByRole('button', { name: 'Load more steps' }));
  await waitFor(() => expect(document.querySelectorAll('[data-state]')).toHaveLength(2));
  expect(timeline).toHaveBeenCalledTimes(2);
  rerender(view({ ...task, progress: ['tick'] } as TaskView));
  expect(timeline).toHaveBeenCalledTimes(2);
  expect(document.querySelectorAll('[data-state]')).toHaveLength(2);
  rerender(view({ ...task, state: 'succeeded' }));
  await waitFor(() => expect(timeline).toHaveBeenCalledTimes(4));
  await waitFor(() => expect(document.querySelectorAll('[data-state]')).toHaveLength(2));
  fireEvent(document, new Event('visibilitychange'));
  await waitFor(() => expect(timeline).toHaveBeenCalledTimes(6));
  expect(document.querySelectorAll('[data-state]')).toHaveLength(2);
});
