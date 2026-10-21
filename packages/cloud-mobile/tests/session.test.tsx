import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { SessionProvider, useSession } from '@/lib/session';

const fetchMock = () => (globalThis as unknown as { __fetch: jest.Mock }).__fetch;
const secure = () => (globalThis as unknown as { __secure: Map<string, string> }).__secure;

let api: ReturnType<typeof useSession>;
function Probe() {
  api = useSession();
  return <Text>{api.session.status}</Text>;
}

const conversations = (...ids: string[]) =>
  Response.json({
    conversations: ids.map((id, i) => ({ conversationId: id, title: null, createdAt: i })),
  });

test('signing in keeps the token in the secure store only, and signing out removes it', async () => {
  fetchMock().mockImplementation(async () => conversations('a', 'b'));
  await render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
  await screen.findByText('out');
  await act(async () => {
    await api.signIn('maka.example.com', ' invite-token ');
  });
  expect(api.session.status).toBe('in');
  if (api.session.status === 'in') {
    expect(api.session.chosen).toBe('b');
    expect(api.session.server).toBe('https://maka.example.com');
  }
  // Every request carried the token as a header, never in the address.
  const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
  expect(url).toBe('https://maka.example.com/v1/conversations');
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer invite-token');
  expect(secure().get('maka.token')).toBe('invite-token');

  await act(async () => {
    await api.signOut();
  });
  expect(api.session.status).toBe('out');
  expect(secure().has('maka.token')).toBe(false);
  // The server address is kept so the next sign-in only needs the token.
  expect(secure().get('maka.server')).toBe('https://maka.example.com');
});

test('a device that was signed in comes back signed in, and a refused invite is forgotten', async () => {
  secure().set('maka.server', 'https://maka.example.com');
  secure().set('maka.token', 'old-token');
  fetchMock().mockImplementation(async () => conversations());
  const { unmount } = await render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
  await screen.findByText('in');
  await unmount();

  fetchMock().mockImplementation(async () => new Response('{}', { status: 401 }));
  await render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
  await screen.findByText('out');
  expect(secure().has('maka.token')).toBe(false);
});

test('a wrong address never reaches the network', async () => {
  await render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
  await screen.findByText('out');
  await act(async () => {
    await expect(api.signIn('http://maka.example.com', 'token')).rejects.toThrow(/https/u);
  });
  expect(fetchMock()).not.toHaveBeenCalled();
  expect(secure().size).toBe(0);
});
