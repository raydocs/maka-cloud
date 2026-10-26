import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

/**
 * The Keychain (iOS) and Keystore (Android). The session token lives here and nowhere else: never
 * in plain storage, a URL or a log. Where there is no secure store (the web preview used for
 * screenshots, and the unsigned CI builds) values are kept in memory only, so nothing is ever
 * written in the clear.
 */
const memory = new Map<string, string>();
let available: Promise<boolean> | undefined;
/** Set only by the CI builds that run the device flows (app.config.ts): they are unsigned, so have no Keychain. */
const memoryOnly = (Constants.expoConfig?.extra as { e2e?: boolean } | undefined)?.e2e === true;
const hasStore = () =>
  (available ??= memoryOnly
    ? Promise.resolve(false)
    : SecureStore.isAvailableAsync().catch(() => false));

export async function readSecure(key: string): Promise<string | null> {
  if (!(await hasStore())) return memory.get(key) || null;
  try {
    return (await SecureStore.getItemAsync(key)) || null;
  } catch {
    return null;
  }
}

export async function writeSecure(key: string, value: string): Promise<void> {
  if (!(await hasStore())) {
    memory.set(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

/** Writes only when the value can survive closing the app (used by the message outbox). */
export async function writeDurableSecure(key: string, value: string): Promise<void> {
  if (!(await hasStore())) throw new Error('Device storage is unavailable.');
  await writeSecure(key, value);
}

/**
 * Removes a value, or fails. A value that could not be deleted is overwritten with an empty one (which
 * reads back as absent); only if that fails too does this throw, so a caller never reports access as
 * removed while the secret is still on the device.
 */
export async function removeSecure(key: string): Promise<void> {
  memory.delete(key);
  if (!(await hasStore())) return;
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await SecureStore.deleteItemAsync(key);
      return;
    } catch (e) {
      failure = e;
    }
  }
  try {
    await SecureStore.setItemAsync(key, '', {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } catch {
    throw failure instanceof Error ? failure : new Error('The saved access could not be removed.');
  }
}
