import { useRouter } from 'expo-router';
import { TabList, TabSlot, Tabs, TabTrigger, type TabTriggerSlotProps } from 'expo-router/ui';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Glass, GlassButton, GlassGroup, TOP_BAR } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { useLanding } from '@/lib/landing';
import type { Key } from '@/lib/strings';
import { radius, useTheme } from '@/lib/theme';

/** The three sections, in the pill's order; each has a fixed test id whatever the language. */
const SECTIONS: ReadonlyArray<{ name: string; href: '/' | '/chat' | '/projects'; label: Key }> = [
  { name: 'index', href: '/', label: 'tab.home' },
  { name: 'chat', href: '/chat', label: 'tab.chat' },
  { name: 'projects', href: '/projects', label: 'tab.projects' },
];

const TEST_IDS: Record<string, string> = {
  index: 'tab-home',
  chat: 'tab-chat',
  projects: 'tab-projects',
};

/**
 * No bottom tab bar: a floating top bar instead, over every section. Search on the left, a glass
 * pill with the three sections in the middle, and the round "Me" button on the right. Each section
 * scrolls under it and keeps its own floating composer at the bottom.
 */
export default function SectionsLayout() {
  useLanding();
  return (
    <Tabs style={{ flex: 1 }}>
      <TabSlot style={{ flex: 1 }} />
      {/* The routes the pill switches between; the pill itself draws them. */}
      <TabList style={{ display: 'none' }}>
        {SECTIONS.map(({ name, href }) => (
          <TabTrigger key={name} name={name} href={href} />
        ))}
      </TabList>
      <TopBar />
    </Tabs>
  );
}

function TopBar() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t: say } = useT();
  return (
    <View
      pointerEvents="box-none"
      style={[styles.bar, { top: insets.top, left: insets.left + 12, right: insets.right + 12 }]}
    >
      <GlassButton
        label={say('top.search')}
        id="search"
        icon="search"
        onPress={() => router.push('/search')}
      />
      <GlassGroup style={styles.pillWrap}>
        <Glass interactive style={styles.pill}>
          <View
            accessibilityRole="tablist"
            accessibilityLabel={say('tab.sections')}
            style={styles.segments}
          >
            {SECTIONS.map(({ name, label }) => (
              <TabTrigger key={name} name={name} asChild>
                <Segment label={say(label)} testID={TEST_IDS[name]} />
              </TabTrigger>
            ))}
          </View>
        </Glass>
      </GlassGroup>
      <GlassButton label={say('top.me')} id="me" icon="person" onPress={() => router.push('/me')} />
    </View>
  );
}

/** One section of the pill: the chosen one sits on a filled ink capsule, the others are plain words. */
function Segment({
  label,
  isFocused,
  testID,
  ...props
}: Omit<TabTriggerSlotProps, 'ref'> & { label: string; testID?: string }) {
  const t = useTheme();
  return (
    <Pressable
      {...props}
      testID={testID}
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected: Boolean(isFocused) }}
      hitSlop={{ top: 6, bottom: 6 }}
      style={({ pressed }) => [
        styles.segment,
        isFocused && { backgroundColor: t.chip },
        { opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <Text
        allowFontScaling
        maxFontSizeMultiplier={1.4}
        style={[
          styles.segmentText,
          { color: isFocused ? t.ink : t.inkMuted },
          isFocused && styles.on,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    height: TOP_BAR,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  pillWrap: { flexShrink: 1 },
  pill: { borderRadius: radius.pill, padding: 4 },
  segments: { flexDirection: 'row', gap: 2 },
  segment: {
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentText: { fontSize: 15 },
  on: { fontWeight: '600' },
});
