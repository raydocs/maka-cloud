import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Devices } from '@/components/Devices';
import { Card, PillButton, Screen, T } from '@/components/ui';
import { type ModeChoice, useAppearance } from '@/lib/appearance';
import { useSession, useWorkspace } from '@/lib/session';

const CHOICES: ReadonlyArray<{ value: ModeChoice; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export default function Settings() {
  const { signOut } = useSession();
  const { client } = useWorkspace();
  const { mode, choice, setMode } = useAppearance();
  const [signOutError, setSignOutError] = useState('');
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        <T kind="title">Settings</T>
        <Card label="Appearance">
          <T kind="heading">Appearance</T>
          <T kind="muted">
            {choice === 'system'
              ? `Follows this phone: ${mode === 'dark' ? 'dark' : 'light'} now.`
              : mode === 'dark'
                ? 'Dark is on.'
                : 'Light is on.'}
          </T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {CHOICES.map(({ value, label }) => (
              <View key={value} style={{ flex: 1 }}>
                <PillButton
                  label={label}
                  primary={choice === value}
                  onPress={() => setMode(value)}
                />
              </View>
            ))}
          </View>
        </Card>
        <Devices client={client} />
        <Card label="Account">
          <T kind="heading">Account</T>
          <T kind="muted">
            Signing out removes this device’s access. Your work stays on the server.
          </T>
          {signOutError ? <T kind="error">{signOutError}</T> : null}
          <PillButton
            label="Sign out"
            onPress={() => {
              setSignOutError('');
              signOut().catch(() =>
                setSignOutError('This device’s access could not be removed. Try again.'),
              );
            }}
          />
        </Card>
      </ScrollView>
    </Screen>
  );
}
