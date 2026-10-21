import { Tabs } from 'expo-router';
import { useLanding } from '@/lib/landing';
import { useTheme } from '@/lib/theme';

/**
 * Only for the browser preview used to review the screens: a plain bottom bar. The apps themselves
 * use the system's tab bar (`_layout.tsx`), which a browser cannot draw.
 */
export default function TabsLayout() {
  const t = useTheme();
  useLanding();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.accent,
        tabBarInactiveTintColor: t.inkMuted,
        tabBarStyle: { backgroundColor: t.solid, borderTopColor: t.solidLine, height: 56 },
        tabBarIcon: () => null,
        tabBarLabelPosition: 'beside-icon',
        tabBarLabelStyle: { fontSize: 13 },
        sceneStyle: { backgroundColor: 'transparent' },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="chat" options={{ title: 'Chat' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}
