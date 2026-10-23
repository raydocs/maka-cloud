import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppearanceProvider, useAppearance } from '@/lib/appearance';
import { LanguageProvider, useT } from '@/lib/i18n';
import { SessionProvider, useSession } from '@/lib/session';
import { Screen } from '@/components/ui';
import { View } from 'react-native';

function Routes() {
  const { session } = useSession();
  const { mode } = useAppearance();
  const { t: say } = useT();
  if (session.status === 'loading')
    return (
      <Screen>
        <View accessibilityLabel={say('common.loading')} style={{ flex: 1 }} />
      </Screen>
    );
  return (
    <>
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: 'transparent' } }}
      >
        <Stack.Protected guard={session.status === 'in'}>
          <Stack.Screen name="(tabs)" />
          {/* Me and Search open over the sections as sheets. */}
          <Stack.Screen name="me" options={{ presentation: 'modal' }} />
          <Stack.Screen name="search" options={{ presentation: 'modal' }} />
        </Stack.Protected>
        <Stack.Protected guard={session.status === 'out'}>
          <Stack.Screen name="sign-in" />
        </Stack.Protected>
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <LanguageProvider>
        <AppearanceProvider>
          <SessionProvider>
            <Routes />
          </SessionProvider>
        </AppearanceProvider>
      </LanguageProvider>
    </SafeAreaProvider>
  );
}
