import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError, type CloudClient, type ComputerFrame, type TaskView } from '@maka-cloud/client';
import { Computer } from '../src/Computer';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function setup(computerInput = vi.fn().mockResolvedValue({})) {
  let receive!: (frame: ComputerFrame) => void;
  let disconnect!: (error: Error) => void;
  const watchComputer = vi.fn((_id, frame) => {
    receive = frame;
    frame({ controller: 'human', desktop: { mime: 'image/png', base64: 'AAAA' } });
    return new Promise((_resolve, reject) => {
      disconnect = reject;
    });
  });
  const view = render(
    <Computer
      client={{ watchComputer, computerInput } as unknown as CloudClient}
      task={{ taskId: 'queue-task', state: 'paused' } as TaskView}
    />,
  );
  const details = screen.getByText('Open computer').closest('details')!;
  details.open = true;
  await act(async () => fireEvent(details, new Event('toggle')));
  const desktop = screen.getByRole('application');
  const key = (key: string) => fireEvent.keyDown(desktop, { key });
  return {
    ...view,
    desktop,
    key,
    receive: (controller: 'agent' | 'human') => receive({ controller }),
    disconnect,
    computerInput,
  };
}

function heldInput() {
  let finish!: () => void;
  const computerInput = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({});
  return { computerInput, finish: () => finish() };
}

test('a key during an in-flight click is sent after the reply, preserving input order', async () => {
  const held = heldInput();
  const { desktop, key, computerInput } = await setup(held.computerInput);
  fireEvent.click(desktop);
  key('ArrowDown');
  key('a');
  fireEvent.click(desktop);
  expect(computerInput).toHaveBeenCalledTimes(1);
  await act(async () => held.finish());
  expect(computerInput.mock.calls.map((call) => call[1].type)).toEqual([
    'pointer',
    'key',
    'key',
    'pointer',
  ]);
  expect(computerInput.mock.calls.slice(1, 3).map((call) => call[1].key)).toEqual([
    'ArrowDown',
    'a',
  ]);
});

test.each(['control end', 'stream drop', 'unmount'] as const)(
  'queue clears on %s even before an in-flight reply',
  async (end) => {
    const held = heldInput();
    const view = await setup(held.computerInput);
    fireEvent.click(view.desktop);
    view.key('ArrowDown');
    await act(async () => {
      if (end === 'control end') view.receive('agent');
      else if (end === 'stream drop') view.disconnect(new Error('offline'));
      else view.unmount();
    });
    await act(async () => held.finish());
    if (end === 'control end') await act(async () => view.receive('human'));
    expect(view.computerInput).toHaveBeenCalledTimes(1);
  },
);

test('429 retries the head input and keeps later inputs ordered until Retry-After ends', async () => {
  vi.useFakeTimers();
  const computerInput = vi
    .fn()
    .mockRejectedValueOnce(new ApiError(429, 'rate_limited', undefined, 20000))
    .mockResolvedValue({});
  const { key } = await setup(computerInput);
  await act(async () => key('a'));
  key('b');
  await act(async () => vi.advanceTimersByTimeAsync(19999));
  expect(computerInput).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(computerInput.mock.calls.map((call) => call[1].key)).toEqual(['a', 'a', 'b']);
});

test('queue overflow shows a brief warning and retains all accepted keys', async () => {
  vi.useFakeTimers();
  const held = heldInput();
  const { desktop, key, computerInput } = await setup(held.computerInput);
  fireEvent.click(desktop);
  for (let i = 0; i < 51; i++) key(String(i));
  expect(screen.getByRole('alert').textContent).toBe('Slow down. Try again in a moment.');
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => held.finish());
  expect(computerInput.mock.calls.slice(1).map((call) => call[1].key)).toEqual(
    Array.from({ length: 50 }, (_, i) => String(i)),
  );
});

test('terminal submission is guarded until acknowledged and keeps its draft on failure', async () => {
  const held = heldInput();
  held.computerInput.mockRejectedValueOnce(new Error('offline'));
  await setup(held.computerInput);
  const field = screen.getByLabelText('Terminal input');
  fireEvent.change(field, { target: { value: 'pwd' } });
  const form = field.closest('form')!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(held.computerInput).toHaveBeenCalledTimes(1);
  expect((field as HTMLInputElement).value).toBe('pwd');
  await act(async () => held.finish());
  expect(held.computerInput).toHaveBeenCalledTimes(1);
  expect((field as HTMLInputElement).value).toBe('');
  await act(async () => {
    fireEvent.change(field, { target: { value: 'ls' } });
    fireEvent.submit(form);
  });
  expect((field as HTMLInputElement).value).toBe('ls');
});
