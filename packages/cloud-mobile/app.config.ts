import type { ExpoConfig } from 'expo/config';

/**
 * `MAKA_E2E=1` is set only by the CI jobs that run the Maestro flows against a stack on the same
 * machine: it lets the app talk to that stack over plain http (localhost on iOS, 10.0.2.2 on the
 * Android emulator). Store builds never set it, and the app itself refuses plain http to anything
 * but this machine. It also keeps secrets in memory only, because an unsigned simulator build has no
 * Keychain to write to; nothing is ever stored in the clear.
 */
const e2e = process.env.MAKA_E2E === '1';

const config: ExpoConfig = {
  name: 'Maka',
  slug: 'maka-cloud',
  version: '0.1.0',
  orientation: 'portrait',
  scheme: 'makacloud',
  userInterfaceStyle: 'automatic',
  ios: {
    // Provisional: the owner confirms the bundle id when the Apple Developer account exists.
    bundleIdentifier: 'cloud.maka.app',
    supportsTablet: false,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      ...(e2e ? { NSAppTransportSecurity: { NSAllowsLocalNetworking: true } } : {}),
    },
  },
  android: {
    // Provisional, like the bundle id.
    package: 'cloud.maka.app',
    predictiveBackGestureEnabled: true,
  },
  web: { bundler: 'metro', output: 'single' },
  plugins: [
    'expo-router',
    'expo-secure-store',
    ['expo-splash-screen', { backgroundColor: '#0b1730' }],
    ...(e2e
      ? [['expo-build-properties', { android: { usesCleartextTraffic: true } }] as [string, object]]
      : []),
  ],
  experiments: { typedRoutes: true },
  extra: { e2e },
};

export default config;
