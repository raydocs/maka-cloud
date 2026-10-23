import { NativeTabs } from 'expo-router/native-tabs';
import { useT } from '@/lib/i18n';
import { useLanding } from '@/lib/landing';
import { useTheme } from '@/lib/theme';

/**
 * The system's own tab bar: Liquid Glass on iOS 26 and later, Material on Android. Each tab has a
 * fixed `testID` (the iOS device tests match it whatever the language).
 */
export default function TabsLayout() {
  const t = useTheme();
  const { t: say } = useT();
  useLanding();
  return (
    <NativeTabs tintColor={t.ink}>
      <NativeTabs.Trigger name="index" testID="tab-home">
        <NativeTabs.Trigger.Label>{say('tab.home')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="house" md="home" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="chat" testID="tab-chat">
        <NativeTabs.Trigger.Label>{say('tab.chat')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="bubble.left" md="chat" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings" testID="tab-settings">
        <NativeTabs.Trigger.Label>{say('tab.settings')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="gearshape" md="settings" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
