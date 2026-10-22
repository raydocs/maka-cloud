import * as SecureStore from 'expo-secure-store';

/**
 * The Keychain (iOS) and Keystore (Android). The session token lives here and nowhere else: never
 * in plain storage, a URL or a log. Where there is no secure store (the web preview used for
 * screenshots) values are kept in memory only, so nothing is ever written in the clear.
 */
const memory = new Map<string, string>();
let available: Promise<boolean> | undefined;
const hasStore = () => (available ??= SecureStore.isAvailableAsync().catch(() => false));

export async function readSecure(key: string): Promise<string | null> {
  if (!(await hasStore())) return memory.get(key) ?? null;
  try {
    return await SecureStore.getItemAsync(key);
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

export async function removeSecure(key: string): Promise<void> {
  memory.delete(key);
  if (!(await hasStore())) return;
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    // Then the value is gone from this session at least; a later sign-in overwrites it.
  }
}
