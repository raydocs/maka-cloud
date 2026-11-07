import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { NotificationsCard } from '@/components/Notifications';
import { LanguageProvider } from '@/lib/i18n';
import { usePushRouting } from '@/lib/pushRouting';
import { SessionProvider, useSession } from '@/lib/session';

const mockNavigate = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: mockNavigate }),
}));
// Builds made for the owner's EAS project carry its id; without one the app asks the phone nothing.
const mockExtra: { eas?: { projectId: string } } = { eas: { projectId: 'test-project' } };
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return { extra: mockExtra };
    },
  },
}));

const fetchMock = () => (globalThis as unknown as { __fetch: jest.Mock }).__fetch;
const secure = () => (globalThis as unknown as { __secure: Map<string, string> }).__secure;
type Notifications = Record<string, jest.Mock> & { DEFAULT_ACTION_IDENTIFIER: string };
const phone = () => (globalThis as unknown as { __notifications: Notifications }).__notifications;

const SERVER = 'https://maka.example.com';
const TOKEN = 'ExponentPushToken[test-phone-0001]';
const TAG = 'a'.repeat(32);

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** A server that keeps devices unless `devices` says otherwise; every request is recorded. */
function serve(
  devices: () => Response = () => Response.json({ accountTag: TAG }, { status: 201 }),
) {
  const calls: Call[] = [];
  fetchMock().mockImplementation(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    calls.push({
      method: init.method ?? 'GET',
      path,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    if (path === '/v1/conversations')
      return Response.json({
        conversations: [{ conversationId: 'c1', title: null, createdAt: 1 }],
      });
    if (path === '/v1/push/devices') {
      return init.method === 'DELETE' ? new Response(null, { status: 204 }) : devices();
    }
    if (path === '/v1/auth/sign-out') return new Response(null, { status: 204 });
    return new Response('{}', { status: 404 });
  });
  return calls;
}

let api: ReturnType<typeof useSession>;
function Signed({ children }: { children: React.ReactNode }) {
  api = useSession();
  return api.session.status === 'in' ? children : <Text>out</Text>;
}
/** The signed-in sections load the phone's choice (`usePushRouting`), as the tab layout does. */
function Sections({ place }: { place: 'home' | 'me' }) {
  usePushRouting();
  return <NotificationsCard place={place} />;
}

async function signIn(token = 'invite-token', place: 'home' | 'me' = 'home') {
  await render(
    <LanguageProvider language="en">
      <SessionProvider>
        <Signed>
          <Sections place={place} />
        </Signed>
      </SessionProvider>
    </LanguageProvider>,
  );
  await screen.findByText('out');
  await act(async () => {
    await api.signIn('maka.example.com', token);
  });
}

beforeEach(() => {
  mockNavigate.mockReset();
  mockExtra.eas = { projectId: 'test-project' };
  phone().useLastNotificationResponse.mockReturnValue(undefined);
  phone().requestPermissionsAsync.mockResolvedValue({ granted: true });
  phone().getPermissionsAsync.mockResolvedValue({ granted: false });
});

const registered = (calls: Call[]) =>
  calls.filter((call) => call.path === '/v1/push/devices' && call.method === 'POST');

test('after sign-in Home offers notifications and asks the phone nothing until the person says yes', async () => {
  const calls = serve();
  await signIn();
  await screen.findByText('Turn on notifications');
  expect(phone().requestPermissionsAsync).not.toHaveBeenCalled();
  expect(phone().getExpoPushTokenAsync).not.toHaveBeenCalled();
  expect(registered(calls)).toEqual([]);

  await act(async () => {
    fireEvent.press(screen.getByTestId('button-push-on'));
  });
  await waitFor(() => expect(registered(calls)).toHaveLength(1));
  expect(phone().requestPermissionsAsync).toHaveBeenCalledTimes(1);
  expect(phone().getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'test-project' });
  expect(registered(calls)[0]?.body).toEqual({ token: TOKEN, platform: 'ios' });
  expect(JSON.parse(secure().get('maka.push') as string)).toEqual({
    server: SERVER,
    state: 'on',
    token: TOKEN,
    accountTag: TAG,
  });
  // Said yes: Home stops asking.
  await waitFor(() => expect(screen.queryByText('Turn on notifications')).toBeNull());
});

test('the notification actions are Got it, Not now and Open; there is never an Approve', async () => {
  serve();
  await signIn();
  await act(async () => {
    fireEvent.press(await screen.findByTestId('button-push-on'));
  });
  await waitFor(() => expect(phone().setNotificationCategoryAsync).toHaveBeenCalledTimes(3));
  const categories = Object.fromEntries(
    phone().setNotificationCategoryAsync.mock.calls.map(
      ([id, actions]: [string, Array<{ identifier: string; buttonTitle: string }>]) => [
        id,
        actions.map((action) => action.buttonTitle),
      ],
    ),
  );
  expect(categories).toEqual({
    finished: ['Got it'],
    decision: ['Not now', 'Open'],
    approval: ['Not now', 'Open'],
  });
});

test('"Not now" asks the phone nothing, tells the server nothing, and Home stops asking', async () => {
  const calls = serve();
  await signIn();
  await act(async () => {
    fireEvent.press(await screen.findByTestId('button-push-not-now'));
  });
  await waitFor(() => expect(screen.queryByText('Turn on notifications')).toBeNull());
  expect(phone().requestPermissionsAsync).not.toHaveBeenCalled();
  expect(registered(calls)).toEqual([]);
  expect(JSON.parse(secure().get('maka.push') as string)).toEqual({
    server: SERVER,
    state: 'declined',
  });
});

test('a phone that says no, a server without phone push and a build without a project each say so and register nothing', async () => {
  phone().requestPermissionsAsync.mockResolvedValue({ granted: false });
  let calls = serve();
  await signIn('invite-token', 'me');
  await act(async () => {
    fireEvent.press(await screen.findByTestId('button-push-on'));
  });
  await screen.findByTestId('push-denied');
  expect(registered(calls)).toEqual([]);

  phone().requestPermissionsAsync.mockResolvedValue({ granted: true });
  calls = serve(() => new Response('{"error":"not_found"}', { status: 404 }));
  await act(async () => {
    fireEvent.press(screen.getByTestId('button-push-on'));
  });
  await screen.findByTestId('push-unavailable');
  expect(secure().has('maka.push')).toBe(false);

  mockExtra.eas = undefined;
  phone().getExpoPushTokenAsync.mockClear();
  calls = serve();
  await act(async () => {
    fireEvent.press(screen.getByTestId('button-push-on'));
  });
  await screen.findByTestId('push-unavailable');
  expect(phone().getExpoPushTokenAsync).not.toHaveBeenCalled();
  expect(registered(calls)).toEqual([]);
});

const signOutSends = (token: string, expected: Call) => async () => {
  phone().getPermissionsAsync.mockResolvedValue({ granted: true });
  secure().set(
    'maka.push',
    JSON.stringify({ server: SERVER, state: 'on', token: TOKEN, accountTag: TAG }),
  );
  const calls = serve();
  await signIn(token);
  await act(async () => {
    await api.signOut();
  });
  expect(calls).toContainEqual(expected);
  expect(secure().has('maka.push')).toBe(false);
};

test(
  'signing out with an invite token removes the phone token on its own',
  signOutSends('invite-token', {
    method: 'DELETE',
    path: '/v1/push/devices',
    body: { token: TOKEN },
  }),
);

test(
  'signing out a device session removes the phone token with the session',
  signOutSends('mks_device-session', {
    method: 'POST',
    path: '/v1/auth/sign-out',
    body: { pushEndpoint: TOKEN },
  }),
);

test('while notifications are on, each start gives the token to the server again without asking', async () => {
  secure().set(
    'maka.push',
    JSON.stringify({ server: SERVER, state: 'on', token: TOKEN, accountTag: TAG }),
  );
  phone().getPermissionsAsync.mockResolvedValue({ granted: true });
  const calls = serve();
  await signIn();
  await waitFor(() => expect(registered(calls)).toHaveLength(1));
  expect(phone().requestPermissionsAsync).not.toHaveBeenCalled();
});

const response = (data: Record<string, unknown>, actionIdentifier: string, id = 'n1') => ({
  actionIdentifier,
  notification: { request: { identifier: id, content: { data } } },
});

/** The app opens on a notification response, with notifications on for this account. */
async function openWith(data: Record<string, unknown>, action: string, id = 'n1') {
  phone().getPermissionsAsync.mockResolvedValue({ granted: true });
  secure().set(
    'maka.push',
    JSON.stringify({ server: SERVER, state: 'on', token: TOKEN, accountTag: TAG }),
  );
  const calls = serve();
  phone().useLastNotificationResponse.mockReturnValue(response(data, action, id));
  await signIn();
  return calls;
}

const finished = {
  type: 'task.finished',
  accountTag: TAG,
  conversationId: 'c1',
  taskId: 't9',
  state: 'succeeded',
};
const needed = {
  type: 'inbox.needed',
  accountTag: TAG,
  conversationId: 'c1',
  itemId: 'i7',
  kind: 'approval',
};

test('a tap on a result notification opens its task in its conversation', async () => {
  await openWith(finished, phone().DEFAULT_ACTION_IDENTIFIER);
  await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/chat?task=t9&conversation=c1'));
});

test('"Open" on a decision opens that decision on Home, where it is answered', async () => {
  await openWith(needed, 'open');
  await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/?decision=i7'));
});

test('"Not now" only puts the notification away: nothing opens and nothing is answered', async () => {
  const calls = await openWith(needed, 'not-now', 'n-later');
  await waitFor(() => expect(phone().dismissNotificationAsync).toHaveBeenCalledWith('n-later'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(mockNavigate).not.toHaveBeenCalled();
  expect(calls.some((call) => call.path.startsWith('/v1/inbox'))).toBe(false);
});

test('a notification for another account opens Home only', async () => {
  await openWith({ ...finished, accountTag: 'b'.repeat(32) }, phone().DEFAULT_ACTION_IDENTIFIER);
  await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/'));
  expect(mockNavigate).not.toHaveBeenCalledWith(expect.stringContaining('t9'));
});
