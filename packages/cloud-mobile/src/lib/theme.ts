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

export const DARK: Palette = { scheme: 'dark', ...DARK_COLORS };

export const LIGHT: Palette = { scheme: 'light', ...LIGHT_COLORS };

export const radius = RADIUS;
/** At least 44 pt, the smallest comfortable touch target. */
export const TOUCH = 44;
export const mono = { fontFamily: 'Menlo' } as const;

export const ThemeContext = createContext<Palette>(LIGHT);
export const useTheme = () => useContext(ThemeContext);
