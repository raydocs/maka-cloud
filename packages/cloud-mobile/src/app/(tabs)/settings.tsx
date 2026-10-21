import { ScrollView, View } from 'react-native';
import { Card, PillButton, Screen, T } from '@/components/ui';
import { useAppearance } from '@/lib/appearance';
import { useSession } from '@/lib/session';

export default function Settings() {
  const { signOut } = useSession();
  const { mode, setMode } = useAppearance();
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        <T kind="title">Settings</T>
        <Card label="Appearance">
          <T kind="heading">Appearance</T>
          <T kind="muted">{mode === 'dark' ? 'Dark is on.' : 'Light is on.'}</T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <PillButton label="Dark" primary={mode === 'dark'} onPress={() => setMode('dark')} />
            </View>
            <View style={{ flex: 1 }}>
              <PillButton
                label="Light"
                primary={mode === 'light'}
                onPress={() => setMode('light')}
              />
            </View>
          </View>
        </Card>
        <Card label="Account">
          <T kind="heading">Account</T>
          <T kind="muted">
            Signing out removes this device’s access. Your work stays on the server.
          </T>
          <PillButton label="Sign out" onPress={() => void signOut()} />
        </Card>
      </ScrollView>
    </Screen>
  );
}
