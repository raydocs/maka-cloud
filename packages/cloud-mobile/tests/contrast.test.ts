import { DARK, type Palette, LIGHT } from '@/lib/theme';

/**
 * The palette is the web's (cloud-web/src/tokens.css); this checks the pairs the app shows
 * together, on both schemes, with a card over each end of the background gradient. Text must reach
 * 7:1, muted text and accents 4.5:1.
 */
const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const parse = (color: string): [number, number, number, number] => {
  if (color.startsWith('#')) {
    const n = Number.parseInt(color.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = /rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/u.exec(color);
  if (!m) throw new Error(`Unreadable color ${color}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
};
const over = (top: string, below: string) => {
  const [r, g, b, a] = parse(top);
  const [br, bg, bb] = parse(below);
  return `#${[r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)]
    .map((v) => Math.round(v).toString(16).padStart(2, '0'))
    .join('')}`;
};
const luminance = (color: string) => {
  const [r, g, b] = parse(color);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe.each([DARK, LIGHT])('%#', (p: Palette) => {
  const surfaces = [p.bgTop, p.bgBottom].flatMap((bg) => {
    const card = over(p.card, bg);
    return [card, over(p.chip, card)];
  });
  test(`${p.scheme}: text on cards and chips is readable at both ends of the background`, () => {
    for (const s of surfaces) {
      expect(ratio(p.ink, s)).toBeGreaterThanOrEqual(7);
      expect(ratio(p.inkMuted, s)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(p.accent, s)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(p.ok, s)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(p.warn, s)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(p.bad, s)).toBeGreaterThanOrEqual(4.5);
    }
  });
  test(`${p.scheme}: buttons, the send button and code read well and code is opaque`, () => {
    expect(ratio(p.onAccent, p.accent)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(p.onPillOn, p.pillOn)).toBeGreaterThanOrEqual(7);
    expect(ratio(p.solidInk, p.solid)).toBeGreaterThanOrEqual(7);
    expect(ratio(p.solidMuted, p.solid)).toBeGreaterThanOrEqual(4.5);
    expect(p.solid.startsWith('#')).toBe(true);
  });
});
