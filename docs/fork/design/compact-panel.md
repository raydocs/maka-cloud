# The compact panel

The phone app is three sections (Home, Chat, Projects) under a floating glass top bar, with the
same floating glass composer at the bottom of each. Every screen, the chat included, follows the
person's appearance: light by day, dark at night. The app speaks Simplified Chinese first, with
Traditional Chinese and English. This note says what the look is, where its ideas came from, what is
ours, which tokens carry it, how the language works, and what comes next.

## The look

- **No bottom tab bar.** A floating top bar (`src/app/(tabs)/_layout.tsx`, expo-router's headless
  tabs from `expo-router/ui`):
  - in the middle, a glass pill with the three sections (首页 / 对话 / 项目, 首頁 / 對話 / 專案,
    Home / Chat / Projects); the chosen one sits on a filled capsule;
  - at the top left, a round glass Search button; at the top right, a round glass Me button.
  - Each segment has a fixed test id (`tab-home`, `tab-chat`, `tab-projects`), as do the corner
    buttons (`button-search`, `button-me`).
- **Me** (`src/app/me.tsx`, a sheet) holds what Settings held: appearance, language, devices and
  signing out. It also lists what the agent remembers (each fact can be forgotten) and the approvals
  it keeps (each can be revoked), from the client's `memory()` and `listGrants()`. A card is left out
  where the server has no such feature. There is no "connections" card: the client has no API for
  connectors yet.
- **Home** (`src/app/(tabs)/index.tsx`, built by `todayOf` in `src/lib/today.ts`) is the day's
  page, from the cards the server keeps (`/v1/home`, #385) in the server's order. From the top:
  - the date and a greeting by the phone's clock (`home-today-title`);
  - what needs the person (`home-waiting-N`), the only place for the attention colour;
  - what is working now: running, queued or paused top-level tasks, with the live line. These come
    from the five most recent conversations (the same tasks the feed reads for results; the server
    has no list of running work), read again every 15 seconds while Home is on screen and something
    works;
  - since you were last here: finished tasks and the server's notes;
  - what runs next;
  - on a quiet day, idea chips (`startersFor` in `src/lib/ideas.ts`): fix the tests in the person's
    first project, review the pull requests in their second (or the same one), and pick up their
    latest named conversation. A project idea fills the composer; the conversation idea opens it.
    With no project and no named conversation, the three fixed chips.

  A part with nothing in it is left out. A card whose item, task or duty the phone has not read is
  left out too, and is not reported as seen. On a server without `/v1/home`, the same page is built
  from the feed's own parts. There is no pitch text: the composer starts work.
  - **Seen.** Leaving Home (another section, or the app going to the background while Home is on
    screen) sends `POST /v1/home/seen` with the cards shown, at most 100, once per visit. An
    `inactive` blip (a system sheet) does not count.
- **Projects** (`src/app/(tabs)/projects.tsx`) lists the repositories from `listProjects()`, the
  same call as the web's Projects page, each with its default branch and its standing duties (on, off,
  or waiting for approval). Read-only here; duties are switched on the web. A server without projects
  says so.
- **Search** (`src/app/search.tsx`, a sheet) filters what the phone already has: conversation titles,
  and the titles and outcomes of the tasks in the 20 most recent conversations (read with the same
  `listTasks` call Home makes). There is no search endpoint. A hit opens its conversation in Chat.
- **The floating composer** (`src/components/Composer.tsx`): a round glass "+" and a glass message
  field with the send button, grouped in a `GlassContainer` so they blend as one control. "+" opens
  a sheet with "New conversation" and the conversations in three groups, each newest first: Needs
  you (an open decision), Working (a top-level task running, paused or waiting to start) and Recent.
  Each row's second line is its state, from the open inbox items and the tasks of the 20 most
  recent conversations, read anew each time the sheet opens (nothing from an earlier opening is
  shown); a row whose tasks were not read has no state line. In Chat the composer continues the open conversation. On Home and Projects it starts a new
  one and shows it in Chat. With no conversation open, Chat shows one opening line and the same
  ideas as Home above it, and the first message starts a conversation.
- **Talking to a running task** (`src/lib/steer.ts`). While a top-level task in the open
  conversation is still going, a "To the running task" chip sits above the composer, on by default;
  one tap turns it off and sending goes to the conversation again. On, sending calls
  `sendTaskMessage`, and the message shows on the person's side marked as going to the task. Its
  state is said only as far as the server says it:
  - *Sent*: the request is on its way.
  - *Received*: the server holds it (`pending`) and the task is running: the agent reads it after
    the step under way.
  - *Queued for the next turn*: `pending`, and the task is paused or waiting to start.
  - *Being worked in*: `delivered` while the task runs; *read* when it is paused or has ended.
  - *Taken back*, and *not read* (`unseen`, or a task that ended with it pending, settled from the
    task's timeline counts when they can tell; any withdrawn message makes "read" undecidable).

  "Take back" (`withdrawTaskMessage`) is offered only while it is pending: by the composer for the
  latest message, and on the bubble of each earlier one. A take-back the server refuses (409) does
  not assume the message was read; the phone asks where it stands. The phone asks again by sending
  the same message id and words, which the server answers without applying twice: when the task
  shows a new step (at most every 8 seconds) and every 20 seconds, one request a round (the oldest
  unread message of one task, the tasks taken in turn), only while Chat is in front and the app is
  active, and not at all
  for a minute after a 429, so Stop and Take back keep the shared control budget. A refused first
  send gives the words back to the box and turns the chip off; a refused resend keeps the message,
  failed, with "Delete".
- **Status lines in the dock.** While the stream is not live, the connection is its own line
  ("Reconnecting…" or "Offline"), with "The work keeps going on the server. Nothing needs
  resending." under it, and the running task's state is its own line, as last seen. A stop the
  machine has not confirmed (`stopPending`) is a third line. Nothing in them uses the attention
  colour, so a dropped connection never reads as a failure. Decision cards none of which can be
  seen (below the composer, or scrolled up under the top bar) show an "N waiting" chip by the composer, N
  counting only those; a tap scrolls to the first of them.
- **The working clock.** A work block that is running shows "Working for m:ss" from the earliest
  start of its running tasks, ticking each second. Only the digits change, with or without Reduce
  Motion. A paused task has no clock: the task view has no paused spans to subtract.
- **Approval receipts** restate how far an approval answered on this phone reaches (once, this
  task, this repository), only once the server took that answer; one refused, or answered
  elsewhere, states no reach. One that is kept links to Me, where it can be revoked.
- **Content scrolls under both bars** and fades out into the sky's colour at each end (`TopFade`,
  `Dock` and `clearOf` in `theme.ts`). There are no divider lines.
- **Liquid Glass on the floating controls.** The top pill, the corner buttons, "+" and the field
  are the system's Liquid Glass on iOS 26 and later (`expo-glass-effect`, gated by
  `isLiquidGlassAvailable()` and `isGlassEffectAPIAvailable()`). Cards are glass too. On Android,
  older iOS and the web preview the same shapes use an `expo-blur` blur under the `glass` fill.
  Chips stay plain fills, because glass on glass is what Apple's guidance says to avoid.
- **Reduce Transparency.** When the system setting is on, glass and cards become the opaque
  `solid` fill with a `solid-line` edge (`tests/rich.test.tsx`, `tests/contrast.test.ts`).
- **The chat follows the appearance.** The always-black chat slab is gone. An earlier version of
  this note kept the chat on an opaque dark slab in both appearances, for one fixed contrast and one
  colour for the fades to end in. The owner reversed that: the chat now reads the same two tones as
  every other screen. Contrast is checked for both schemes, and each fade ends in the sky colour at
  its own edge.

### Hark's principles, in our own shapes

From `docs/fork/design/hark-patterns.md`, principles only (no Hark fonts, icons, shapes or colours):

- **Two tones.** Ink on a surface, swapped at night (`LIGHT`, `DARK`).
- **One attention colour,** `warn`, used only for what needs the person: a waiting decision, a
  dropped connection, a duty waiting for approval. Done is a filled ink dot, failed an ink ring, and
  anything at rest a faint ring (`StatusMark`).
- **Weights.** Body text is regular; titles and headings are semibold. Each card has one semibold
  line. Buttons are medium.
- **A metadata line on work items.** A small line in tabular figures under each task: when it
  started, who is doing it, and the latest tool its run shows (`14:05 · Maka · 测试`).
- **One icon family.** Thin line symbols (SF Symbols at the light weight, Material Symbols on
  Android and the web) at one size, `ICON` (18 pt).
- **A living "thinking" mark of our own.** While the agent works, a dot whose halo slowly widens and
  fades (`Thinking`). Under Reduce Motion it is a still dot.

### From the Today study (`/tmp/today-ux-study.md`, principles only)

- **Only what is known.** No "spend not reported" tile or dash, no "0 running", no cost line until
  one is reported, and a finished task's summary is not repeated under its result card.
- **Five type sizes**: title 22, heading 17, body 16, secondary 14 and caption 12. Chinese gets
  line heights of about 1.6 times the size. Lines break with `lineBreakStrategyIOS="push-out"` and
  `textBreakStrategy="balanced"`, so a paragraph does not end on one lone character.
- **Chinese punctuation and spacing.** The zh-Hans and zh-Hant catalogues use full-width
  punctuation after Chinese (？！：，；) and a space between Chinese and Latin letters or digits. A
  test catches both (`tests/polish.test.tsx`).
- **A smaller result card.** The picture is a thumbnail beside its caption, and the diff and files
  are quiet rows. There are at most two buttons, each as wide as its label; a link's host is in its
  spoken name, not its label. The pages the task opened fold into one "Sources (N)" line.
- **Card answers** are label-sized pills in a wrapping row. Approving taps lightly; refusing or
  stopping buzzes a warning (`expo-haptics`).
- **Sign-in.** The server address and "Use another server" wait behind "Advanced". The invite token
  is a small link, and a disabled main button is a faint outline, not a grey slab.
- **Motion.** A short thin rule that breathes under the working line and the current step (the
  words themselves never fade, so they keep their contrast), and a soft spring for messages and
  cards that arrive while the chat is open (not for the history). Both are off under Reduce Motion,
  and so is the slide of the conversation sheet.

### The chat shows the work (`src/components/Work.tsx`, `src/lib/work.ts`)

- **One work block per message the person sends.** The chat is in time order (messages carry the
  server's `at`): under each message, the steps of the tasks it started. While they run: the
  thinking mark and one live line (the running task's narration, else its current step), and a row
  per panel (tests, the change, the review) with its fixed summary in tabular figures and a spinner
  that becomes a check or a cross. A task without panels lists the steps it noted, with no outcome
  mark, because a noted step says nothing about how it went. Done, the block folds to one line,
  "Worked for 4 min · 6 steps", that opens again. The runner's fixed lines, titles and summary
  shapes are in all three languages; anything else is shown as sent.
- **Task pills.** Each task is a pill with its live mark (spinner, check, cross, or the attention
  dot while a card waits on the person) and its state; a tap opens its row with the controls. A
  result card carries "From task", which goes back to the pill.
- **Instant acknowledgement.** A sent message is in the list at once with "Sending…" (dimmed only
  after two seconds), then the working line. A failed send says "Not sent" with "Send again" (the
  same message id, so it runs once) and "Delete". It is kept (the client's `PendingSends`, in
  memory) when the person leaves the conversation, and is taken off once the stream shows a new
  message of theirs with the same words: the server names a message by its own id, not the send's.
- **The approval card in fixed slots:** what will happen, what it touches (the `Repository:`,
  `Branch:` and `Base branch:` lines the card itself carries), the exact text and held call as
  sent, evidence badges (the task's panels, its files and links), and the scope (once, this task,
  this repository) when the server offers it (#381). One "Go ahead" pill answers with the chosen
  scope; only the recommended answer is filled. Changing scope ticks a selection haptic; approving
  taps lightly; refusing buzzes a warning. An answered card is a one-line receipt; on an approval,
  "Details" opens the exact text and held call again.
- **Not sent by the server, so not shown:** a turn of the conversation's own (its model calls) has
  no events, so a message that started no task shows only "working" until the reply; the time an
  answer was given is not kept, so the receipt has none. Not built yet: a row does not open its
  panel's tail, though the server sends it.

## Language

Three languages: 简体中文, 繁體中文 and English. Simplified Chinese is the main language and the
fallback.

- **Detection** (`languageFor` in `src/lib/i18n.tsx`, from the first of the phone's preferred
  languages, read with `expo-localization`):
  - `zh-Hant`, `zh-TW`, `zh-HK` and `zh-MO` get Traditional Chinese;
  - `zh-Hans`, `zh-CN`, `zh-SG` and plain `zh` get Simplified Chinese;
  - `en-*` gets English;
  - anything else gets Simplified Chinese.
- **The picker.** Me has a Language card. Its first option, the default, is to use the phone's
  language (跟随系统 / 跟隨系統 / Use phone language). Then come the three languages, each named in
  its own words. A language picked is kept on the device (the secure store, `maka.language`) and
  wins over detection. Picking the phone's language removes it, and detection decides again.
- **Catalogues.** `src/lib/strings.ts` holds every string the app shows in English (`EN`) and
  Simplified Chinese (`ZH`); `src/lib/strings.hant.ts` holds the Traditional Chinese (`ZH_HANT`).
  That covers sign-in, errors, empty states and accessibility labels, keyed and with `{name}` values.
  - Traditional Chinese uses Taiwan's words (軟體, 訊息, 帳號, 設定, 檔案, 網路, 登入, 連結, 資料,
    伺服器, 儲存庫), which Hong Kong and Macau read as well. It is a translation, not a character
    conversion, and nothing falls back to Simplified.
  - `useT().t(key, values)` reads the catalogues. A test checks that all three have the same keys,
    no empty value and the same values to fill in.
- **Words from the shared logic.** `packages/cloud-client` is shared with the web app and returns
  finished English (connection states, error sentences, inbox headings, "in 5 min"). The phone
  does not change it: `useT().tx(text)` looks such text up in `PHRASES_ZH` and `PATTERNS_ZH`
  (`PHRASES_HANT` and `PATTERNS_HANT` for Traditional). Anything not listed, which is everything the
  server or the agent wrote, is shown exactly as sent.
- **Decision choices.** The server's fixed choices (the supervisor's rules and the conductor's
  approval card) are product words. Matched on id and exact label, they come from the catalogue in
  both Chinese languages. Any other choice is shown as sent.
- **Device tests.** Buttons, fields and sections carry fixed English test ids (`button-Continue`,
  `field-Code`, `home-waiting-1`, `details-outcome`, `tab-home`), so the Maestro flows do not read
  the labels. Builds made with `MAKA_E2E=1` are also fixed to Chinese (`extra.language`;
  `MAKA_LANG` overrides it).
- **iOS.** `CFBundleDevelopmentRegion` is `zh-Hans` and `CFBundleLocalizations` lists `zh-Hans`,
  `zh-Hant` and `en`, so the system's own words (the share sheet, the keyboard's buttons) follow.

## Where it came from

The reference is Telos, cellier's desktop agent app, seen in screen recordings the owner shared
(the latest shows its top bar). It is a proprietary product, so we took principles only, listed in
`docs/fork/THIRD_PARTY.md`. No assets, mascot, icons, copy, screenshots or exact layouts are used,
and the recordings are not in this repository.

| Principle | From the reference | Ours |
|---|---|---|
| A glass pill of sections at the top | yes | our three sections, the filled capsule, the test ids |
| A round button per corner | yes | Search and Me |
| A floating composer: round "+" and a pill field | yes | "+" opens new conversation and the list; the send button sits in the field |
| Fades instead of hard edges | yes | the fade components, ending in the sky's own colour |
| A made file as one line, icon and name | yes | which files are listed, and opening them inert |
| Rounded two-column cards | yes (its notes app) | tiles for ideas, numbers and recent conversations |
| A dark compact panel | yes | no longer taken: the chat follows the appearance |

The rest is the Hark look we already had (`docs/fork/design/hark-patterns.md`,
`packages/cloud-design/README.md`): the sky gradient, frosted cards, one filled pill for the
selected item, few type sizes. The Today study adds the principles listed above.

## Tokens

Unchanged in `packages/cloud-design/src/tokens.ts`. The `panel-*` tokens remain for the web, but
the phone no longer reads them. The phone uses `glass` (the blur fallback's fill), `bg-top-clear`
and `clearOf` (where a fade ends), `radius.tile` (28, cards and tiles) and `radius.panel` (36, the
sheets). `tests/contrast.test.ts` checks both schemes: text 7:1, muted and status colours 4.5:1 on
cards, chips and glass fills, and the Reduce Transparency fill.

## Dependencies

`expo-localization` 58.0.5 (MIT, a native module of the Expo SDK) is new, for the phone's
preferred languages. `expo-blur`, `expo-linear-gradient`, `expo-glass-effect`, `expo-haptics`,
`expo-symbols` and expo-router's headless tabs (`expo-router/ui`) were already dependencies.

## Not checked here

The web preview cannot draw Liquid Glass, so its screenshots show the blur fallback. Three things
are for the iOS simulator run in CI and a look on a phone:
- the glass itself and the `GlassContainer` blending;
- Reduce Transparency and Reduce Motion on a device;
- the haptics.

## Next (planned, not built)

1. **The web.** The same top pill and corner buttons for the web at narrow widths, from the same
   tokens.
2. **Voice mode with a caption pill.** While the agent speaks, one glass pill near the bottom shows
   the current sentence. It needs the dictation and speech stream first, and must respect reduced
   motion (no caption animation then).
3. **Richer Home cards.** A short preview per result and a thumbnail when there is a picture,
   once the server sends them. Moving a card (`moveHomeCard`) is not offered on the phone yet.
4. **Connections in Me,** once the client has a connectors API.
5. **The web app in Chinese.** The web shows the shared logic's English today. Moving those
   sentences into a shared catalogue would let both apps drop `PHRASES_ZH`.
