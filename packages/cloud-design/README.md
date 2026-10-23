# @maka-cloud/design

The look of the web app and the phone apps, defined once in `src/tokens.ts`: colors for the light
and dark schemes, the type scale, radius, spacing, blur and motion.

```sh
npm --prefix packages/cloud-design run generate   # writes the two files below
npm --prefix packages/cloud-design run check      # fails if either is stale (CI runs this)
npm --prefix packages/cloud-design test
```

| Generated file | Used by |
| --- | --- |
| `packages/cloud-web/src/tokens.css` | every rule in `styles.css`, as `var(--…)` |
| `packages/cloud-mobile/src/lib/tokens.generated.ts` | `src/lib/theme.ts` (`LIGHT`, `DARK`, `radius`) |

Never edit a generated file by hand. Change `src/tokens.ts`, regenerate, and run cloud-web's
`tests/contrast.test.ts` and cloud-mobile's `tests/contrast.test.ts`: both check every pair of colors
shown together, on both schemes.

## The rules

- **A calm sky, glass on top.** The page is one soft gradient with two faint lights. Cards are
  translucent and blurred, with no hard border; `card-strong` is for things that float above other
  content (the composer, the message field). Code, diffs and test output sit on opaque `solid`
  surfaces, never glass.
- **One dark pill.** What is selected (the open section, the chosen mode, the send button) is a
  `pill-on` pill. The accent color is for links and the one action a card asks for.
- **One family, six sizes, two weights.** Inter at `--t-xs` 12 to `--t-hero` 40, regular for reading
  and medium for everything you act on. Hierarchy comes from size and space, not bold and boxes.
- **No raw values in components.** Colors, sizes, radii and durations come from tokens. If one is
  missing, add it here.
- **Light first.** Light is the default on the web and the phones; dark is the same sky at night.
- **The compact panel.** The phone's conversation is one near-black slab (`panel`, `radius.panel`)
  in both schemes, with its own ink, glass controls (`panel-glass`, `panel-glass-on`) and fades
  that end in `panel-clear`; on the sky, controls use `glass` and fades end in `bg-top-clear`. See
  `docs/fork/design/compact-panel.md`.
