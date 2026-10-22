import { NativeTabs } from 'expo-router/native-tabs';
import { useLanding } from '@/lib/landing';
import { useTheme } from '@/lib/theme';

/** The system's own tab bar: Liquid Glass on iOS 26 and later, Material on Android. */
export default function TabsLayout() {
  const t = useTheme();
  useLanding();
  return (
    <NativeTabs tintColor={t.ink}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="house" md="home" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="chat">
        <NativeTabs.Trigger.Label>Chat</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="bubble.left" md="chat" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="gearshape" md="settings" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
