import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { type CloudClient, type TaskView } from '@maka-cloud/client';
import {
  ApprovalReceipt,
  elapsed,
  RunningClock,
  SteerComposer,
  WaitingJump,
} from '../src/WorkStatus';
import { Computer } from '../src/Computer';
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const task: TaskView = {
  taskId: 'task-1',
  title: 'Repair the build',
  state: 'running',
  createdAt: 0,
  startedAt: 1000,
  progress: [],
  cancelRequested: false,
  pauseRequested: false,
};
const run = async (_key: string, work: () => Promise<unknown>) => {
  try {
    await work();
    return true;
  } catch {
    return false;
  }
};

test('steering retries with the same id, withdraws pending messages and can switch off', async () => {
  const sendTaskMessage = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockImplementation(async (_task, _text, id) => ({
      message: { messageId: id, state: 'pending' },
    }));
  const withdrawTaskMessage = vi.fn(async (_task, id) => ({
    message: { messageId: id, state: 'withdrawn' },
  }));
  const clear = vi.fn();
  const normal = vi.fn((event) => event.preventDefault());
  render(
    <SteerComposer
      client={{ sendTaskMessage, withdrawTaskMessage } as unknown as CloudClient}
      tasks={[task]}
      draft="Use the smaller change"
      setDraft={clear}
      act={run}
      busy={false}
    >
      <form onSubmit={normal}>
        <button type="submit">Send</button>
      </form>
    </SteerComposer>,
  );
  fireEvent.click(screen.getByText('Send'));
  await screen.findByText('Delivery not confirmed. Try again with the same message.', {
    exact: false,
  });
  expect(clear).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Check delivery'));
  await screen.findByText('Waiting for the next step', { exact: false });
  expect(sendTaskMessage.mock.calls[0]).toEqual(sendTaskMessage.mock.calls[1]);
  expect(sendTaskMessage.mock.calls[0]?.slice(0, 2)).toEqual(['task-1', 'Use the smaller change']);
  expect(normal).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Take back'));
  await screen.findByText('Taken back', { exact: false });
  expect(screen.queryByText('Take back')).toBeNull();
  expect(withdrawTaskMessage).toHaveBeenCalledWith('task-1', sendTaskMessage.mock.calls[0]?.[2]);
  fireEvent.change(screen.getByLabelText('To the running task'), { target: { value: '' } });
  fireEvent.click(screen.getByText('Send'));
  expect(normal).toHaveBeenCalledOnce();
});
test('multiple tasks require a choice and delivered messages have no withdraw', async () => {
  const sendTaskMessage = vi.fn(async (_task, _text, id) => ({
    message: { messageId: id, state: 'delivered' },
  }));
  render(
    <SteerComposer
      client={{ sendTaskMessage } as unknown as CloudClient}
      tasks={[task, { ...task, taskId: 'task-2', title: 'Review' }]}
      draft="Check this"
      setDraft={() => {}}
      act={run}
      busy={false}
    >
      <form>
        <button type="submit">Send</button>
      </form>
    </SteerComposer>,
  );
  expect((screen.getByLabelText('To the running task') as HTMLSelectElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('To the running task'), { target: { value: 'task-2' } });
  fireEvent.click(screen.getByText('Send'));
  await screen.findByText('Read by the task', { exact: false });
  expect(sendTaskMessage.mock.calls[0]?.[0]).toBe('task-2');
  expect(screen.queryByText('Take back')).toBeNull();
});
test('clock ticks and excludes observed pauses', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const view = render(<RunningClock task={task} />);
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  expect(screen.getByText('Working for 00:02')).toBeTruthy();
  view.rerender(<RunningClock task={{ ...task, state: 'paused' }} />);
  act(() => {
    vi.advanceTimersByTime(6000);
  });
  view.rerender(<RunningClock task={task} />);
  expect(screen.getByText('Working for 00:02')).toBeTruthy();
  expect(elapsed(65000)).toBe('01:05');
});
test.each([
  ['approve', 'Allowed once'],
  ['approve_task', 'Allowed for this task'],
  ['approve_repository', 'Allowed for this repository'],
])('approval %s names scope and links revocation', (option, label) => {
  const open = vi.fn();
  window.addEventListener('maka:grants', open, { once: true });
  render(<ApprovalReceipt option={option!} />);
  expect(screen.getByText(label!, { exact: false })).toBeTruthy();
  fireEvent.click(screen.getByRole('link'));
  expect(open).toHaveBeenCalledOnce();
});
test('waiting chip tracks visibility and respects reduced motion', async () => {
  let observe: IntersectionObserverCallback;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        observe = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const target = document.createElement('div');
  const card = document.createElement('section');
  card.dataset.waiting = 'true';
  target.append(card);
  card.scrollIntoView = vi.fn();
  render(<WaitingJump count={1} target={{ current: target }} />);
  expect(screen.queryByText('1 waiting')).toBeNull();
  act(() =>
    observe!(
      [{ target: card, isIntersecting: false } as unknown as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
  fireEvent.click(await screen.findByText('1 waiting'));
  expect(card.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'instant' });
  act(() =>
    observe!(
      [{ target: card, isIntersecting: true } as unknown as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
  expect(screen.queryByText('1 waiting')).toBeNull();
});
test('finished computer explains how to continue without opening a stream', async () => {
  const watchComputer = vi.fn();
  render(
    <Computer
      client={{ watchComputer } as unknown as CloudClient}
      task={{ ...task, state: 'succeeded' }}
    />,
  );
  const details = screen.getByText('Open computer').closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  await screen.findByText('The task finished. Send a message to continue.');
  expect(watchComputer).not.toHaveBeenCalled();
});

test.each([
  [404, 'not_found', 'The computer may be asleep or unavailable. Wait, then reconnect.'],
  [409, 'computer_busy', 'Control is held elsewhere or changing. Retry after it is returned.'],
  [503, 'unavailable', 'The connection dropped. Reconnect to continue watching.'],
])(
  'unavailable computer %s explains a next step and disables input',
  async (status, code, sentence) => {
    const { ApiError } = await import('@maka-cloud/client');
    const watchComputer = vi.fn(async () => {
      throw new ApiError(Number(status), String(code));
    });
    render(<Computer client={{ watchComputer } as unknown as CloudClient} task={task} />);
    const details = screen.getByText('Open computer').closest('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    await screen.findByText(String(sentence));
    expect((screen.getByLabelText('Terminal input') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Reconnect computer'));
    await vi.waitFor(() => expect(watchComputer).toHaveBeenCalledTimes(2));
  },
);

test('conversation chooser groups needs-you before working before recent', async () => {
  const { ConversationChoices } = await import('../src/WorkStatus');
  const client = {
    listInbox: async () => [{ conversationId: 'waiting', state: 'open', kind: 'approval' }],
    listTasks: async (id: string) => (id === 'working' ? [task] : []),
  } as unknown as CloudClient;
  const choose = vi.fn();
  render(
    <ConversationChoices
      client={client}
      conversations={['recent', 'working', 'waiting'].map((id, index) => ({
        conversationId: id,
        title: id,
        createdAt: index,
      }))}
      onChoose={choose}
    />,
  );
  await screen.findByRole('region', { name: 'Needs you' });
  expect(screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'))).toEqual([
    'Needs you',
    'Working',
    'Recent',
  ]);
  fireEvent.click(screen.getByText('waiting'));
  expect(choose).toHaveBeenCalledWith('waiting');
});

test('delivery refresh uses the original message even while task progress updates', async () => {
  vi.useFakeTimers();
  const sendTaskMessage = vi
    .fn()
    .mockImplementationOnce(async (_task, _text, id) => ({
      message: { messageId: id, state: 'pending' },
    }))
    .mockImplementation(async (_task, _text, id) => ({
      message: { messageId: id, state: 'delivered' },
    }));
  const props = {
    client: { sendTaskMessage } as unknown as CloudClient,
    tasks: [task],
    draft: 'Use this',
    setDraft: vi.fn(),
    act: run,
    busy: false,
  };
  const view = render(
    <SteerComposer {...props}>
      <form>
        <button type="submit">Send</button>
      </form>
    </SteerComposer>,
  );
  await act(async () => fireEvent.click(screen.getByText('Send')));
  for (let second = 0; second < 10; second++) {
    view.rerender(
      <SteerComposer {...props} tasks={[{ ...task, progress: [String(second)] }]}>
        <form>
          <button type="submit">Send</button>
        </form>
      </SteerComposer>,
    );
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
  }
  expect(sendTaskMessage).toHaveBeenCalledTimes(2);
  expect(sendTaskMessage.mock.calls[0]).toEqual(sendTaskMessage.mock.calls[1]);
  expect(screen.getByText('Read by the task', { exact: false })).toBeTruthy();
});

test('oversized steers keep the draft and do not call the API', () => {
  const sendTaskMessage = vi.fn();
  const clear = vi.fn();
  render(
    <SteerComposer
      client={{ sendTaskMessage } as unknown as CloudClient}
      tasks={[task]}
      draft={'a'.repeat(4001)}
      setDraft={clear}
      act={run}
      busy={false}
    >
      <form>
        <button type="submit">Send</button>
      </form>
    </SteerComposer>,
  );
  fireEvent.click(screen.getByText('Send'));
  expect(screen.getByRole('alert').textContent).toContain('4,000');
  expect(sendTaskMessage).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
});
