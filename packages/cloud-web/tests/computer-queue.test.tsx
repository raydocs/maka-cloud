import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError, type CloudClient, type ComputerFrame, type TaskView } from '@maka-cloud/client';
import { Computer } from '../src/Computer';
import { type Language, LanguageProvider, translator } from '../src/i18n';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function setup(
  computerInput = vi.fn().mockResolvedValue({}),
  computerControl = vi.fn().mockResolvedValue({ controller: 'agent' }),
  language: Language = 'en',
) {
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
    <LanguageProvider language={language}>
      <Computer
        client={{ watchComputer, computerInput, computerControl } as unknown as CloudClient}
        task={{ taskId: 'queue-task', state: 'paused' } as TaskView}
      />
    </LanguageProvider>,
  );
  const details = screen.getByText(translator(language).t('Open computer')).closest('details')!;
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
    computerControl,
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
  expect(screen.getByText('Terminal input queued. Waiting for confirmation…')).toBeTruthy();
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

test.each([
  [new Error('offline'), 'The action was not confirmed.'],
  [
    new DOMException('timed out', 'TimeoutError'),
    'Not sure the last input arrived; check the screen.',
  ],
])(
  'an uncertain input failure stops the queue and keeps its error visible: %s',
  async (failure, message) => {
    let reject!: (error: Error) => void;
    const computerInput = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const { desktop, key } = await setup(computerInput);
    fireEvent.click(desktop);
    key('a');
    key('b');
    await act(async () => reject(failure));
    expect(computerInput).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').textContent).toContain(message);
    expect(screen.getByRole('alert').textContent).toContain('2 queued inputs were not sent.');
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toContain(message);
  },
);

test('hand back clears queued keys and is the next request after the in-flight input', async () => {
  const held = heldInput();
  const { desktop, key, computerControl } = await setup(held.computerInput);
  fireEvent.click(desktop);
  key('a');
  key('b');
  const handback = screen.getByRole('button', { name: 'Hand back control' });
  expect((handback as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(handback);
  expect(computerControl).not.toHaveBeenCalled();
  await act(async () => held.finish());
  expect(held.computerInput).toHaveBeenCalledTimes(1);
  expect(computerControl).toHaveBeenCalledExactlyOnceWith('queue-task', 'handback');
});

test('input throttling does not delay hand back and overflow shows only one slow down alert', async () => {
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const computerInput = vi.fn(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  const { key, computerControl } = await setup(computerInput);
  key('a');
  for (let i = 0; i < 51; i++) key('b');
  await act(async () => reject(new ApiError(429, 'rate_limited', undefined, 20000)));
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Hand back control' })));
  expect(computerControl).toHaveBeenCalledExactlyOnceWith('queue-task', 'handback');
  await act(async () => vi.advanceTimersByTimeAsync(20000));
  expect(computerInput).toHaveBeenCalledTimes(1);
});

test.each(['en', 'zh-Hans', 'zh-Hant'] as const)(
  'input failure omits an empty queue and uses singular copy for one unsent input in %s',
  async (language) => {
    const { t, shared } = translator(language);
    for (const count of [0, 1]) {
      let reject!: (error: Error) => void;
      const computerInput = vi.fn(
        () =>
          new Promise<void>((_resolve, fail) => {
            reject = fail;
          }),
      );
      const { key, unmount } = await setup(computerInput, undefined, language);
      key('a');
      if (count) key('b');
      await act(async () => reject(new Error('offline')));
      expect(screen.getByRole('alert').textContent).toBe(
        shared('The action was not confirmed. Check the connection and try again.') +
          (count ? ` ${t('{count} queued input was not sent.', { count })}` : ''),
      );
      unmount();
    }
  },
);

test.each(['en', 'zh-Hans', 'zh-Hant'] as const)(
  'hand back stays pending and ignores duplicate clicks while queued and in flight in %s',
  async (language) => {
    const held = heldInput();
    let finish!: (result: { controller: string }) => void;
    const computerControl = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { key } = await setup(held.computerInput, computerControl, language);
    const { t } = translator(language);
    key('a');
    const button = screen.getByRole('button', { name: t('Hand back control') });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: t('Handing back…') })).toBe(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(computerControl).not.toHaveBeenCalled();
    await act(async () => held.finish());
    fireEvent.click(button);
    key('b');
    expect(computerControl).toHaveBeenCalledExactlyOnceWith('queue-task', 'handback');
    expect(screen.getByRole('button', { name: t('Handing back…') })).toBe(button);
    expect(held.computerInput).toHaveBeenCalledTimes(1);
    await act(async () => finish({ controller: 'agent' }));
    expect(computerControl).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: t('Handing back…') })).toBeNull();
  },
);

test('hand back shows pending feedback while waiting for a control 429 cooldown', async () => {
  vi.useFakeTimers();
  const computerControl = vi
    .fn()
    .mockRejectedValueOnce(new ApiError(429, 'rate_limited', undefined, 20000))
    .mockResolvedValue({ controller: 'agent' });
  await setup(undefined, computerControl);
  const button = screen.getByRole('button', { name: 'Hand back control' });
  await act(async () => fireEvent.click(button));
  expect(computerControl).toHaveBeenCalledTimes(1);
  expect((button as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(button);
  fireEvent.click(button);
  expect(screen.getByRole('button', { name: 'Handing back…' })).toBe(button);
  expect((button as HTMLButtonElement).disabled).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(19999));
  expect(computerControl).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(computerControl).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('button', { name: 'Handing back…' })).toBeNull();
});
