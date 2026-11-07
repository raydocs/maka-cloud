import { screen, waitFor } from '@testing-library/react-native';
import { openChat, running } from './harness';

/** What the link or the notification put in the address: `/chat?task=…&conversation=…`. */
let mockParams: Record<string, string | undefined> = {};
const mockSetParams = jest.fn();
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useLocalSearchParams: () => mockParams,
    useRouter: () => ({
      navigate: () => {},
      push: () => {},
      dismissTo: () => {},
      back: () => {},
      setParams: mockSetParams,
    }),
    useFocusEffect: (effect: () => () => void) => useEffect(effect, [effect]),
  };
});
jest.mock('@/lib/live', () => ({
  keepLive: (feed: { start(): void; stop(): void }) => {
    feed.start();
    return () => feed.stop();
  },
}));

beforeEach(() => {
  mockParams = {};
  mockSetParams.mockReset();
});

const pill = () => screen.findByRole('button', { name: 'Task: Fix the login loop, In progress' });

test('without a link the task stays folded', async () => {
  await openChat(running());
  expect((await pill()).props.accessibilityState.expanded).toBe(false);
});

test('a task link finds the task’s conversation from the server and opens the task there', async () => {
  mockParams = { task: 't1' };
  const { calls, chosen } = await openChat(running(), (call) =>
    call.path === '/v1/tasks/t1/conversation'
      ? Response.json({ conversationId: 'c1', task: { taskId: 't1' } })
      : undefined,
  );
  await waitFor(async () => expect((await pill()).props.accessibilityState.expanded).toBe(true));
  expect(calls.some((call) => call.path === '/v1/tasks/t1/conversation')).toBe(true);
  expect(chosen()).toBe('c1');
  // Done once: the link leaves the address, so coming back does not open it again.
  expect(mockSetParams).toHaveBeenCalledWith({ task: undefined, conversation: undefined });
});

test('a conversation the server does not list for this account is not opened', async () => {
  mockParams = { task: 't1', conversation: 'someone-elses' };
  const { chosen } = await openChat(running());
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(chosen()).toBe('c1');
  expect((await pill()).props.accessibilityState.expanded).toBe(false);
});
