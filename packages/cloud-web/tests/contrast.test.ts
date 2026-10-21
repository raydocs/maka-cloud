import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The look is two schemes of the same tokens (src/tokens.css). Every pair of colors that is shown
 * together must stay readable in both, so a palette change that breaks reading fails here.
 * Text on a frosted card is checked against the card laid over each end of the background gradient
 * (the worst case), and chips are laid over the card as well.
 */
// vitest runs from the package directory (npm test), where src/ lives.
const css = readFileSync(join(process.cwd(), 'src', 'tokens.css'), 'utf8');

type Scheme = 'light' | 'dark';
type Rgba = [number, number, number, number];

/** `light-dark(a, b)` values keyed by token, split at the top-level comma. */
function tokens(): Map<string, [string, string]> {
  const found = new Map<string, [string, string]>();
  for (const match of css.matchAll(/--([a-z-]+):\s*light-dark\(([^;]+)\);/gu)) {
    const body = match[2] ?? '';
    let depth = 0;
    let split = -1;
    for (let i = 0; i < body.length; i += 1) {
      if (body[i] === '(') depth += 1;
      if (body[i] === ')') depth -= 1;
      if (body[i] === ',' && depth === 0 && split === -1) split = i;
    }
    expect(split, `--${match[1]} has two values`).toBeGreaterThan(0);
    found.set(match[1] as string, [body.slice(0, split).trim(), body.slice(split + 1).trim()]);
  }
  return found;
}

function parse(value: string): Rgba {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(value)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
    return [
      Number.parseInt(full.slice(0, 2), 16),
      Number.parseInt(full.slice(2, 4), 16),
      Number.parseInt(full.slice(4, 6), 16),
      1,
    ];
  }
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+))?\s*\)$/iu.exec(value);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), Number(rgb[4] ?? 1)];
  throw new Error(`cannot read the color "${value}"`);
}

function over(top: Rgba, below: Rgba): Rgba {
  const a = top[3];
  return [
    top[0] * a + below[0] * (1 - a),
    top[1] * a + below[1] * (1 - a),
    top[2] * a + below[2] * (1 - a),
    1,
  ];
}

function luminance([r, g, b]: Rgba): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const all = tokens();
function color(name: string, scheme: Scheme): Rgba {
  const pair = all.get(name);
  if (!pair) throw new Error(`token --${name} is missing`);
  return parse(pair[scheme === 'light' ? 0 : 1]);
}

for (const scheme of ['light', 'dark'] as const) {
  describe(`${scheme} scheme`, () => {
    const backgrounds = ['bg-top', 'bg-bottom'].map((name) => color(name, scheme));
    const cards = backgrounds.map((bg) => over(color('card', scheme), bg));
    const chips = cards.map((card) => over(color('chip', scheme), card));
    const atLeast = (label: string, fg: Rgba, bgs: Rgba[], min: number) => {
      it(label, () => {
        for (const bg of bgs) expect(ratio(fg, bg), label).toBeGreaterThanOrEqual(min);
      });
    };

    atLeast('text on the background', color('ink', scheme), backgrounds, 7);
    atLeast('muted text on the background', color('ink-muted', scheme), backgrounds, 4.5);
    atLeast('text on a frosted card', color('ink', scheme), cards, 7);
    atLeast('muted text on a frosted card', color('ink-muted', scheme), cards, 4.5);
    atLeast('text on a chip', color('ink', scheme), chips, 4.5);
    atLeast('muted text on a chip', color('ink-muted', scheme), chips, 4.5);
    atLeast('links and accents on a card', color('accent', scheme), cards, 4.5);
    atLeast('links and accents on the background', color('accent', scheme), backgrounds, 4.5);
    for (const name of ['ok', 'warn', 'bad']) {
      atLeast(`${name} text on a card`, color(name, scheme), cards, 4.5);
      atLeast(`${name} text on the background`, color(name, scheme), backgrounds, 4.5);
    }
    atLeast('text on an accent button', color('on-accent', scheme), [color('accent', scheme)], 4.5);
    atLeast(
      'text on the selected navigation pill',
      color('on-pill-on', scheme),
      [color('pill-on', scheme)],
      7,
    );
    atLeast('text on a code surface', color('solid-ink', scheme), [color('solid', scheme)], 7);
    atLeast(
      'muted text on a code surface',
      color('solid-muted', scheme),
      [color('solid', scheme)],
      4.5,
    );
    for (const name of ['diff-add', 'diff-del']) {
      atLeast(`code on ${name}`, color('solid-ink', scheme), [color(name, scheme)], 7);
    }
    it('the code surface is opaque', () => {
      expect(color('solid', scheme)[3]).toBe(1);
      expect(color('diff-add', scheme)[3]).toBe(1);
      expect(color('diff-del', scheme)[3]).toBe(1);
    });
  });
}

describe('the cards', () => {
  it('are translucent and the code surface is not', () => {
    for (const scheme of ['light', 'dark'] as const) {
      expect(color('card', scheme)[3]).toBeLessThan(1);
      expect(color('solid', scheme)[3]).toBe(1);
    }
  });
});
