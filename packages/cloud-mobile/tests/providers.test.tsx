import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SignInCancelled } from '@maka-cloud/client';
import { Text } from 'react-native';
import SignIn from '@/app/sign-in';
import { authPlatform, googleRedirectUri, nativeProviders } from '@/lib/providers';
import { SessionProvider, useSession } from '@/lib/session';

// What the build was given. It lives on globalThis because the mock factory runs on first import.
const setConfig = (config: Record<string, unknown>) => {
  (globalThis as { __expoConfig?: Record<string, unknown> }).__expoConfig = config;
};
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return (globalThis as { __expoConfig?: Record<string, unknown> }).__expoConfig ?? {};
    },
  },
}));

const mockApple = {
  isAvailableAsync: jest.fn(),
  signInAsync: jest.fn(),
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
};
jest.mock('expo-apple-authentication', () => mockApple);

const mockPrompt = jest.fn();
const mockExchange = jest.fn();
const mockRequests: Array<Record<string, unknown>> = [];
jest.mock('expo-auth-session', () => ({
  ResponseType: { Code: 'code' },
  AuthRequest: class {
    codeVerifier = 'verifier-1';
    constructor(config: Record<string, unknown>) {
      mockRequests.push(config);
    }
    promptAsync = mockPrompt;
  },
  exchangeCodeAsync: (...args: unknown[]) => mockExchange(...args),
}));

const fetchMock = () => (globalThis as unknown as { __fetch: jest.Mock }).__fetch;
const secure = () => (globalThis as unknown as { __secure: Map<string, string> }).__secure;

const GOOGLE_IOS = '1234-abcd.apps.googleusercontent.com';
const build = (signIn: Record<string, unknown>) => {
  setConfig({ android: { package: 'cloud.maka.app' }, extra: { signIn } });
};

beforeEach(() => {
  setConfig({});
  mockRequests.length = 0;
  for (const mock of [mockApple.isAvailableAsync, mockApple.signInAsync, mockPrompt, mockExchange])
    mock.mockReset();
});

test('a build with no sign-in settings has no Apple or Google button, and one with them has', () => {
  expect(nativeProviders()).toEqual({ apple: false, google: false });
  build({ apple: true, google: {} });
  expect(nativeProviders()).toEqual({ apple: true, google: false });
  build({ apple: false, google: { ios: GOOGLE_IOS } });
  expect(nativeProviders()).toEqual({ apple: false, google: true });
  // An Android client id is of no use on this platform (the tests run as iOS).
  build({ google: { android: 'android-id' } });
  expect(nativeProviders().google).toBe(false);
});

test('Apple: the server’s nonce goes to the sheet unchanged, and the identity token comes back', async () => {
  mockApple.isAvailableAsync.mockResolvedValue(true);
  mockApple.signInAsync.mockResolvedValue({ identityToken: 'apple.id.token' });
  expect(await authPlatform.credential('apple', 'server-nonce')).toBe('apple.id.token');
  expect(mockApple.signInAsync).toHaveBeenCalledWith({
    requestedScopes: [mockApple.AppleAuthenticationScope.EMAIL],
    nonce: 'server-nonce',
  });
});

test('Apple: closing the sheet is a cancel; no token or no sheet is an error', async () => {
  mockApple.isAvailableAsync.mockResolvedValue(true);
  mockApple.signInAsync.mockRejectedValue(
    Object.assign(new Error('canceled'), { code: 'ERR_REQUEST_CANCELED' }),
  );
  await expect(authPlatform.credential('apple', 'n')).rejects.toBeInstanceOf(SignInCancelled);
  mockApple.signInAsync.mockResolvedValue({ identityToken: null });
  await expect(authPlatform.credential('apple', 'n')).rejects.toThrow('did not send');
  mockApple.isAvailableAsync.mockResolvedValue(false);
  await expect(authPlatform.credential('apple', 'n')).rejects.toThrow('not available');
});

test('Google: the code is asked for with PKCE and the nonce, then exchanged for the identity token', async () => {
  build({ google: { ios: GOOGLE_IOS } });
  mockPrompt.mockResolvedValue({ type: 'success', params: { code: 'auth-code' } });
  mockExchange.mockResolvedValue({ idToken: 'google.id.token' });
  expect(await authPlatform.credential('google', 'server-nonce')).toBe('google.id.token');
  expect(mockRequests[0]).toMatchObject({
    clientId: GOOGLE_IOS,
    redirectUri: 'com.googleusercontent.apps.1234-abcd:/oauthredirect',
    scopes: ['openid', 'email', 'profile'],
    usePKCE: true,
    extraParams: { nonce: 'server-nonce' },
  });
  expect(mockExchange).toHaveBeenCalledWith(
    {
      clientId: GOOGLE_IOS,
      code: 'auth-code',
      redirectUri: 'com.googleusercontent.apps.1234-abcd:/oauthredirect',
      extraParams: { code_verifier: 'verifier-1' },
    },
    expect.objectContaining({ tokenEndpoint: 'https://oauth2.googleapis.com/token' }),
  );
});

test('Google: closing the browser is a cancel; an error or a missing token is an error', async () => {
  build({ google: { ios: GOOGLE_IOS } });
  for (const type of ['cancel', 'dismiss']) {
    mockPrompt.mockResolvedValue({ type });
    await expect(authPlatform.credential('google', 'n')).rejects.toBeInstanceOf(SignInCancelled);
  }
  mockPrompt.mockResolvedValue({ type: 'error', params: {} });
  await expect(authPlatform.credential('google', 'n')).rejects.toThrow('did not send');
  mockPrompt.mockResolvedValue({ type: 'success', params: { code: 'c' } });
  mockExchange.mockResolvedValue({});
  await expect(authPlatform.credential('google', 'n')).rejects.toThrow('did not send');
  expect(mockExchange).toHaveBeenCalledTimes(1);
  build({});
  await expect(authPlatform.credential('google', 'n')).rejects.toThrow('not built');
});

test('where Google sends the person back: the client id backwards on iOS, the package on Android', () => {
  expect(googleRedirectUri('1234-abcd.apps.googleusercontent.com', 'ios', 'cloud.maka.app')).toBe(
    'com.googleusercontent.apps.1234-abcd:/oauthredirect',
  );
  expect(googleRedirectUri('x.apps.googleusercontent.com', 'android', 'cloud.maka.app')).toBe(
    'cloud.maka.app:/oauthredirect',
  );
});

let api: ReturnType<typeof useSession>;
function Probe() {
  api = useSession();
  return <Text testID="status">{api.session.status}</Text>;
}

test('on the sign-in screen the Apple button runs the whole sign-in and keeps only the session token', async () => {
  build({ apple: true, google: { ios: GOOGLE_IOS } });
  mockApple.isAvailableAsync.mockResolvedValue(true);
  mockApple.signInAsync.mockResolvedValue({ identityToken: 'apple.id.token' });
  const sent: Array<{ path: string; body: Record<string, unknown> | undefined }> = [];
  fetchMock().mockImplementation(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    sent.push({ path, body });
    const route = `${init.method ?? 'GET'} ${path}`;
    if (route === 'GET /v1/auth/options')
      return Response.json({ apple: true, google: true, email: true });
    if (route === 'POST /v1/auth/nonce') return Response.json({ nonce: 'server-nonce' });
    if (route === 'POST /v1/auth/session')
      return Response.json({ status: 'signed_in', token: 'mks_apple.tok', sessionId: 's' });
    if (route === 'GET /v1/conversations') return Response.json({ conversations: [] });
    return new Response('{}', { status: 404 });
  });
  await act(async () => {
    render(
      <SessionProvider>
        <Probe />
        <SignIn />
      </SessionProvider>,
    );
  });
  await screen.findByText('out');
  await fireEvent.changeText(screen.getByTestId('field-Server address'), 'maka.example.com');
  await fireEvent.press(screen.getByTestId('button-Continue'));
  await screen.findByTestId('button-Continue with Apple');
  expect(screen.getByTestId('button-Continue with Google')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('button-Continue with Apple'));
  await waitFor(() => expect(screen.getByTestId('status').props.children).toBe('in'));
  expect(sent.find((c) => c.path === '/v1/auth/session')?.body).toEqual({
    provider: 'apple',
    idToken: 'apple.id.token',
    nonce: 'server-nonce',
    device: 'iPhone app',
  });
  expect(JSON.parse(secure().get('maka.account') as string)).toEqual({
    server: 'https://maka.example.com',
    token: 'mks_apple.tok',
  });
  expect(JSON.stringify([...secure().values()])).not.toContain('apple.id.token');
});
