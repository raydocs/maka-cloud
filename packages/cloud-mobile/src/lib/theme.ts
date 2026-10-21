import { createContext, useContext } from 'react';

/**
 * The look (T24), made native. The same palette as the web's tokens.css, one value per scheme.
 * Frosted cards sit on a soft gradient; whatever holds code or a diff is opaque (`solid`).
 */
export interface Palette {
  scheme: 'dark' | 'light';
  bgTop: string;
  bgBottom: string;
  ink: string;
  inkMuted: string;
  accent: string;
  onAccent: string;
  ok: string;
  warn: string;
  bad: string;
  card: string;
  cardEdge: string;
  chip: string;
  pillOn: string;
  onPillOn: string;
  solid: string;
  solidInk: string;
  solidMuted: string;
  solidLine: string;
}

export const DARK: Palette = {
  scheme: 'dark',
  bgTop: '#0b1730',
  bgBottom: '#1b2b45',
  ink: '#e9eef7',
  inkMuted: '#a9b6ca',
  accent: '#8db8ff',
  onAccent: '#0b1730',
  ok: '#7fd6a2',
  warn: '#f0c36a',
  bad: '#ff9a9e',
  card: 'rgba(24, 38, 68, 0.55)',
  cardEdge: 'rgba(255, 255, 255, 0.12)',
  chip: 'rgba(255, 255, 255, 0.1)',
  pillOn: '#e9eef7',
  onPillOn: '#0b1730',
  solid: '#0e1829',
  solidInk: '#dfe7f3',
  solidMuted: '#9fb0c7',
  solidLine: '#26364f',
};

export const LIGHT: Palette = {
  scheme: 'light',
  bgTop: '#cfe5ff',
  bgBottom: '#f4f8ff',
  ink: '#14202e',
  inkMuted: '#43536a',
  accent: '#245bbb',
  onAccent: '#ffffff',
  ok: '#1d6b42',
  warn: '#8a5a00',
  bad: '#a3262c',
  card: 'rgba(255, 255, 255, 0.45)',
  cardEdge: 'rgba(255, 255, 255, 0.7)',
  chip: 'rgba(255, 255, 255, 0.6)',
  pillOn: '#14202e',
  onPillOn: '#ffffff',
  solid: '#ffffff',
  solidInk: '#1b2431',
  solidMuted: '#4b596c',
  solidLine: '#d5ddea',
};

export const radius = { card: 18, small: 12, pill: 999 } as const;
/** At least 44 pt, the smallest comfortable touch target. */
export const TOUCH = 44;
export const mono = { fontFamily: 'Menlo' } as const;

export const ThemeContext = createContext<Palette>(DARK);
export const useTheme = () => useContext(ThemeContext);
