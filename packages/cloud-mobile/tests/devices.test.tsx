import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { CloudClient } from '@maka-cloud/client';
import { Devices } from '@/components/Devices';
import { DARK, ThemeContext } from '@/lib/theme';

const NOW = 10 * 3_600_000;

function clientWith(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetcher = (async (url, init) => {
    const key = `${init?.method ?? 'GET'} ${String(url)}`;
    calls.push(key);
    return routes[key]?.() ?? new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { client: new CloudClient('mks_a.b', { fetcher }), calls };
}

const show = (client: CloudClient) =>
  render(
    <ThemeContext.Provider value={DARK}>
      <Devices client={client} now={() => NOW} />
    </ThemeContext.Provider>,
  );

const LIST = {
  sessions: [
    {
      sessionId: 's1',
      deviceLabel: 'iPhone app',
      createdAt: 0,
      lastSeenAt: NOW - 30_000,
      current: true,
    },
    {
      sessionId: 's2',
      deviceLabel: 'Android app',
      createdAt: 0,
      lastSeenAt: NOW - 3 * 3_600_000,
      current: false,
    },
  ],
  identities: [
    { provider: 'google', email: 'ada@example.com' },
    { provider: 'email', email: 'ada@example.com' },
  ],
};

test('the devices are listed, this one marked, and another can be signed out', async () => {
  let list = LIST;
  const { client, calls } = clientWith({
    'GET /v1/auth/sessions': () => Response.json(list),
    'DELETE /v1/auth/sessions/s2': () => {
      list = { ...LIST, sessions: LIST.sessions.slice(0, 1) };
      return new Response(null, { status: 204 });
    },
  });
  await show(client);
  await screen.findByText('iPhone app · this device');
  expect(screen.getByText('Active now')).toBeTruthy();
  expect(screen.getByText('Active 3 hours ago')).toBeTruthy();
  expect(screen.getByText('You sign in with Google and email ada@example.com.')).toBeTruthy();
  expect(screen.queryByTestId('button-Sign out iPhone app')).toBeNull();
  await fireEvent.press(screen.getByTestId('button-Sign out Android app'));
  await waitFor(() => expect(screen.queryByText('Android app')).toBeNull());
  expect(calls).toEqual([
    'GET /v1/auth/sessions',
    'DELETE /v1/auth/sessions/s2',
    'GET /v1/auth/sessions',
  ]);
});

test('an invite token has no devices, and a server without sign-in has no list: nothing is shown', async () => {
  const none = clientWith({
    'GET /v1/auth/sessions': () => Response.json({ sessions: [], identities: [] }),
  });
  const a = await show(none.client);
  await waitFor(() => expect(none.calls).toHaveLength(1));
  expect(screen.queryByText('Signed-in devices')).toBeNull();
  await a.unmount();
  const missing = clientWith({});
  await show(missing.client);
  await waitFor(() => expect(missing.calls).toHaveLength(1));
  expect(screen.queryByText('Signed-in devices')).toBeNull();
});

test('a failed sign-out of a device says so and keeps the list', async () => {
  const { client } = clientWith({
    'GET /v1/auth/sessions': () => Response.json(LIST),
    'DELETE /v1/auth/sessions/s2': () => Response.json({ error: 'x' }, { status: 500 }),
  });
  await show(client);
  await fireEvent.press(await screen.findByTestId('button-Sign out Android app'));
  await screen.findByText('Could not complete the request (500). Try again.');
  expect(screen.getByText('Android app')).toBeTruthy();
});
