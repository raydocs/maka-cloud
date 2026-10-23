import { Tabs } from 'expo-router';
import { useT } from '@/lib/i18n';
import { useLanding } from '@/lib/landing';
import { useTheme } from '@/lib/theme';

/**
 * Only for the browser preview used to review the screens: a plain bottom bar. The apps themselves
 * use the system's tab bar (`_layout.tsx`), which a browser cannot draw.
 */
export default function TabsLayout() {
  const t = useTheme();
  const { t: say } = useT();
  useLanding();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.ink,
        tabBarInactiveTintColor: t.inkMuted,
        tabBarStyle: { backgroundColor: t.solid, borderTopColor: t.solidLine, height: 56 },
        tabBarIcon: () => null,
        tabBarLabelPosition: 'beside-icon',
        tabBarLabelStyle: { fontSize: 13 },
        sceneStyle: { backgroundColor: 'transparent' },
      }}
    >
      <Tabs.Screen name="index" options={{ title: say('tab.home') }} />
      <Tabs.Screen name="chat" options={{ title: say('tab.chat') }} />
      <Tabs.Screen name="settings" options={{ title: say('tab.settings') }} />
    </Tabs>
  );
}
