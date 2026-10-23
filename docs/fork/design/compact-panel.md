# The compact panel

The phone app's conversation sits on one dark rounded slab over the sky, with the sections in a
glass pill at the top and a composer floating at the bottom. Home and Settings stay on the light
sky with frosted cards. This note says what the look is, where its ideas came from, what is ours,
which tokens carry it, and what comes next.

## The look

- **The panel.** The chat is a near-black slab (`panel`, `#0b0b0c`), inset 8 pt from the screen's
  sides and bottom, with a 36 pt radius (`radius.panel`) and a faint rim. Everything inside reads
  the panel palette (`PANEL` in `packages/cloud-mobile/src/lib/theme.ts`): white ink
  (`panel-ink`), a muted grey (`panel-muted`), and the dark scheme's status colours and buttons.
  Body text is 16 pt with a 24 pt line height; an answer's `**bold**` lead-ins are drawn bold.
- **The section pill.** Home, Chat and Settings are tabs in one translucent pill at the top of
  every screen (`TopBar`): Liquid Glass on iOS 26 and later, a blur under the `glass` fill
  elsewhere. On the sky the open section is the one dark pill (`pill-on`), as Hark does it; over
  the panel it is a lighter glass pill (`panel-glass-on`). Each segment is a 44 pt tab with its
  selected state, and Maestro still taps "Home" by its text.
- **Fades, no edges.** Content scrolls under the pill and the composer and fades out
  (`Fade`, a gradient from the ground colour to the same colour at no opacity: `panel-clear`
  in the panel, `bg-top-clear` on the sky). No divider lines.
- **The floating composer.** A round glass button opens the conversation list (when there is more
  than one conversation) and a pill-shaped glass field holds the message and the send button. A
  dropped connection shows as one small line above it.
- **Quiet results.** Any file a finished task made, other than its pictures and the diff the card
  already offers, is one line under the result: a small file icon and the name. A tap opens it
  as inert text (or the picture, or the diff) in the viewer. The pages a task opened lost their
  chip background and are plain rows.
- **Tiles on Home.** The first-visit ideas, the "since you were last here" numbers and the recent
  conversations are rounded tiles two to a row (`Tiles`, `Tile`, `radius.tile` 28 pt): a small
  line above (the day a conversation began), a bold title below. Cards are 28 pt round too.

### Light and dark

The panel is the same dark slab in both appearances. It is the point of the look, its contrast is
checked once, and a light slab would make the chat read like the rest of Home. In light mode the
sky around it stays light; in dark mode the slab sits on the night sky with its rim. Settings says
so under Appearance. The task page opened from a result keeps the person's own appearance.

## Where it came from

The reference is Telos, cellier's desktop agent app, seen in screen recordings the owner shared.
It is a proprietary product: we took principles only, listed in `docs/fork/THIRD_PARTY.md`. No
assets, mascot, icons, copy, screenshots or exact layouts are used, and the recordings are not in
this repository.

| Principle | From the reference | Ours |
|---|---|---|
| A dark compact panel with large radii | yes | the values, the panel palette, how it sits on our sky |
| A glass pill of sections, the selected one filled | yes | our three sections; Hark's dark pill on the sky |
| Fades instead of hard edges | yes | the fade component and its tokens |
| A floating composer: round glass button and pill field | yes | the button opens the conversation list; the send button sits in the field |
| A made file as one line, icon and name | yes | which files are listed, and opening them inert |
| Rounded two-column cards | yes (its notes app) | tiles for ideas, numbers and recent conversations |
| A round button per corner | yes | not taken here: a corner button over the chat would cover the result card's Details button |

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
| `panel-glass` | white at 10% | white at 10% | glass controls on the slab |
| `panel-glass-on` | white at 24% | white at 24% | the selected section on the slab |
| `panel-clear` | `#0b0b0c` at 0% | same | where a fade on the slab ends |
| `glass` | white at 55% | white at 10% | glass controls on the sky |
| `bg-top-clear` | `bg-top` at 0% | same | where the fade under the section pill ends |
| `radius.tile` | 28 | | cards and tiles |
| `radius.panel` | 36 | | the slab |

`tests/contrast.test.ts` in cloud-mobile checks the panel palette like the other two (text 7:1,
muted and status colours 4.5:1 on its cards, chips and glass) and the section pill's ink on both
glass fills.

## Dependencies

None added. `expo-blur`, `expo-linear-gradient`, `expo-glass-effect` and `expo-symbols` were
already dependencies. The system tab bar (`NativeTabs`) gave way to expo-router's JavaScript tabs
with our own bar, so the iOS tab bar's Liquid Glass and Android's Material bar are gone; the pill
uses Liquid Glass itself where the system has it.

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
