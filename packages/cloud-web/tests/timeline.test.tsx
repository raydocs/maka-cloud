import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  await waitFor(() => expect(timeline).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(document.querySelectorAll('[data-state]')).toHaveLength(2));
  fireEvent(document, new Event('visibilitychange'));
  await waitFor(() => expect(timeline).toHaveBeenCalledTimes(4));
  expect(document.querySelectorAll('[data-state]')).toHaveLength(2);
});

function timelineFixture() {
  const client = new CloudClient('test');
  vi.spyOn(client, 'listArtifacts').mockResolvedValue({ artifacts: [], total: 0 });
  vi.spyOn(client, 'listInbox').mockResolvedValue([]);
  vi.spyOn(client, 'listSources').mockResolvedValue({ sources: [], total: 0 });
  const page = (ids: string[], next?: number): Awaited<ReturnType<CloudClient['timeline']>> => ({
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
      content: false,
      messages: { sent: 0, read: 0, unseen: 0, withdrawn: 0 },
      steps: ids.map(
        (stepId) =>
          ({
            stepId,
            kind: stepId,
            state: 'done',
            replay: 'safe',
            epoch: 1,
            attempts: 1,
            startedAt: 0,
          }) as TimelineStep,
      ),
      stepsNext: next,
    },
  });
  const task = {
    taskId: 't',
    state: 'running',
    createdAt: 0,
    progress: [],
    cancelRequested: false,
    pauseRequested: false,
  } as TaskView;
  const view = (progress: string[] = []) => (
    <LanguageProvider language="en">
      <TaskPage client={client} task={{ ...task, progress }} onBack={() => {}} />
    </LanguageProvider>
  );
  return { client, page, view };
}

test('running timelines refresh at most once per five seconds and retain loaded pages', async () => {
  const { client, page, view } = timelineFixture();
  const timeline = vi
    .spyOn(client, 'timeline')
    .mockImplementation(async (_id, cursor) =>
      cursor?.after === undefined ? page(['one'], 1) : page(['one', 'two']),
    );
  vi.useFakeTimers();
  try {
    const { rerender } = render(view());
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Load more steps' }));
    await act(async () => {});
    rerender(view(['tick']));
    await act(() => vi.advanceTimersByTimeAsync(4999));
    expect(timeline).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(timeline).toHaveBeenCalledTimes(3);
    expect(document.querySelectorAll('[data-state]')).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

test.each(['refresh-first', 'more-first'])(
  'refresh racing Load more preserves pages: %s',
  async (order) => {
    const { client, page, view } = timelineFixture();
    const timeline = vi.spyOn(client, 'timeline').mockResolvedValue(page(['one'], 1));
    render(view());
    await screen.findByRole('button', { name: 'Load more steps' });
    let finishRefresh!: (value: ReturnType<typeof page>) => void;
    let finishMore!: (value: ReturnType<typeof page>) => void;
    timeline.mockImplementation(
      (_id, cursor) =>
        new Promise((resolve) => {
          if (cursor?.after === undefined) finishRefresh = resolve;
          else finishMore = resolve;
        }),
    );
    fireEvent(document, new Event('visibilitychange'));
    fireEvent.click(screen.getByRole('button', { name: 'Load more steps' }));
    if (order === 'refresh-first') {
      await act(async () => finishRefresh(page(['one'], 1)));
      await act(async () => finishMore(page(['one', 'two'], 2)));
    } else {
      await act(async () => finishMore(page(['one', 'two'], 2)));
      await act(async () => finishRefresh(page(['one'], 1)));
    }
    expect(document.querySelectorAll('[data-state]')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Load more steps' }).hasAttribute('disabled')).toBe(
      false,
    );
  },
);

test('hidden tabs skip polls and a terminal response stops polling a stale running task', async () => {
  const { client, page, view } = timelineFixture();
  const response = page(['one']);
  const timeline = vi.spyOn(client, 'timeline').mockResolvedValue(response);
  vi.useFakeTimers();
  try {
    render(view());
    await act(async () => {});
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(() => vi.advanceTimersByTimeAsync(15000));
    expect(timeline).toHaveBeenCalledTimes(1);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    timeline.mockResolvedValue({ timeline: { ...response.timeline, state: 'succeeded' } });
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(timeline).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(15000));
    expect(timeline).toHaveBeenCalledTimes(2);
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

test('three loaded pages cost one request per poll and preserve earlier steps', async () => {
  const { client, page, view } = timelineFixture();
  const timeline = vi.spyOn(client, 'timeline').mockImplementation(async (_id, cursor) => {
    const after = cursor?.after ?? 0;
    return page([String(after)], after < 2 ? after + 1 : undefined);
  });
  vi.useFakeTimers();
  try {
    render(view());
    await act(async () => {});
    for (let i = 0; i < 2; i++) {
      fireEvent.click(screen.getByRole('button', { name: 'Load more steps' }));
      await act(async () => {});
    }
    expect(timeline).toHaveBeenCalledTimes(3);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(timeline).toHaveBeenCalledTimes(4);
    expect(timeline).toHaveBeenLastCalledWith('t', { after: 2 });
    expect(document.querySelectorAll('[data-state]')).toHaveLength(3);
  } finally {
    vi.useRealTimers();
  }
});
