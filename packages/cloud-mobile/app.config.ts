import type { ExpoConfig } from 'expo/config';

/**
 * `MAKA_E2E=1` is set only by the CI jobs that run the Maestro flows against a stack on the same
 * machine: it lets the app talk to that stack over plain http (localhost on iOS, 10.0.2.2 on the
 * Android emulator). Store builds never set it, and the app itself refuses plain http to anything
 * but this machine. It also keeps secrets in memory only, because an unsigned simulator build has no
 * Keychain to write to; nothing is ever stored in the clear.
 */
const e2e = process.env.MAKA_E2E === '1';

/**
 * The app's language is the one picked in Settings, else the phone's (Simplified Chinese,
 * Traditional Chinese, or English). `MAKA_LANG` (`zh-Hans`, `zh-Hant` or `en`) fixes the default for
 * a build; the device-test builds fix Simplified Chinese, so the Maestro flows always see the same
 * words.
 */
const language = process.env.MAKA_LANG ?? (e2e ? 'zh-Hans' : undefined);

/**
 * The owner's sign-in settings, read when the app is built. None is a secret (a client id is public),
 * and none is set in the repository: a build without them shows no Apple or Google button.
 *   MAKA_APPLE_SIGN_IN=1           Apple's sheet; the app needs the Sign in with Apple capability.
 *   MAKA_GOOGLE_IOS_CLIENT_ID      Google OAuth client id of type iOS (bundle id above).
 *   MAKA_GOOGLE_ANDROID_CLIENT_ID  Google OAuth client id of type Android (package name below).
 * The server must list the same Google ids in MAKA_CLOUD_GOOGLE_CLIENT_IDS, and the app's bundle id
 * in MAKA_CLOUD_APPLE_CLIENT_IDS.
 */
const apple = process.env.MAKA_APPLE_SIGN_IN === '1';
const googleIos = process.env.MAKA_GOOGLE_IOS_CLIENT_ID?.trim() || undefined;
const googleAndroid = process.env.MAKA_GOOGLE_ANDROID_CLIENT_ID?.trim() || undefined;
const BUNDLE_ID = 'cloud.maka.app';

const config: ExpoConfig = {
  name: 'Maka',
  slug: 'maka-cloud',
  version: '0.1.0',
  orientation: 'portrait',
  // Google brings the person back to the app on a scheme of its own: the iOS client id written
  // backwards, or the package name on Android.
  scheme: [
    'makacloud',
    ...(googleIos
      ? [`com.googleusercontent.apps.${googleIos.replace(/\.apps\.googleusercontent\.com$/u, '')}`]
      : []),
    ...(googleAndroid ? [BUNDLE_ID] : []),
  ],
  userInterfaceStyle: 'automatic',
  ios: {
    // Provisional: the owner confirms the bundle id when the Apple Developer account exists.
    bundleIdentifier: BUNDLE_ID,
    supportsTablet: false,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      // Chinese first, so the system's own words (the keyboard, menus) follow the app's language.
      CFBundleDevelopmentRegion: 'zh-Hans',
      CFBundleLocalizations: ['zh-Hans', 'zh-Hant', 'en'],
      ...(e2e ? { NSAppTransportSecurity: { NSAllowsLocalNetworking: true } } : {}),
    },
  },
  android: {
    // Provisional, like the bundle id.
    package: BUNDLE_ID,
    predictiveBackGestureEnabled: true,
  },
  web: { bundler: 'metro', output: 'single' },
  plugins: [
    'expo-router',
    'expo-secure-store',
    ...(apple ? ['expo-apple-authentication'] : []),
    ['expo-splash-screen', { backgroundColor: '#0b1730' }],
    ...(e2e
      ? [['expo-build-properties', { android: { usesCleartextTraffic: true } }] as [string, object]]
      : []),
  ],
  experiments: { typedRoutes: true },
  extra: {
    e2e,
    ...(language ? { language } : {}),
    signIn: { apple, google: { ios: googleIos, android: googleAndroid } },
  },
};

export default config;
