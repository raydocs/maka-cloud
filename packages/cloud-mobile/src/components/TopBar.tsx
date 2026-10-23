import type { Tabs } from 'expo-router';
import * as Haptics from 'expo-haptics';
import type { ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { PANEL, radius, ThemeContext, TOUCH, useTheme } from '@/lib/theme';
import { Fade, Glass } from './ui';

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

/** The pill's height: 44 pt segments in a 4 pt rim. */
const PILL = TOUCH + 8;
/** How far a screen's content starts below the safe area, so it begins under the floating pill. */
export const HEADER_SPACE = 8 + PILL + 8;

/**
 * The sections as one glass pill floating at the top, the open one a filled pill inside it. Content
 * scrolls under it and fades out. Over the conversation's dark panel it takes the panel's glass, and
 * the panel draws its own fade; over the sky it fades into the sky.
 */
export function TopBar({ state, descriptors, emitter, navigateToTab, insets }: TabBarProps) {
  const sky = useTheme();
  const onPanel = state.routes[state.index]?.name === 'chat';
  const t = onPanel ? PANEL : sky;
  return (
    <ThemeContext.Provider value={t}>
      <View
        pointerEvents="box-none"
        style={[
          styles.bar,
          { paddingTop: insets.top + 8, paddingLeft: insets.left, paddingRight: insets.right },
        ]}
      >
        {!onPanel && (
          <Fade
            edge="top"
            height={insets.top + HEADER_SPACE + 16}
            color={t.bgTop}
            clear={t.bgTopClear}
          />
        )}
        <Glass style={styles.pill}>
          <View accessibilityRole="tablist" style={styles.segments}>
            {state.routes.map((route, index) => {
              const focused = state.index === index;
              const label = descriptors[route.key]?.options.title ?? route.name;
              const fill = onPanel ? t.panelGlassOn : t.pillOn;
              const ink = focused && !onPanel ? t.onPillOn : t.ink;
              return (
                <Pressable
                  key={route.key}
                  testID={`tab-${route.name}`}
                  accessibilityRole="tab"
                  accessibilityLabel={label}
                  accessibilityState={{ selected: focused }}
                  onPress={() => {
                    const event = emitter.emit({
                      type: 'tabPress',
                      target: route.key,
                      canPreventDefault: true,
                    });
                    if (focused || event.defaultPrevented) return;
                    void Haptics.selectionAsync().catch(() => {});
                    navigateToTab(route.key);
                  }}
                  style={({ pressed }) => [
                    styles.segment,
                    focused && { backgroundColor: fill },
                    { opacity: pressed && !focused ? 0.7 : 1 },
                  ]}
                >
                  <Text style={[styles.label, { color: ink }]} allowFontScaling>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Glass>
      </View>
    </ThemeContext.Provider>
  );
}

const styles = StyleSheet.create({
  bar: { position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center' },
  pill: { borderRadius: radius.pill },
  segments: { flexDirection: 'row', padding: 4, gap: 2 },
  segment: {
    minHeight: TOUCH,
    minWidth: 72,
    paddingHorizontal: 18,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontSize: 15, fontWeight: '600' },
});
