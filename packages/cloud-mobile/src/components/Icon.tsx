import { SymbolView } from 'expo-symbols';

/**
 * The few icons the phone draws, from the system's own set (`expo-symbols`): SF Symbols on iOS,
 * Material Symbols on Android and in the browser preview. Never a text glyph, which each font draws
 * differently. Always decorative: the control around it has the name.
 */
const SYMBOLS = {
  send: { ios: 'arrow.up', android: 'arrow_upward', web: 'arrow_upward' },
  external: { ios: 'arrow.up.right', android: 'north_east', web: 'north_east' },
  file: { ios: 'doc', android: 'description', web: 'description' },
  conversations: { ios: 'bubble.left.and.bubble.right', android: 'forum', web: 'forum' },
} as const;

export type IconName = keyof typeof SYMBOLS;

export function Icon({ name, color, size = 18 }: { name: IconName; color: string; size?: number }) {
  return (
    <SymbolView
      name={SYMBOLS[name]}
      size={size}
      tintColor={color}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}
