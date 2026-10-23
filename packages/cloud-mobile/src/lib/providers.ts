import type { AuthPlatform, Provider } from '@maka-cloud/client';
import { Platform } from 'react-native';

/**
 * Which of Apple's and Google's own sheets this build carries. A way the server offers but the build
 * lacks is not shown. They arrive with their native modules (and the owner's client ids, which are
 * build settings); until then the app signs in with an emailed code or an invite token.
 */
export const nativeProviders: Record<Provider, boolean> = { apple: false, google: false };

export const authPlatform: AuthPlatform = {
  deviceLabel: Platform.OS === 'ios' ? 'iPhone app' : 'Android app',
  async credential(provider) {
    throw new Error(`${provider} sign-in is not built into this app.`);
  },
};
