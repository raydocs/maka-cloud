import { keepLive } from '@/lib/live';

function fixture(initial: string) {
  const calls: string[] = [];
  let listener: (state: string) => void = () => {};
  const appState = {
    currentState: initial,
    addEventListener: (_: 'change', next: (state: string) => void) => {
      listener = next;
      return { remove: () => calls.push('unsubscribe') };
    },
  };
  const feed = { start: () => calls.push('start'), stop: () => calls.push('stop') };
  return { calls, appState, feed, change: (state: string) => listener(state) };
}

test('the stream runs only while the screen is in front and the app is in the foreground', () => {
  const { calls, appState, feed, change } = fixture('active');
  const leave = keepLive(feed, appState);
  expect(calls).toEqual(['start']);
  change('background');
  change('active');
  expect(calls).toEqual(['start', 'stop', 'start']);
  leave();
  // Leaving the screen stops the stream and drops the listener, so a later foreground does not reopen it.
  expect(calls).toEqual(['start', 'stop', 'start', 'unsubscribe', 'stop']);
});

test('a screen that gains focus while the app is in the background waits for the foreground', () => {
  const { calls, appState, feed, change } = fixture('background');
  keepLive(feed, appState);
  expect(calls).toEqual([]);
  change('active');
  expect(calls).toEqual(['start']);
});
