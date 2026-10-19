import { CloudClient } from './client';
import { routes, type PushRegistration } from './contract';

export async function enablePush(client: CloudClient): Promise<void> {
  if (
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window)
  ) {
    throw new Error('Background notifications are not supported in this browser.');
  }
  const config = await client.request<{ applicationServerKey: string }>(
    routes.pushConfig,
    {},
    'push',
  );
  const permission = await Notification.requestPermission();
  if (permission !== 'granted')
    throw new Error('Allow notifications in your browser settings to enable them.');
  await navigator.serviceWorker.register('/sw.js');
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const key = Uint8Array.from(
    atob(config.applicationServerKey.replace(/-/g, '+').replace(/_/g, '/')),
    (c) => c.charCodeAt(0),
  );
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    }));
  try {
    await client.request<void>(
      routes.pushSubscriptions,
      {
        method: 'POST',
        body: JSON.stringify(subscription.toJSON() as PushRegistration),
      },
      'push',
    );
  } catch (error) {
    if (!existing) await subscription.unsubscribe().catch(() => false);
    throw error;
  }
}
