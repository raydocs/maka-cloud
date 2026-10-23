import { type AuthPlatform, type Provider, SignInCancelled } from '@maka-cloud/client';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

/** What the build was given (app.config.ts): the owner's client ids are build settings, not code. */
export interface SignInBuild {
  /** Apple's sheet is built in (the capability is on the app). */
  apple?: boolean;
  /** Google's OAuth client ids, one per platform the app is built for. */
  google?: { ios?: string; android?: string };
}

const build = (): SignInBuild =>
  (Constants.expoConfig?.extra as { signIn?: SignInBuild } | undefined)?.signIn ?? {};

/** The Google client id of this platform, when the build has one. */
function googleClientId(): string | undefined {
  const ids = build().google;
  const id =
    Platform.OS === 'ios' ? ids?.ios : Platform.OS === 'android' ? ids?.android : undefined;
  return id || undefined;
}

/**
 * Which of Apple's and Google's own sheets this build carries. A way the server offers but the build
 * lacks is not shown; the person still has the emailed code and the invite token.
 */
export function nativeProviders(): Record<Provider, boolean> {
  return {
    apple: Platform.OS === 'ios' && build().apple === true,
    google: googleClientId() !== undefined,
  };
}

const GOOGLE = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
};

/**
 * Where Google sends the person back to the app. A native client has no secret and takes a
 * custom scheme: the client id written backwards on iOS, the package name on Android. Both are
 * registered as the app's schemes at build time (app.config.ts).
 */
export function googleRedirectUri(clientId: string, os: string, packageName: string): string {
  if (os === 'ios') {
    const prefix = clientId.replace(/\.apps\.googleusercontent\.com$/u, '');
    return `com.googleusercontent.apps.${prefix}:/oauthredirect`;
  }
  return `${packageName}:/oauthredirect`;
}

async function appleToken(nonce: string): Promise<string> {
  // Loaded when the button is used, so a build that never offers it never loads the native module.
  const Apple = require('expo-apple-authentication') as typeof import('expo-apple-authentication');
  if (!(await Apple.isAvailableAsync())) throw new Error('Apple sign-in is not available here.');
  try {
    // The server's nonce goes in as it is. The server accepts it back, or its SHA-256 in hex.
    const credential = await Apple.signInAsync({
      requestedScopes: [Apple.AppleAuthenticationScope.EMAIL],
      nonce,
    });
    if (!credential.identityToken) throw new Error('Apple did not send a sign-in.');
    return credential.identityToken;
  } catch (e) {
    if ((e as { code?: string } | null)?.code === 'ERR_REQUEST_CANCELED')
      throw new SignInCancelled();
    throw e;
  }
}

async function googleToken(nonce: string): Promise<string> {
  const clientId = googleClientId();
  if (!clientId) throw new Error('Google sign-in is not built into this app.');
  const Auth = require('expo-auth-session') as typeof import('expo-auth-session');
  const redirectUri = googleRedirectUri(
    clientId,
    Platform.OS,
    Constants.expoConfig?.android?.package ?? '',
  );
  const request = new Auth.AuthRequest({
    clientId,
    redirectUri,
    scopes: ['openid', 'email', 'profile'],
    responseType: Auth.ResponseType.Code,
    usePKCE: true,
    extraParams: { nonce },
  });
  const result = await request.promptAsync(GOOGLE);
  if (result.type === 'cancel' || result.type === 'dismiss') throw new SignInCancelled();
  if (result.type !== 'success' || !result.params.code)
    throw new Error('Google did not send a sign-in.');
  const tokens = await Auth.exchangeCodeAsync(
    {
      clientId,
      code: result.params.code,
      redirectUri,
      extraParams: request.codeVerifier ? { code_verifier: request.codeVerifier } : {},
    },
    GOOGLE,
  );
  if (!tokens.idToken) throw new Error('Google did not send a sign-in.');
  return tokens.idToken;
}

export const authPlatform: AuthPlatform = {
  deviceLabel: Platform.OS === 'ios' ? 'iPhone app' : 'Android app',
  async credential(provider, nonce) {
    return provider === 'apple' ? appleToken(nonce) : googleToken(nonce);
  },
};
