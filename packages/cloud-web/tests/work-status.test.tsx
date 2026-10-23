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
  steerable: true,
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
  [429, 'rate_limited', 'Too many open views. Wait a moment, then reconnect.'],
  [401, 'unauthorized', 'This invite was revoked. Sign in with a valid invite.'],
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
    if (status === 429) {
      expect((screen.getByText('Reconnect computer') as HTMLButtonElement).disabled).toBe(true);
    } else if (status === 401) {
      expect(screen.queryByText('Reconnect computer')).toBeNull();
    } else {
      fireEvent.click(screen.getByText('Reconnect computer'));
      await vi.waitFor(() => expect(watchComputer).toHaveBeenCalledTimes(2));
    }
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

function composerProps(sendTaskMessage = vi.fn()) {
  return {
    client: { sendTaskMessage } as unknown as CloudClient,
    tasks: [task],
    draft: 'Use this',
    setDraft: vi.fn(),
    act: run,
    busy: false,
    children: (
      <form onSubmit={(event) => event.preventDefault()}>
        <button type="submit">Send</button>
      </form>
    ),
  };
}

test('unsupported running tasks use the normal composer', () => {
  const props = composerProps();
  const normal = vi.fn((event) => event.preventDefault());
  render(
    <SteerComposer {...props} tasks={[{ ...task, steerable: false }]}>
      <form onSubmit={normal}>
        <button type="submit">Send</button>
      </form>
    </SteerComposer>,
  );
  fireEvent.click(screen.getByText('Send'));
  expect(normal).toHaveBeenCalledOnce();
  expect(props.client.sendTaskMessage).not.toHaveBeenCalled();
});

test('a draft never automatically changes its target as tasks change', () => {
  const props = composerProps();
  const normal = vi.fn((event) => event.preventDefault());
  const children = (
    <form onSubmit={normal}>
      <button type="submit">Send</button>
    </form>
  );
  const view = render(<SteerComposer {...props}>{children}</SteerComposer>);
  expect((screen.getByLabelText('To the running task') as HTMLSelectElement).value).toBe(
    task.taskId,
  );
  view.rerender(
    <SteerComposer {...props} tasks={[{ ...task, taskId: 'replacement' }]}>
      {children}
    </SteerComposer>,
  );
  expect((screen.getByLabelText('To the running task') as HTMLSelectElement).value).toBe('');
  fireEvent.click(screen.getByText('Send'));
  expect(normal).toHaveBeenCalledOnce();
});

test('unsupported steering keeps the draft and explains how to send normally', async () => {
  const { ApiError } = await import('@maka-cloud/client');
  const props = composerProps(vi.fn().mockRejectedValue(new ApiError(409, 'steer_unsupported')));
  render(<SteerComposer {...props} />);
  await act(async () => fireEvent.click(screen.getByText('Send')));
  expect(screen.getByRole('alert').textContent).toContain('Your draft is kept');
  expect(props.setDraft).not.toHaveBeenCalled();
  expect((screen.getByLabelText('To the running task') as HTMLSelectElement).value).toBe('');
});

test('receipts keep polling after task end, restore unread text and hide controls', async () => {
  vi.useFakeTimers();
  const send = vi
    .fn()
    .mockResolvedValueOnce({ message: { state: 'pending' } })
    .mockResolvedValue({ message: { state: 'unseen' } });
  const props = composerProps(send);
  const view = render(<SteerComposer {...props} />);
  await act(async () => fireEvent.click(screen.getByText('Send')));
  view.rerender(
    <SteerComposer {...props} draft="Another draft" tasks={[{ ...task, state: 'succeeded' }]} />,
  );
  expect(screen.queryByText('Check delivery')).toBeNull();
  expect(screen.queryByText('Take back')).toBeNull();
  await act(async () => vi.advanceTimersByTime(10000));
  expect(screen.getByText('Not read before the task ended', { exact: false })).toBeTruthy();
  expect(props.setDraft).toHaveBeenLastCalledWith('Another draft\n\nUse this');
});

test('sending during a background receipt check still sends the new message', async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  const send = vi
    .fn()
    .mockResolvedValueOnce({ message: { state: 'pending' } })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ message: { state: 'pending' } });
  const props = composerProps(send);
  const view = render(<SteerComposer {...props} />);
  await act(async () => fireEvent.click(screen.getByText('Send')));
  await act(async () => vi.advanceTimersByTime(10000));
  view.rerender(<SteerComposer {...props} draft="Second message" />);
  await act(async () => fireEvent.click(screen.getByText('Send')));
  expect(send).toHaveBeenCalledTimes(3);
  expect(send.mock.calls[2]?.[1]).toBe('Second message');
  await act(async () => finish({ message: { state: 'pending' } }));
});

test('take back after the agent reads updates the receipt to read', async () => {
  const { ApiError } = await import('@maka-cloud/client');
  const send = vi
    .fn()
    .mockResolvedValueOnce({ message: { state: 'pending' } })
    .mockResolvedValue({ message: { state: 'delivered' } });
  const props = composerProps(send);
  props.client.withdrawTaskMessage = vi.fn().mockRejectedValue(new ApiError(409, 'invalid_state'));
  render(<SteerComposer {...props} />);
  await act(async () => fireEvent.click(screen.getByText('Send')));
  await act(async () => fireEvent.click(screen.getByText('Take back')));
  expect(screen.getByText('Read by the task', { exact: false })).toBeTruthy();
  expect(screen.queryByText('Take back')).toBeNull();
});

test.each([
  ['computer_busy', 'A computer request is still in progress. Wait, then try again.'],
  ['computer_not_in_control', 'Your control has ended. You are watching the task.'],
])('computer control %s preserves the live view and explains what happened', async (code, copy) => {
  const { ApiError } = await import('@maka-cloud/client');
  const watchComputer = vi.fn(async (_id, frame) => {
    frame({ controller: 'human' });
  });
  const computerControl = vi.fn().mockRejectedValue(new ApiError(409, code));
  render(
    <Computer
      client={{ watchComputer, computerControl } as unknown as CloudClient}
      task={{ ...task, state: 'paused' }}
    />,
  );
  const details = screen.getByText('Open computer').closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  fireEvent.click(await screen.findByText('Hand back control'));
  await screen.findByText(copy);
  expect(screen.queryByText('Reconnect computer')).toBeNull();
  expect(
    screen.getByText(
      code === 'computer_busy' ? 'You have control · Task paused' : 'Watching · Task has control',
    ),
  ).toBeTruthy();
});

test('a send acknowledged after switching conversations keeps its receipt', async () => {
  let finish!: (value: unknown) => void;
  const send = vi.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const props = composerProps(send);
  const view = render(<SteerComposer {...props} conversationId="receipt-switch" />);
  fireEvent.click(screen.getByText('Send'));
  view.unmount();
  await act(async () => finish({ message: { state: 'pending' } }));
  render(<SteerComposer {...props} draft="" conversationId="receipt-switch" />);
  expect(screen.getByText('Waiting for the next step', { exact: false })).toBeTruthy();
  expect(screen.getByText('Use this')).toBeTruthy();
});

test('control throttling honors Retry-After and preserves the live human view', async () => {
  vi.useFakeTimers();
  const { ApiError } = await import('@maka-cloud/client');
  const computerInput = vi
    .fn()
    .mockRejectedValue(new ApiError(429, 'rate_limited', undefined, 20000));
  const watchComputer = vi.fn(async (_id, frame) => frame({ controller: 'human' }));
  render(
    <Computer
      client={{ watchComputer, computerInput } as unknown as CloudClient}
      task={{ ...task, state: 'paused' }}
    />,
  );
  const details = screen.getByText('Open computer').closest('details')!;
  details.open = true;
  await act(async () => fireEvent(details, new Event('toggle')));
  const input = screen.getByLabelText('Terminal input') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'pwd' } });
  await act(async () => fireEvent.click(screen.getByText('Send input')));
  expect(screen.getByText('Slow down. Try again in a moment.')).toBeTruthy();
  expect(screen.getByText('You have control · Task paused')).toBeTruthy();
  expect(input.disabled).toBe(false);
  await act(async () => fireEvent.click(screen.getByText('Send input')));
  expect(computerInput).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTime(20000));
  await act(async () => fireEvent.click(screen.getByText('Send input')));
  expect(computerInput).toHaveBeenCalledTimes(2);
});

test('stream throttling allows reconnect after Retry-After', async () => {
  vi.useFakeTimers();
  const { ApiError } = await import('@maka-cloud/client');
  const watchComputer = vi
    .fn()
    .mockRejectedValue(new ApiError(429, 'rate_limited', undefined, 20000));
  render(<Computer client={{ watchComputer } as unknown as CloudClient} task={task} />);
  const details = screen.getByText('Open computer').closest('details')!;
  details.open = true;
  await act(async () => fireEvent(details, new Event('toggle')));
  const reconnect = screen.getByText('Reconnect computer') as HTMLButtonElement;
  expect(reconnect.disabled).toBe(true);
  await act(async () => vi.advanceTimersByTime(19999));
  expect(reconnect.disabled).toBe(true);
  await act(async () => vi.advanceTimersByTime(1));
  expect(reconnect.disabled).toBe(false);
  await act(async () => fireEvent.click(reconnect));
  expect(watchComputer).toHaveBeenCalledTimes(2);
});

test('unsupported warning clears on the next send and automatic targeting returns after the draft clears', async () => {
  const { ApiError } = await import('@maka-cloud/client');
  const props = composerProps(vi.fn().mockRejectedValue(new ApiError(409, 'steer_unsupported')));
  const view = render(<SteerComposer {...props} />);
  await act(async () => fireEvent.click(screen.getByText('Send')));
  expect(screen.getByRole('alert')).toBeTruthy();
  fireEvent.click(screen.getByText('Send'));
  expect(screen.queryByRole('alert')).toBeNull();
  view.rerender(<SteerComposer {...props} draft="" tasks={[{ ...task, taskId: 'next' }]} />);
  expect((screen.getByLabelText('To the running task') as HTMLSelectElement).value).toBe('next');
});

test.each(['unseen', undefined])(
  'restoring %s after task end defaults to a new request',
  async (state) => {
    vi.useFakeTimers();
    const send =
      state === undefined
        ? vi.fn().mockRejectedValue(new Error('offline'))
        : vi
            .fn()
            .mockResolvedValueOnce({ message: { state: 'pending' } })
            .mockResolvedValue({ message: { state } });
    const props = composerProps(send);
    const view = render(<SteerComposer {...props} />);
    await act(async () => fireEvent.click(screen.getByText('Send')));
    view.rerender(
      <SteerComposer
        {...props}
        draft=""
        tasks={[
          { ...task, state: 'succeeded' },
          { ...task, taskId: 'next' },
        ]}
      />,
    );
    await act(async () => vi.advanceTimersByTime(10000));
    expect(props.setDraft).toHaveBeenLastCalledWith('Use this');
    view.rerender(
      <SteerComposer
        {...props}
        draft="Use this"
        tasks={[
          { ...task, state: 'succeeded' },
          { ...task, taskId: 'next' },
        ]}
      />,
    );
    expect((screen.getByLabelText('To the running task') as HTMLSelectElement).value).toBe('');
    if (state === undefined)
      expect(
        screen.getByText('Delivery not confirmed. Your message is back in the draft.', {
          exact: false,
        }),
      ).toBeTruthy();
  },
);

test.each([401, 404, 429, 503])(
  'receipt polling handles HTTP %s without repeating every tick',
  async (status) => {
    vi.useFakeTimers();
    const { ApiError } = await import('@maka-cloud/client');
    const send = vi
      .fn()
      .mockResolvedValueOnce({ message: { state: 'pending' } })
      .mockRejectedValue(new ApiError(status, 'error', undefined, 40000));
    const props = composerProps(send);
    render(<SteerComposer {...props} />);
    await act(async () => fireEvent.click(screen.getByText('Send')));
    await act(async () => vi.advanceTimersByTime(10000));
    expect(send).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(30000));
    expect(send).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(10000));
    expect(send).toHaveBeenCalledTimes(status === 401 || status === 404 ? 2 : 3);
  },
);

test('a restored draft stays a new request after leaving and reopening the conversation', async () => {
  const props = composerProps(vi.fn().mockResolvedValue({ message: { state: 'unseen' } }));
  const view = render(<SteerComposer {...props} conversationId="restored-target" />);
  await act(async () => fireEvent.click(screen.getByText('Send')));
  view.unmount();
  render(
    <SteerComposer
      {...props}
      conversationId="restored-target"
      tasks={[{ ...task, taskId: 'replacement' }]}
    />,
  );
  expect((screen.getByLabelText('To the running task') as HTMLSelectElement).value).toBe('');
});

test('clearing receipts on sign-out also blocks late acknowledgements from refilling the cache', async () => {
  const { clearSteerReceipts } = await import('../src/WorkStatus');
  let finish!: (value: unknown) => void;
  const props = composerProps(
    vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const view = render(<SteerComposer {...props} conversationId="sign-out" />);
  fireEvent.click(screen.getByText('Send'));
  view.unmount();
  clearSteerReceipts();
  await act(async () => finish({ message: { state: 'pending' } }));
  render(<SteerComposer {...props} conversationId="sign-out" draft="" />);
  expect(screen.queryByText('Waiting for the next step', { exact: false })).toBeNull();
});
