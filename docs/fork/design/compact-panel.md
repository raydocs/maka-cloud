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
- **Projects** (`src/app/(tabs)/projects.tsx`) lists the repositories from `listProjects()`, the
  same call as the web's Projects page, each with its default branch and its standing duties (on, off,
  or waiting for approval). Read-only here; duties are switched on the web. A server without projects
  says so.
- **Search** (`src/app/search.tsx`, a sheet) filters what the phone already has: conversation titles,
  and the titles and outcomes of the tasks in the 20 most recent conversations (read with the same
  `listTasks` call Home makes). There is no search endpoint. A hit opens its conversation in Chat.
- **The floating composer** (`src/components/Composer.tsx`): a round glass "+" and a glass message
  field with the send button, grouped in a `GlassContainer` so they blend as one control. "+" opens
  a sheet with "New conversation" and the conversation list. In Chat the composer continues the open
  conversation. On Home and Projects it starts a new one and shows it in Chat. With no
  conversation open, Chat shows one opening line and three ideas above it, and the first message
  starts a conversation.
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
3. **A notes-style Home.** Home as a grid of rounded cards (date, title, two-line preview) for
   decisions, results and runs, once the server sends a short preview per item. Today a
   conversation has only a title and a start time.
4. **Connections in Me,** once the client has a connectors API.
5. **The web app in Chinese.** The web shows the shared logic's English today. Moving those
   sentences into a shared catalogue would let both apps drop `PHRASES_ZH`.
