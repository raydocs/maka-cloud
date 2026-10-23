import {
  activeWords,
  displayText,
  type CloudClient,
  errorText,
  identityWords,
  type SignedInDevices,
  Unsupported,
} from '@maka-cloud/client';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { Card, PillButton, T } from '@/components/ui';
import { type Translator, useT } from '@/lib/i18n';

/**
 * `activeWords` in the app's language. The shared logic decides the wording (and when minutes
 * become hours); this only puts its English into the catalogue's words.
 */
function activeLabel(words: string, say: Translator['t']): string {
  if (words === 'Active now') return say('devices.activeNow');
  const match = /^Active (\d+) (minute|hour|day)s? ago$/u.exec(words);
  if (!match) return words;
  const count = Number(match[1]);
  if (match[2] === 'minute') return say('devices.activeMinutes', { count });
  if (match[2] === 'hour')
    return count === 1 ? say('devices.activeHour') : say('devices.activeHours', { count });
  return count === 1 ? say('devices.activeDay') : say('devices.activeDays', { count });
}

/** `identityWords` in the app's language: the same ways, in the same order. */
function waysLabel(identities: SignedInDevices['identities'], say: Translator['t']): string {
  const names = identities.map((identity) =>
    identity.provider === 'apple'
      ? 'Apple'
      : identity.provider === 'google'
        ? 'Google'
        : identity.email
          ? say('devices.emailAt', { address: identity.email })
          : say('devices.email'),
  );
  if (names.length <= 1) return names[0] ?? '';
  return say('devices.list', {
    items: names.slice(0, -1).join(say('devices.listSeparator')),
    last: names.at(-1) ?? '',
  });
}

/**
 * The devices signed in to this account, with a way to sign any other one out. Shown only for an
 * account that signs in with Apple, Google or email: an invite token alone has no devices, and a
 * server without sign-in has no such list.
 */
export function Devices({ client, now = Date.now }: { client: CloudClient; now?: () => number }) {
  const [devices, setDevices] = useState<SignedInDevices | undefined>();
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState('');
  const { t: say, tx, lang } = useT();
  const load = useCallback(async () => {
    try {
      setDevices(await client.devices());
    } catch (e) {
      // No list on this server: say nothing. Any other failure keeps what is shown.
      if (!(e instanceof Unsupported)) setProblem(errorText(e));
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!devices || devices.sessions.length === 0) return null;
  const ways =
    lang === 'en' ? identityWords(devices.identities) : waysLabel(devices.identities, say);
  return (
    <Card label={say('devices.title')}>
      <T kind="heading">{say('devices.title')}</T>
      {ways ? <T kind="muted">{say('devices.ways', { ways })}</T> : null}
      {devices.sessions.map((device) => (
        <View key={device.sessionId} style={{ gap: 6 }} accessible={false}>
          <T>
            {displayText(device.deviceLabel)}
            {device.current ? say('devices.this') : ''}
          </T>
          <T kind="small">{activeLabel(activeWords(device.lastSeenAt, now()), say)}</T>
          {device.current ? null : (
            <PillButton
              label={say('devices.signOut', { device: displayText(device.deviceLabel) })}
              id={`Sign out ${displayText(device.deviceLabel)}`}
              disabled={busy === device.sessionId}
              onPress={() => {
                setBusy(device.sessionId);
                setProblem('');
                client
                  .signOutDevice(device.sessionId)
                  .then(load)
                  .catch((e: unknown) => setProblem(errorText(e)))
                  .finally(() => setBusy(''));
              }}
            />
          )}
        </View>
      ))}
      {problem ? <T kind="error">{tx(problem)}</T> : null}
    </Card>
  );
}
