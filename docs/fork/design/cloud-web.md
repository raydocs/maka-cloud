# cloud-web: the look and the shell (T24)

`packages/cloud-web` is the phone-first web app for one invite. This note records the pieces of T24 that
are in place; Home decisions and Projects follow in later pieces.

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

## Delivery

A finished top-level task arrives in Chat as one **result card** (`Delivery.tsx`): the first sentence of the
result summary, one visual, a caption, and at most two one-tap actions (the pull request, then the preview).

- The visual is the first screenshot artifact (a picture the server sniffed, piece 3), read once and shown
  from a local object URL; with no picture, the diff is the visual. Nothing is invented: no picture and no
  diff means a sentence and the actions only.
- Tapping it opens the **viewer** (`Viewer.tsx`): large over a blurred, dimmed page, close top left, collapse
  bottom right, a status pill beside them. Escape, either button or a swipe down goes back; focus moves in,
  stays in, and returns to what opened it. It is rendered in `document.body`: a card's backdrop filter would
  otherwise make the card the containing block of the fixed viewer and clip it. A diff opens the same way, on
  an opaque dense surface with added and removed lines marked.
- **Sources** are a fanned stack of up to three cards (about -5, 0 and +4 degrees, 215 by 190 px, the middle
  one on top; a horizontal swipe on a phone). Order: the pull request, the preview, the test report, then docs,
  sources, alternatives. The list comes from `GET /v1/tasks/:id/sources`; each card asks the server for its
  preview (title, and the page's image through the server's proxy). A page with no image is a plain card with
  the site's initial. The browser never contacts a site the task opened (an e2e test records every request).
- Text from the model is text: a markdown picture in a message is shown as the characters it is, and nothing
  is loaded for it (there is no markdown renderer; if one is added, images load only on tap).
- A running task shows one updating line, the latest `step: ` note the runner recorded from the agent's own
  todo list, that opens to the earlier steps. Terminal output stays inside the collapsed computer viewer.

## Tests

`tests/shell.test.tsx` (theme storage, navigation, Home, Settings, landing), `tests/contrast.test.ts`,
`tests/delivery.test.tsx` (card, viewer, stack, step line, text is text), Playwright `tests/e2e/delivery.spec.ts`
(a real server with a fake preview network: card, stack, viewer covering the screen, every way back, a diff
on an opaque surface, another invite's 404, no request to a task's site) and `tests/e2e/look.spec.ts` (desktop and phone width: no sideways scroll on Home, Chat and
Settings, the cards compute a blur and a translucent fill, a diff computes an opaque fill with no blur, the
scheme survives a reload, phone navigation targets are at least 44 px).
