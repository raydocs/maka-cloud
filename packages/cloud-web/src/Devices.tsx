import {
  activeWords,
  type CloudClient,
  displayText,
  errorText,
  type ErrorText,
  type SignedInDevices,
  Unsupported,
} from '@maka-cloud/client';
import { Button } from '@astryxdesign/core';
import { useCallback, useEffect, useState } from 'react';
import { useT } from './i18n';

/**
 * The devices signed in to this account, with a way to sign any other one out. Hidden for an account
 * that signs in with an invite token alone (it has none) and on a server without sign-in.
 */
export function DevicesPanel({
  client,
  now = Date.now,
}: {
  client: CloudClient;
  now?: () => number;
}) {
  const { t, shared } = useT();
  const [devices, setDevices] = useState<SignedInDevices | undefined>();
  const [problem, setProblem] = useState<ErrorText>('');
  const [busy, setBusy] = useState('');
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
  const ways = waysWords(devices.identities, t);
  return (
    <section className="card section-card" aria-label={t('Signed-in devices')}>
      <h2>{t('Signed-in devices')}</h2>
      {ways ? <p className="muted">{t('You sign in with {ways}.', { ways })}</p> : null}
      <ul className="device-list">
        {devices.sessions.map((device) => (
          <li key={device.sessionId}>
            <div>
              <strong>
                {displayText(device.deviceLabel)}
                {device.current ? ` · ${t('this device')}` : ''}
              </strong>
              <span className="muted">{shared(activeWords(device.lastSeenAt, now()))}</span>
            </div>
            {device.current ? null : (
              <Button
                label={t('Sign out {device}', { device: displayText(device.deviceLabel) })}
                variant="secondary"
                isDisabled={busy === device.sessionId}
                onClick={() => {
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
          </li>
        ))}
      </ul>
      {problem ? (
        <p role="alert" className="error">
          {shared(problem)}
        </p>
      ) : null}
    </section>
  );
}

/** Which ways an account signs in, in the person's language ("Apple, Google and email ada@example.com"). */
function waysWords(
  identities: SignedInDevices['identities'],
  t: ReturnType<typeof useT>['t'],
): string {
  const names = identities.map((identity) =>
    identity.provider === 'apple'
      ? 'Apple'
      : identity.provider === 'google'
        ? 'Google'
        : identity.email
          ? t('email {address}', { address: displayText(identity.email) })
          : t('email'),
  );
  if (names.length <= 1) return names[0] ?? '';
  return t('{items} and {last}', {
    items: names.slice(0, -1).join(t(', ')),
    last: names.at(-1) ?? '',
  });
}
