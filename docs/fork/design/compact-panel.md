# The compact panel

The phone app's conversation sits on one dark rounded slab over the sky, with Liquid Glass controls
floating on it and the system's own tab bar below. Home and Settings stay on the light sky with
glass cards. The app speaks Simplified Chinese first, with Traditional Chinese and English. This note says what the look is, where its
ideas came from, what is ours, which tokens carry it, how the language works, and what comes next.

## The look

- **Liquid Glass first.** Every glass surface is the system's Liquid Glass on iOS 26 and later
  (`expo-glass-effect`, gated by `isLiquidGlassAvailable()` and `isGlassEffectAPIAvailable()`):
  - the tab bar is expo-router's `NativeTabs`, the system's own bar (Liquid Glass on iOS, Material
    on Android);
  - the composer's field pill and its conversation-list button are `GlassView`s with
    `isInteractive`, grouped in a `GlassContainer` so they blend as one floating control;
  - the round glass buttons (`GlassButton`) are interactive glass;
  - Home's and Settings' cards are glass.
  On Android, older iOS and the web preview the same shapes are an `expo-blur` blur under the
  `glass` fill. Chips stay plain fills: they sit inside glass cards, and glass on glass is what
  Apple's guidance says to avoid.
- **Reduce Transparency.** When the system setting is on (`AccessibilityInfo`), glass and cards
  become opaque: `solid` with a `solid-line` edge on the sky, `panel-raised` on the panel. Tested
  in `tests/rich.test.tsx` and `tests/contrast.test.ts`.
- **The panel: a dark slab, not tinted glass.** The chat is a near-black slab (`panel`,
  `#0b0b0c`), inset 8 pt from the sides and bottom, 36 pt radius (`radius.panel`), faint rim.
  We tried a dark-tinted Liquid Glass slab and kept the opaque one:
  - Liquid Glass takes its colour from whatever is behind it and adds its own highlights, so its
    final colour cannot be pinned, and a contrast test cannot hold it to 4.5:1.
  - Worked out at a 90% tint over the lightest sky, body text passes only before the glass's own
    highlight is counted, and muted text on the chips inside the cards fails first.
  - The fades need one known solid colour to fade into.
  So the slab stays opaque and the glass is on the controls floating over it.
  Everything inside reads the panel palette (`PANEL` in `packages/cloud-mobile/src/lib/theme.ts`):
  white ink (`panel-ink`), a muted grey (`panel-muted`), and the dark scheme's status colours and
  buttons. An answer's `**bold**` lead-ins are drawn bold.
- **Fades, no edges.** Content scrolls under the composer and fades out (`Fade`, a gradient from
  the ground colour to the same colour at no opacity: `panel-clear` in the panel). No divider
  lines.
- **The floating composer.** A round glass button opens the conversation list (when there is more
  than one conversation) and a glass field pill holds the message and the send button. A dropped
  connection shows as one small line above it.
- **Quiet results.** Any file a finished task made, other than its pictures and the diff the card
  already offers, is one line under the result: a small file icon and the name. A tap opens it
  as inert text (or the picture, or the diff) in the viewer. The pages a task opened are plain
  rows.
- **Tiles on Home.** The first-visit ideas, the "since you were last here" numbers and the recent
  conversations are rounded tiles two to a row (`Tiles`, `Tile`, `radius.tile` 28 pt). Cards are
  28 pt round too.

### Light and dark

The panel is the same dark slab in both appearances. It is the point of the look, its contrast is
checked once, and a light slab would make the chat read like the rest of Home. In light mode the
sky around it stays light; in dark mode the slab sits on the night sky with its rim. Settings says
so under Appearance. The task page opened from a result keeps the person's own appearance.

## Language

Three languages: 简体中文, 繁體中文 and English. Simplified Chinese is the main language and the
fallback.

- **Detection** (`languageFor` in `src/lib/i18n.tsx`, from the first of the phone's preferred
  languages, read with `expo-localization`):
  - `zh-Hant`, `zh-TW`, `zh-HK` and `zh-MO` get Traditional Chinese;
  - `zh-Hans`, `zh-CN`, `zh-SG` and plain `zh` get Simplified Chinese;
  - `en-*` gets English;
  - anything else gets Simplified Chinese.
- **The picker.** Settings has a Language card with the three languages, each named in its own
  words. The choice is kept on the device (the secure store, `maka.language`) and wins over
  detection from then on.
- **Catalogues.** `src/lib/strings.ts` holds every string the app shows in English (`EN`) and
  Simplified Chinese (`ZH`); `src/lib/strings.hant.ts` holds the Traditional Chinese (`ZH_HANT`).
  That covers sign-in, errors, empty states and accessibility labels, keyed and with `{name}` values.
  - Traditional Chinese uses Taiwan's words (軟體, 訊息, 帳號, 設定, 檔案, 網路, 登入, 連結, 資料,
    伺服器, 存放庫), which Hong Kong and Macau read as well. It is a translation, not a character
    conversion, and nothing falls back to Simplified.
  - `useT().t(key, values)` reads the catalogues. A test checks all three have the same keys, no
    empty value and the same values to fill in.
- **Words from the shared logic.** `packages/cloud-client` is shared with the web app and returns
  finished English (connection states, error sentences, inbox headings, "in 5 min"). The phone
  does not change it: `useT().tx(text)` looks such text up in `PHRASES_ZH` and `PATTERNS_ZH`
  (`PHRASES_HANT` and `PATTERNS_HANT` for Traditional). Anything not listed, which is everything the
  server or the agent wrote, is shown exactly as sent.
- **Decision choices.** The server's fixed choices (the supervisor's rules and the conductor's
  approval card) are product words: matched on id and exact label, they come from the catalogue in
  both Chinese languages. Any other choice is shown as sent.
- **Type.** The system face in every language (PingFang SC or TC on iOS). Chinese text gets
  line heights of about 1.5 to 1.6 times the size (`CJK` in `ui.tsx`); no language
  sets letter spacing. Text scales with the system size.
- **Device tests.** Buttons and fields carry fixed English test ids (`button-Continue`,
  `field-Code`, `home-waiting-1`, `details-outcome`, `tab-home`), so the Maestro flows do not read
  the labels. Builds made with `MAKA_E2E=1` are also fixed to Chinese (`extra.language`;
  `MAKA_LANG` overrides it), and the one text the flows still tap, the Home tab, is `首页`.
- **iOS.** `CFBundleDevelopmentRegion` is `zh-Hans` and `CFBundleLocalizations` lists `zh-Hans`,
  `zh-Hant` and `en`, so the system's own words (the share sheet, the keyboard's buttons) follow.

## Where it came from

The reference is Telos, cellier's desktop agent app, seen in screen recordings the owner shared.
It is a proprietary product: we took principles only, listed in `docs/fork/THIRD_PARTY.md`. No
assets, mascot, icons, copy, screenshots or exact layouts are used, and the recordings are not in
this repository.

| Principle | From the reference | Ours |
|---|---|---|
| A dark compact panel with large radii | yes | the values, the panel palette, how it sits on our sky |
| Fades instead of hard edges | yes | the fade component and its tokens |
| A floating composer: round glass button and pill field | yes | the button opens the conversation list; the send button sits in the field |
| A made file as one line, icon and name | yes | which files are listed, and opening them inert |
| Rounded two-column cards | yes (its notes app) | tiles for ideas, numbers and recent conversations |
| A glass pill of sections at the top | yes | not taken: the system tab bar has the real Liquid Glass |
| A round button per corner | yes | not taken: a corner button over the chat would cover the result card's Details button |

The rest is the Hark look we already had (`docs/fork/design/hark-patterns.md`,
`packages/cloud-design/README.md`): the sky gradient, frosted cards, one dark pill for the
selected item, few type sizes.

## Tokens

Added in `packages/cloud-design/src/tokens.ts`; no existing token changed, so the web app looks
the same (its `tokens.css` gains the new custom properties, unused there).

| Token | Light | Dark | Use |
|---|---|---|---|
| `panel` | `#0b0b0c` | `#0b0b0c` | the slab |
| `panel-ink` | `#f4f4f6` | `#f4f4f6` | text on the slab |
| `panel-muted` | `#a6a6ae` | `#a6a6ae` | muted text on the slab |
| `panel-glass` | white at 10% | white at 10% | the blur fallback's fill on the slab |
| `panel-raised` | `#2c2c30` | `#2c2c30` | a glass control on the slab with Reduce Transparency on |
| `panel-clear` | `#0b0b0c` at 0% | same | where a fade on the slab ends |
| `glass` | white at 55% | white at 10% | the blur fallback's fill on the sky |
| `bg-top-clear` | `bg-top` at 0% | same | where a fade on the sky ends |
| `radius.tile` | 28 | | cards and tiles |
| `radius.panel` | 36 | | the slab |

`tests/contrast.test.ts` in cloud-mobile checks the panel palette like the other two (text 7:1,
muted and status colours 4.5:1 on its cards, chips and glass fills) and the Reduce Transparency
fills (`panel-raised`, `solid`).

## Dependencies

`expo-localization` 58.0.5 (MIT, a native module of the Expo SDK) is new, for the phone's
preferred languages. `expo-blur`, `expo-linear-gradient`, `expo-glass-effect` and `expo-symbols`
were already dependencies.

## Not checked here

The web preview cannot draw Liquid Glass; its screenshots show the blur fallback and a plain bottom
bar. The glass itself, the `GlassContainer` blending and Reduce Transparency on a device are for the
iOS simulator run in CI and a look on a phone.

## Next (planned, not built)

1. **The web panel.** The same slab for the web chat at narrow widths, and as a docked panel
   beside Home on wide screens, from the same tokens (`--panel`, `--panel-glass`, `--radius-panel`
   already exist in `tokens.css`).
2. **Voice mode with a caption pill.** While the agent speaks, one dark glass pill near the bottom
   shows the current sentence; the panel dims behind it. It needs the dictation and speech stream
   first, and must respect reduced motion (no caption animation then).
3. **A notes-style Home.** Home as a grid of rounded cards (date, bold title, two-line preview)
   for decisions, results and runs, once the server sends a short preview per item; today a
   conversation has only a title and a start time.
4. **The web app in Chinese.** The web shows the shared logic's English today; moving those
   sentences into a shared catalogue would let both apps drop `PHRASES_ZH`.
