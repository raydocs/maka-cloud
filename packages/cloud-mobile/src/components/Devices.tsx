import {
  activeWords,
  type CloudClient,
  errorText,
  identityWords,
  type SignedInDevices,
  Unsupported,
} from '@maka-cloud/client';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { Card, PillButton, T } from '@/components/ui';

/**
 * The devices signed in to this account, with a way to sign any other one out. Shown only for an
 * account that signs in with Apple, Google or email: an invite token alone has no devices, and a
 * server without sign-in has no such list.
 */
export function Devices({ client, now = Date.now }: { client: CloudClient; now?: () => number }) {
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
    <Card label="Signed-in devices">
      <T kind="heading">Signed-in devices</T>
      {ways ? <T kind="muted">You sign in with {ways}.</T> : null}
      {devices.sessions.map((device) => (
        <View key={device.sessionId} style={{ gap: 6 }} accessible={false}>
          <T>
            {device.deviceLabel}
            {device.current ? ' · this device' : ''}
          </T>
          <T kind="small">{activeWords(device.lastSeenAt, now())}</T>
          {device.current ? null : (
            <PillButton
              label={`Sign out ${device.deviceLabel}`}
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
      {problem ? <T kind="error">{problem}</T> : null}
    </Card>
  );
}
