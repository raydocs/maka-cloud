import { SymbolView } from 'expo-symbols';

/**
 * The few icons the phone draws, from the system's own set (`expo-symbols`): SF Symbols on iOS,
 * Material Symbols on Android and in the browser preview. One family of thin line icons at one size
 * (`ICON`, drawn at the light weight), never a text glyph, which each font draws differently. Always
 * decorative: the control around it has the name.
 */
const SYMBOLS = {
  send: { ios: 'arrow.up', android: 'arrow_upward', web: 'arrow_upward' },
  external: { ios: 'arrow.up.right', android: 'north_east', web: 'north_east' },
  file: { ios: 'doc', android: 'description', web: 'description' },
  conversations: { ios: 'bubble.left.and.bubble.right', android: 'forum', web: 'forum' },
  search: { ios: 'magnifyingglass', android: 'search', web: 'search' },
  plus: { ios: 'plus', android: 'add', web: 'add' },
  person: { ios: 'person', android: 'person', web: 'person' },
  chevronDown: { ios: 'chevron.down', android: 'expand_more', web: 'expand_more' },
  chevronUp: { ios: 'chevron.up', android: 'expand_less', web: 'expand_less' },
  check: { ios: 'checkmark', android: 'check', web: 'check' },
  cross: { ios: 'xmark', android: 'close', web: 'close' },
} as const;

export type IconName = keyof typeof SYMBOLS;

/** Every icon's size. */
export const ICON = 18;

export function Icon({ name, color }: { name: IconName; color: string }) {
  return (
    <SymbolView
      name={SYMBOLS[name]}
      size={ICON}
      weight="light"
      tintColor={color}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}
