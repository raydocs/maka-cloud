import { act, render, screen, waitFor } from '@testing-library/react-native';
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
  expect(JSON.parse(secure().get('maka.account') as string)).toEqual({
    server: 'https://maka.example.com',
    token: 'invite-token',
  });

  await act(async () => {
    await api.signOut();
  });
  expect(api.session.status).toBe('out');
  expect(secure().has('maka.account')).toBe(false);
  // The server address is kept so the next sign-in only needs the token.
  expect(secure().get('maka.server')).toBe('https://maka.example.com');
});

test('a device that was signed in comes back signed in, and a refused invite is forgotten', async () => {
  secure().set(
    'maka.account',
    JSON.stringify({ server: 'https://maka.example.com', token: 'old-token' }),
  );
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
  expect(secure().has('maka.account')).toBe(false);
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

const secureStore = jest.requireMock('expo-secure-store') as {
  setItemAsync: (key: string, value: string) => Promise<void>;
  deleteItemAsync: (key: string) => Promise<void>;
};

test('the server and token are saved as one record, and a failed save is a failed sign-in', async () => {
  fetchMock().mockImplementation(async () => conversations('a'));
  await render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
  await screen.findByText('out');
  const original = secureStore.setItemAsync;
  secureStore.setItemAsync = async () => {
    throw new Error('Keychain is locked');
  };
  try {
    await act(async () => {
      await expect(api.signIn('maka.example.com', 'tok')).rejects.toThrow(
        /could not save your sign-in/u,
      );
    });
  } finally {
    secureStore.setItemAsync = original;
  }
  // Nothing was published and nothing half-saved remains for the next launch to mix up.
  expect(api.session.status).toBe('out');
  expect(secure().has('maka.token')).toBe(false);
  expect(secure().has('maka.account')).toBe(false);
  await act(async () => {
    await api.signIn('maka.example.com', 'tok');
  });
  expect(JSON.parse(secure().get('maka.account') as string)).toEqual({
    server: 'https://maka.example.com',
    token: 'tok',
  });
});

test('a sign-out while a sign-in is still saving wins: the late write cannot bring the session back', async () => {
  fetchMock().mockImplementation(async () => conversations('a'));
  await render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
  await screen.findByText('out');
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = secureStore.setItemAsync;
  secureStore.setItemAsync = async (key, value) => {
    await gate;
    return original(key, value);
  };
  let signingIn: Promise<void> = Promise.resolve();
  let signingOut: Promise<void> = Promise.resolve();
  try {
    await act(async () => {
      signingIn = api.signIn('maka.example.com', 'tok');
      // The save has started and is held; the owner signs out now.
      await waitFor(() => expect(fetchMock()).toHaveBeenCalled());
      await Promise.resolve();
      signingOut = api.signOut();
      release();
      await signingIn;
      await signingOut;
    });
  } finally {
    secureStore.setItemAsync = original;
  }
  expect(api.session.status).toBe('out');
  expect(secure().has('maka.account')).toBe(false);
});

test('signing out fails loudly when the secret cannot be removed, and stays signed in', async () => {
  secure().set('maka.account', JSON.stringify({ server: 'https://maka.example.com', token: 't' }));
  fetchMock().mockImplementation(async () => conversations('a'));
  await render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
  await screen.findByText('in');
  const originalDelete = secureStore.deleteItemAsync;
  const originalSet = secureStore.setItemAsync;
  secureStore.deleteItemAsync = async () => {
    throw new Error('Keychain is locked');
  };
  secureStore.setItemAsync = async () => {
    throw new Error('Keychain is locked');
  };
  try {
    await act(async () => {
      await expect(api.signOut()).rejects.toThrow(/Keychain/u);
    });
  } finally {
    secureStore.deleteItemAsync = originalDelete;
    secureStore.setItemAsync = originalSet;
  }
  expect(api.session.status).toBe('in');
});

test('a secret that cannot be deleted is blanked, so signing out still removes access', async () => {
  secure().set('maka.account', JSON.stringify({ server: 'https://maka.example.com', token: 't' }));
  fetchMock().mockImplementation(async () => conversations('a'));
  await render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
  await screen.findByText('in');
  const originalDelete = secureStore.deleteItemAsync;
  secureStore.deleteItemAsync = async () => {
    throw new Error('Keychain is locked');
  };
  try {
    await act(async () => {
      await api.signOut();
    });
  } finally {
    secureStore.deleteItemAsync = originalDelete;
  }
  expect(api.session.status).toBe('out');
  expect(secure().get('maka.account')).toBe('');
});

test('a wrong token typed at the sign-in screen does not delete the account saved before', async () => {
  const saved = JSON.stringify({ server: 'https://maka.example.com', token: 'good' });
  secure().set('maka.account', saved);
  // The saved account cannot be reached at first (offline), so the sign-in screen is shown.
  fetchMock().mockImplementation(async () => {
    throw new Error('offline');
  });
  await render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
  await screen.findByText('out');
  expect(api.session.status === 'out' && api.session.saved).toBe(true);
  // A mistyped token is refused by the server.
  fetchMock().mockImplementation(async () => new Response('{}', { status: 401 }));
  await act(async () => {
    await expect(api.signIn('maka.example.com', 'typo')).rejects.toThrow();
  });
  expect(secure().get('maka.account')).toBe(saved);
  // Connection is back: the saved account signs in without anyone typing a token.
  fetchMock().mockImplementation(async () => conversations('a'));
  await act(async () => {
    api.retry();
  });
  await screen.findByText('in');
});

test('the token key of an earlier build is removed so no secret is left behind', async () => {
  secure().set('maka.token', 'old-secret');
  await render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
  await screen.findByText('out');
  await waitFor(() => expect(secure().has('maka.token')).toBe(false));
});
