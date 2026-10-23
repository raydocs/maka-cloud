import { ApiError, type CloudClient, type PushRegistration, routes } from '@maka-cloud/client';
import type { LanguageChoice } from './i18n';

// A client belongs to one signed-in session. Failed reads are retried; successful ones are reused.
const accounts = new WeakMap<CloudClient, Promise<{ accountTag?: string }>>();
function pushAccount(client: CloudClient): Promise<{ accountTag?: string }> {
  let account = accounts.get(client);
  if (!account) {
    account = client.request<{ accountTag?: string }>('/v1/me').catch((error) => {
      accounts.delete(client);
      throw error;
    });
    accounts.set(client, account);
  }
  return account;
}

export async function postPushContext(
  client: CloudClient | null,
  conversationId: string | null,
  current: () => boolean = () => true,
): Promise<void> {
  try {
    const account = client ? await pushAccount(client) : null;
    if (client && !account?.accountTag) return;
    const registration = await navigator.serviceWorker.getRegistration();
    if (current())
      registration?.active?.postMessage({
        type: 'maka.context',
        accountTag: account?.accountTag ?? null,
        conversationId,
      });
  } catch {
    // An offline tab must retain its last known context.
  }
}

function supported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function toKey(base64Url: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64Url.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
    c.charCodeAt(0),
  );
}

/**
 * Registers this browser with the server. The server only ever sends a generic
 * "task finished" message with ids; the worker ignores whatever it carries.
 */
export async function enablePush(
  client: CloudClient,
  language: LanguageChoice = 'system',
): Promise<void> {
  if (!supported()) throw new Error('Background notifications are not supported in this browser.');
  const { publicKey } = await client.request<{ publicKey: string }>(routes.pushKey, {}, 'push');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted')
    throw new Error('Allow notifications in your browser settings to enable them.');
  await navigator.serviceWorker.register('/sw.js');
  const registration = await navigator.serviceWorker.ready;
  registration.active?.postMessage({
    type: 'maka.language',
    language,
  });
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: toKey(publicKey),
    }));
  const { endpoint, keys } = subscription.toJSON();
  try {
    if (!endpoint || !keys?.p256dh || !keys.auth)
      throw new Error('This browser gave no notification keys.');
    const body: PushRegistration = { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
    const account = await pushAccount(client);
    await client.request<unknown>(
      routes.pushSubscriptions,
      { method: 'POST', body: JSON.stringify(body) },
      'push',
    );
    registration.active?.postMessage({ type: 'maka.subscription', accountTag: account.accountTag });
  } catch (error) {
    if (!existing) await subscription.unsubscribe().catch(() => false);
    throw error;
  }
}

/**
 * Removes this browser's registration, then the browser subscription. A server
 * that no longer knows the device (404) is the state we wanted. Any other
 * failure leaves the browser subscription in place, so a retry still works.
 */
export async function disablePush(client: CloudClient): Promise<void> {
  if (!supported()) return;
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  try {
    await client.request<unknown>(routes.pushSubscriptions, {
      method: 'DELETE',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
  }
  await subscription.unsubscribe().catch(() => false);
}
