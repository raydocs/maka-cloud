import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Devices } from '@/components/Devices';
import { Card, PillButton, Screen, T } from '@/components/ui';
import { type ModeChoice, useAppearance } from '@/lib/appearance';
import { useT } from '@/lib/i18n';
import { useSession, useWorkspace } from '@/lib/session';
import type { Key } from '@/lib/strings';

const CHOICES: ReadonlyArray<{ value: ModeChoice; label: Key; id: string }> = [
  { value: 'system', label: 'settings.system', id: 'System' },
  { value: 'light', label: 'settings.lightChoice', id: 'Light' },
  { value: 'dark', label: 'settings.darkChoice', id: 'Dark' },
];

export default function Settings() {
  const { signOut } = useSession();
  const { client } = useWorkspace();
  const { mode, choice, setMode } = useAppearance();
  const [signOutError, setSignOutError] = useState('');
  const { t: say, lang } = useT();
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        <T kind="title">{say('settings.title')}</T>
        <Card label={say('settings.appearance')}>
          <T kind="heading">{say('settings.appearance')}</T>
          <T kind="muted">
            {choice === 'system'
              ? say('settings.follows', {
                  mode: say(mode === 'dark' ? 'settings.dark' : 'settings.light'),
                })
              : say(mode === 'dark' ? 'settings.darkOn' : 'settings.lightOn')}
            {lang === 'en' ? ' ' : ''}
            {say('settings.panel')}
          </T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {CHOICES.map(({ value, label, id }) => (
              <View key={value} style={{ flex: 1 }}>
                <PillButton
                  label={say(label)}
                  id={id}
                  primary={choice === value}
                  onPress={() => setMode(value)}
                />
              </View>
            ))}
          </View>
        </Card>
        <Devices client={client} />
        <Card label={say('settings.account')}>
          <T kind="heading">{say('settings.account')}</T>
          <T kind="muted">{say('settings.account.body')}</T>
          {signOutError ? <T kind="error">{signOutError}</T> : null}
          <PillButton
            label={say('settings.signOut')}
            id="Sign out"
            onPress={() => {
              setSignOutError('');
              signOut().catch(() => setSignOutError(say('settings.signOutFailed')));
            }}
          />
        </Card>
      </ScrollView>
    </Screen>
  );
}
