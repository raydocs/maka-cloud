import { Tabs } from 'expo-router';
import { TopBar } from '@/components/TopBar';
import { useLanding } from '@/lib/landing';

/**
 * The three sections as a glass pill at the top (`TopBar`), the same on iOS, Android and the browser
 * preview. Each screen leaves `HEADER_SPACE` above its content for it.
 */
export default function TabsLayout() {
  useLanding();
  return (
    <Tabs
      tabBar={(props) => <TopBar {...props} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: 'transparent' } }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="chat" options={{ title: 'Chat' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}
