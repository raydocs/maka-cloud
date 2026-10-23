import { afterEach, expect, test, vi } from 'vitest';
import { CloudClient } from '@maka-cloud/client';
import { enablePush, postPushContext, restorePush } from '../src/push';

afterEach(() => vi.unstubAllGlobals());

function browser() {
  const postMessage = vi.fn();
  const subscription = {
    toJSON: () => ({ endpoint: 'https://push.example/one', keys: { p256dh: 'key', auth: 'auth' } }),
    unsubscribe: vi.fn(async () => true),
  };
  const registration = {
    active: { postMessage },
    pushManager: { getSubscription: async () => subscription },
  };
  vi.stubGlobal('navigator', {
    serviceWorker: {
      getRegistration: async () => registration,
      register: async () => registration,
      ready: Promise.resolve(registration),
    },
  });
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', { requestPermission: async () => 'granted' });
  return { postMessage, registration, subscription };
}

test('failed account reads post nothing; success is reused until the session changes', async () => {
  const { postMessage } = browser();
  let offline = true;
  const fetcher = vi.fn(async () => {
    if (offline) throw new TypeError('offline');
    return Response.json({ accountTag: 'account-a' });
  });
  const client = new CloudClient('token-a', fetcher);
  await postPushContext(client, 'chat');
  expect(postMessage).not.toHaveBeenCalled();
  offline = false;
  await postPushContext(client, 'chat');
  await postPushContext(client, null);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(postMessage).toHaveBeenLastCalledWith({
    type: 'maka.context',
    accountTag: 'account-a',
    conversationId: null,
  });
  await postPushContext(null, null);
  expect(postMessage).toHaveBeenLastCalledWith({
    type: 'maka.context',
    accountTag: null,
    conversationId: null,
  });
  const other = new CloudClient('token-b', async () => Response.json({ accountTag: 'account-b' }));
  await postPushContext(other, 'other-chat');
  expect(postMessage).toHaveBeenLastCalledWith({
    type: 'maka.context',
    accountTag: 'account-b',
    conversationId: 'other-chat',
  });
});

test('only successful push registrations publish the subscription owner', async () => {
  const { postMessage } = browser();
  let fail = false;
  const client = new CloudClient('token', async (input, init) => {
    if (String(input) === '/v1/me') return Response.json({ accountTag: 'account-a' });
    if (init?.method === 'POST')
      return Response.json({ accountTag: 'account-a' }, { status: fail ? 500 : 201 });
    return Response.json({ publicKey: 'a2V5' });
  });
  await enablePush(client);
  expect(postMessage).toHaveBeenCalledWith({ type: 'maka.subscription', accountTag: 'account-a' });
  postMessage.mockClear();
  fail = true;
  await expect(enablePush(client)).rejects.toThrow();
  expect(postMessage.mock.calls.some(([message]) => message.type === 'maka.subscription')).toBe(
    false,
  );
});

test('app-load recovery re-registers the same subscription and uses the returned current tag', async () => {
  const { postMessage, subscription } = browser();
  const permission = vi.spyOn(Notification, 'requestPermission');
  const fetcher = vi.fn(async () => Response.json({ accountTag: 'restored-account-tag' }));
  const client = new CloudClient('token', fetcher);
  for (let i = 0; i < 2; i++) await restorePush(client);
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const [path, init] of fetcher.mock.calls as unknown as Array<[string, RequestInit]>) {
    expect(path).toBe('/v1/push/subscriptions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(subscription.toJSON());
  }
  expect(postMessage).toHaveBeenLastCalledWith({
    type: 'maka.subscription',
    accountTag: 'restored-account-tag',
  });
  expect(permission).not.toHaveBeenCalled();
  expect(subscription.unsubscribe).not.toHaveBeenCalled();
});

test('recovery does nothing without a subscription and never publishes failed or stale ownership', async () => {
  const { postMessage, registration, subscription } = browser();
  const get = vi.spyOn(registration.pushManager, 'getSubscription');
  get.mockResolvedValueOnce(null as unknown as typeof subscription);
  const fetcher = vi.fn(async () => Response.json({}, { status: 500 }));
  const client = new CloudClient('token', fetcher);
  await restorePush(client);
  expect(fetcher).not.toHaveBeenCalled();
  await expect(restorePush(client)).rejects.toThrow();
  expect(postMessage).not.toHaveBeenCalled();
  expect(subscription.unsubscribe).not.toHaveBeenCalled();
  let current = true;
  const other = new CloudClient('other', async () => {
    current = false;
    return Response.json({ accountTag: 'other-account' });
  });
  await restorePush(other, () => current);
  expect(postMessage).not.toHaveBeenCalled();
});
