import { ApiError, type CloudClient, Unsupported } from '@maka-cloud/client';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { useSyncExternalStore } from 'react';
import { readSecure, removeSecure, writeSecure } from './secure';

/**
 * Notifications on the phone, through the server's Expo push (`POST /v1/push/devices`). Nothing is
 * asked of the phone until the person says yes; the push token then goes to the server and is kept
 * here (with the account tag the server stamps on every notification) so signing out can remove it.
 *
 * A notification says only that a decision waits or a result is ready, and carries ids. Its actions
 * are "Got it" and "Not now", which only put it away, and "Open". There is no Approve: an approval
 * binds its exact text, so it is only ever given in the app, where that text is shown.
 */

/** What this phone chose for this server: `on` with its token, or `declined`. */
export type PushRecord =
  | { server: string; state: 'on'; token: string; accountTag: string }
  | { server: string; state: 'declined' };

/** What the notifications card shows. */
export type PushState =
  /** Not read yet. */
  | 'loading'
  /** The person has not said yes or no on this phone for this server. */
  | 'ask'
  | 'on'
  | 'declined'
  /** The phone's settings say no; only the settings app can change that. */
  | 'denied'
  /** This server, or this build of the app, has no push yet. */
  | 'unavailable'
  | 'failed';

const KEY = 'maka.push';

/** The actions each kind of notification gets, by the category the server names. */
export const ACTION = { gotIt: 'got-it', notNow: 'not-now', open: 'open' } as const;

let state: PushState = 'loading';
const listeners = new Set<() => void>();
function set(next: PushState) {
  state = next;
  for (const listener of listeners) listener();
}

/** The card's state, shared by Home and Me. */
export function usePushState(): PushState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

export async function readPush(server: string): Promise<PushRecord | undefined> {
  const raw = await readSecure(KEY);
  if (!raw) return undefined;
  try {
    const record = JSON.parse(raw) as PushRecord;
    return record.server === server ? record : undefined;
  } catch {
    return undefined;
  }
}

/** Reads what this phone chose for `server` into the shared state. */
export async function loadPush(server: string): Promise<PushRecord | undefined> {
  const record = await readPush(server);
  set(record?.state ?? 'ask');
  return record;
}

/** The words on the notification buttons, in the app's language. */
export interface ActionWords {
  gotIt: string;
  notNow: string;
  open: string;
}

async function prepare(words: ActionWords): Promise<void> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Maka',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  const quiet = { opensAppToForeground: false };
  await Notifications.setNotificationCategoryAsync('finished', [
    { identifier: ACTION.gotIt, buttonTitle: words.gotIt, options: quiet },
  ]);
  for (const category of ['decision', 'approval']) {
    await Notifications.setNotificationCategoryAsync(category, [
      { identifier: ACTION.notNow, buttonTitle: words.notNow, options: quiet },
      { identifier: ACTION.open, buttonTitle: words.open, options: { opensAppToForeground: true } },
    ]);
  }
}

/** The project the push token is for; the owner sets it when the EAS project exists. */
function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined;
  const id = extra?.eas?.projectId;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * Turns notifications on for this account: asks the phone (only when `ask` is true, which is the
 * person's own tap), gets the push token and gives it to the server. Called again without asking
 * on every signed-in start while it is on, so a token another account held moves to this one.
 */
export async function turnOn(
  client: CloudClient,
  server: string,
  words: ActionWords,
  ask: boolean,
): Promise<PushState> {
  try {
    const permission = ask
      ? await Notifications.requestPermissionsAsync()
      : await Notifications.getPermissionsAsync();
    if (!permission.granted) return finish(ask ? 'denied' : 'declined', server);
    await prepare(words);
    const id = projectId();
    if (id === undefined) return finish('unavailable');
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: id });
    const platform = Platform.OS === 'android' ? 'android' : 'ios';
    const { accountTag } = await client.registerDevice(token, platform);
    await writeSecure(KEY, JSON.stringify({ server, state: 'on', token, accountTag }));
    return finish('on');
  } catch (error) {
    if (
      error instanceof Unsupported ||
      (error instanceof ApiError && (error.status === 404 || error.status === 405))
    ) {
      return finish('unavailable');
    }
    return finish('failed');
  }
}

async function finish(next: PushState, declinedFor?: string): Promise<PushState> {
  // A phone whose settings now say no is not left registered as on.
  if (declinedFor !== undefined && next === 'declined') {
    await writeSecure(KEY, JSON.stringify({ server: declinedFor, state: 'declined' })).catch(
      () => {},
    );
  }
  set(next);
  return next;
}

/** "Not now", or "Turn off": the server forgets this phone's token and nothing is asked again. */
export async function turnOff(client: CloudClient, server: string): Promise<void> {
  const record = await readPush(server);
  if (record?.state === 'on') await client.removeDevice(record.token).catch(() => {});
  await writeSecure(KEY, JSON.stringify({ server, state: 'declined' })).catch(() => {});
  set('declined');
}

/**
 * Signing out: the record goes, and the token this phone registered is handed back, so the sign-out
 * can have the server forget it (with the session, or on its own for an invite token).
 */
export async function forgetPush(server: string): Promise<string | undefined> {
  const record = await readPush(server);
  await removeSecure(KEY).catch(() => {});
  set('loading');
  return record?.state === 'on' ? record.token : undefined;
}
