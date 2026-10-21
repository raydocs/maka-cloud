# cloud-web: the look and the shell (T24)

`packages/cloud-web` is the phone-first web app for one invite. This note records the pieces of T24 that
are in place; the delivery card, Home decisions and Projects follow in later pieces.

## Look

- One background: a soft full-bleed gradient. Home and Chat sit on it as **frosted translucent cards**
  (`.card`: translucent fill, 1 px edge, soft shadow, `backdrop-filter: blur`). Where the browser has no
  backdrop filter the card falls back to a near-opaque fill, so nothing becomes unreadable.
- **Anything that holds code, a diff, test output or the computer viewer is opaque and dense** (`.solid`,
  `.artifact pre`, `.computer-viewer`): no blur, no tint, monospace, small.
- Controls are pills: the segmented navigation, the start and message fields (a floating pill with a round
  44 px send button), and Astryx's buttons (theme override `borderRadius: 9999px`).
- Dark is the default, light is one tap in Settings. The choice is kept in `localStorage` only (the page
  works with storage blocked) and `index.html` sets `data-theme="dark"` before the first paint.

## Tokens and contrast

All colors are tokens in `src/tokens.css`, each written once as `light-dark(light, dark)`. The Astryx theme in
`src/theme.tsx` carries the same accent, so Astryx's own controls match. `tests/contrast.test.ts` reads
`tokens.css` and checks WCAG ratios for every pair that is shown together, in both schemes, with a card laid
over each end of the background gradient (and chips over the card): text 7:1, muted text and accents 4.5:1,
code 7:1. A palette change that breaks reading fails that test; the code surface must also stay opaque.

## Shell

Signed-in screens share a header (brand and a segmented navigation: Home, Chat, Settings; Projects arrives
with piece 8). The navigation is full width on a phone and 44 px tall on touch screens.

- **Home**: the start sentence and the five latest conversations. A first visit lands here; someone with
  conversations lands in the latest chat.
- **Chat**: the conversation (messages, decisions, the inbox, the message field) beside the work (tasks,
  cost, results). The chat is one column on a phone, two from 1000 px.
- **Settings**: appearance, memory, notifications, and Disconnect. These moved out of the chat so the chat
  holds only the conversation and the work.

## Tests

`tests/shell.test.tsx` (theme storage, navigation, Home, Settings, landing), `tests/contrast.test.ts`, and
Playwright `tests/e2e/look.spec.ts` (desktop and phone width: no sideways scroll on Home, Chat and
Settings, the cards compute a blur and a translucent fill, a diff computes an opaque fill with no blur, the
scheme survives a reload, phone navigation targets are at least 44 px).
