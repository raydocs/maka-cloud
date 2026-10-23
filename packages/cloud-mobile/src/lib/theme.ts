import { createContext, useContext } from 'react';

import { DARK_COLORS, LIGHT_COLORS, RADIUS } from './tokens.generated';

/**
 * The look (T24), made native. The colors come from packages/cloud-design, the same source as the
 * web's tokens.css, one value per scheme. Frosted cards sit on a soft sky; whatever holds code or a
 * diff is opaque (`solid`).
 */
export type Palette = { scheme: 'dark' | 'light' } & {
  [K in keyof typeof LIGHT_COLORS]: string;
};

/**
 * Two tones, ink on a surface, swapped at night; every screen, the conversation included, follows
 * the appearance. The one colour beyond them (`warn`) marks what needs the person.
 */
export const DARK: Palette = { scheme: 'dark', ...DARK_COLORS };

export const LIGHT: Palette = { scheme: 'light', ...LIGHT_COLORS };

/** A `#rrggbb` colour with no opacity, for a fade that ends in the same hue rather than grey. */
export function clearOf(color: string): string {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(color);
  if (!hex) return 'transparent';
  const [r, g, b] = hex.slice(1).map((part) => Number.parseInt(part, 16));
  return `rgba(${r}, ${g}, ${b}, 0)`;
}

export const radius = RADIUS;
/** At least 44 pt, the smallest comfortable touch target. */
export const TOUCH = 44;
export const mono = { fontFamily: 'Menlo' } as const;

export const ThemeContext = createContext<Palette>(LIGHT);
export const useTheme = () => useContext(ThemeContext);
