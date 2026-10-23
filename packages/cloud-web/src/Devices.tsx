import {
  activeWords,
  type CloudClient,
  displayText,
  errorText,
  identityWords,
  type SignedInDevices,
  Unsupported,
} from '@maka-cloud/client';
import { Button } from '@astryxdesign/core';
import { useCallback, useEffect, useState } from 'react';

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
  const [devices, setDevices] = useState<SignedInDevices | undefined>();
  const [problem, setProblem] = useState('');
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
  const ways = identityWords(devices.identities);
  return (
    <section className="card section-card" aria-label="Signed-in devices">
      <h2>Signed-in devices</h2>
      {ways ? <p className="muted">You sign in with {ways}.</p> : null}
      <ul className="device-list">
        {devices.sessions.map((device) => (
          <li key={device.sessionId}>
            <div>
              <strong>
                {displayText(device.deviceLabel)}
                {device.current ? ' · this device' : ''}
              </strong>
              <span className="muted">{activeWords(device.lastSeenAt, now())}</span>
            </div>
            {device.current ? null : (
              <Button
                label={`Sign out ${displayText(device.deviceLabel)}`}
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
          {problem}
        </p>
      ) : null}
    </section>
  );
}
