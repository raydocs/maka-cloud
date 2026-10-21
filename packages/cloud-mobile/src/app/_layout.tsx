import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppearanceProvider, useAppearance } from '@/lib/appearance';
import { SessionProvider, useSession } from '@/lib/session';
import { Screen } from '@/components/ui';
import { View } from 'react-native';

function Routes() {
  const { session } = useSession();
  const { mode } = useAppearance();
  if (session.status === 'loading')
    return (
      <Screen>
        <View accessibilityLabel="Loading" style={{ flex: 1 }} />
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
      <AppearanceProvider>
        <SessionProvider>
          <Routes />
        </SessionProvider>
      </AppearanceProvider>
    </SafeAreaProvider>
  );
}
