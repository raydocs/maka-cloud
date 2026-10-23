/**
 * The look, once, for the web app and the phone apps. `npm run generate` writes
 * packages/cloud-web/src/tokens.css and packages/cloud-mobile/src/lib/tokens.generated.ts from it;
 * nothing else defines a color, a size or a radius.
 *
 * The idea: a calm sky behind everything, frosted cards with no hard edges floating on it, one dark
 * pill for what is selected, one family of type in a few sizes. Code, diffs and test output stay on
 * opaque surfaces. Light is the default; dark is the same sky at night.
 *
 * Colors are `#rrggbb` or `rgb(r g b / a)`, the two forms the web contrast test reads.
 */

export type ColorName =
  | 'bg-top'
  | 'bg-bottom'
  | 'glow'
  | 'ink'
  | 'ink-muted'
  | 'accent'
  | 'on-accent'
  | 'ok'
  | 'warn'
  | 'bad'
  | 'card'
  | 'card-strong'
  | 'card-edge'
  | 'chip'
  | 'pill-on'
  | 'on-pill-on'
  | 'solid'
  | 'solid-ink'
  | 'solid-muted'
  | 'solid-line'
  | 'diff-add'
  | 'diff-del'
  | 'overlay'
  | 'glass'
  | 'bg-top-clear'
  | 'panel'
  | 'panel-ink'
  | 'panel-muted'
  | 'panel-glass'
  | 'panel-glass-on'
  | 'panel-clear';

export type Colors = Record<ColorName, string>;

/**
 * The compact panel (docs/fork/design/compact-panel.md): the conversation sits on one near-black
 * rounded slab, the same in both schemes, with translucent glass controls on it and fades instead of
 * edges. `panel-clear` is the panel at zero opacity, where a fade ends.
 */
const PANEL = {
  panel: '#0b0b0c',
  'panel-ink': '#f4f4f6',
  'panel-muted': '#a6a6ae',
  'panel-glass': 'rgb(255 255 255 / 0.1)',
  'panel-glass-on': 'rgb(255 255 255 / 0.24)',
  'panel-clear': 'rgb(11 11 12 / 0)',
} as const satisfies Partial<Colors>;

export const light: Colors = {
  'bg-top': '#b4cbee',
  'bg-bottom': '#eef3fb',
  glow: 'rgb(255 255 255 / 0.55)',
  ink: '#0f1217',
  'ink-muted': '#465063',
  accent: '#3043c4',
  'on-accent': '#ffffff',
  ok: '#16603a',
  warn: '#6b4400',
  bad: '#9f1f28',
  card: 'rgb(255 255 255 / 0.58)',
  'card-strong': 'rgb(255 255 255 / 0.92)',
  'card-edge': 'rgb(255 255 255 / 0.6)',
  chip: 'rgb(255 255 255 / 0.66)',
  'pill-on': '#111318',
  'on-pill-on': '#ffffff',
  solid: '#ffffff',
  'solid-ink': '#1b2431',
  'solid-muted': '#4b596c',
  'solid-line': '#d5ddea',
  'diff-add': '#e3f4e8',
  'diff-del': '#fbe6e6',
  overlay: 'rgb(235 243 255 / 0.55)',
  glass: 'rgb(255 255 255 / 0.55)',
  'bg-top-clear': 'rgb(180 203 238 / 0)',
  ...PANEL,
};

export const dark: Colors = {
  'bg-top': '#0d1322',
  'bg-bottom': '#1b2335',
  glow: 'rgb(140 160 255 / 0.12)',
  ink: '#eef1f7',
  'ink-muted': '#b2b9c8',
  accent: '#a3b1ff',
  'on-accent': '#0d1322',
  ok: '#86d9a8',
  warn: '#f0c36a',
  bad: '#ff9ea2',
  card: 'rgb(255 255 255 / 0.07)',
  'card-strong': 'rgb(38 46 66 / 0.96)',
  'card-edge': 'rgb(255 255 255 / 0.08)',
  chip: 'rgb(255 255 255 / 0.09)',
  'pill-on': '#f2f4f8',
  'on-pill-on': '#0d1322',
  solid: '#0e1525',
  'solid-ink': '#dfe7f3',
  'solid-muted': '#9fb0c7',
  'solid-line': '#26324a',
  'diff-add': '#12301f',
  'diff-del': '#3a1a1d',
  overlay: 'rgb(5 10 22 / 0.6)',
  glass: 'rgb(255 255 255 / 0.1)',
  'bg-top-clear': 'rgb(13 19 34 / 0)',
  ...PANEL,
};

/** Card shadows differ by scheme but are not colors a contrast check reads. */
export const shadow = {
  light: '0 1px 2px rgb(30 50 90 / 0.06), 0 12px 32px rgb(30 50 90 / 0.1)',
  dark: '0 1px 2px rgb(0 0 0 / 0.3), 0 12px 32px rgb(0 0 0 / 0.35)',
};

/** One family. Inter ships with the web app; the phones use the system face. */
export const font = {
  sans: '"Inter Variable", Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
};

/** Six sizes and two weights: the hierarchy comes from size and space, not from bold and boxes. */
export const type = {
  xs: 12,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 24,
  hero: 40,
  regular: 400,
  medium: 500,
} as const;

/** `tile` and `panel` are the compact panel's large radii: Home's tiles and the conversation slab. */
export const radius = { card: 22, inner: 14, pill: 9999, tile: 28, panel: 36 } as const;

/** Everything is spaced in multiples of 4. */
export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32 } as const;

export const blur = 'saturate(160%) blur(24px)';

export const motion = { ease: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fast: 140, base: 220 } as const;
