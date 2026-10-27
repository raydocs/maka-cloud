# cloud-mobile (T29)

The iOS and Android apps: one Expo codebase (expo-router, TypeScript) with the web app's screens and all of its
logic, not a web view. The logic is `packages/cloud-client` (the API client, the event stream, Home, sign-in,
the rules for how a decision is shown); this package is only the native screens and the device glue: the
Keychain/Keystore (`lib/secure.ts`), the server address (`lib/server.ts`), the session (`lib/session.tsx`) and
the look (`lib/theme.ts`, the web's palette).

- **Sign-in**: the server address (https; plain http only for this machine) and the invite token. The token is
  kept in `expo-secure-store` and nowhere else, and is never in a URL.
- **Sections**: Home, Chat and Projects, switched by a glass pill at the top (no bottom tab bar), with Search at
  the top left and Me (appearance, language, memory, kept approvals, devices, sign-out) at the top right. Every
  section has the same floating composer at the bottom. Decisions are one-tap cards; an approval is shown
  exactly as the server sent it and cannot be approved if it cannot be shown exactly. Never any model or vendor
  name.
- **Look**: follows the phone's appearance, or the choice in Me, everywhere including the chat. Cards are
  frosted (the system's Liquid Glass on iOS 26 and later, a blur elsewhere); anything that holds code is opaque;
  the floating controls are Liquid Glass (`docs/fork/design/compact-panel.md`).
- **Language**: 简体中文 (first, and the fallback), 繁體中文 (Taiwan's words) and English, from the phone's
  first language or the picker in Me, whose choice is kept on the device. The strings are in
  `lib/strings.ts` and `lib/strings.hant.ts`, read through `lib/i18n.tsx`; what the server or the agent
  wrote is shown as sent. Builds made with `MAKA_E2E=1` default to Simplified Chinese (`MAKA_LANG` overrides).
- **Notifications** (`lib/push.ts`, `lib/pushRouting.ts`): after sign-in, Home offers them once ("Turn on
  notifications" or "Not now"), and Me can turn them on or off. Nothing is asked of the phone before that tap.
  The Expo push token goes to the server (`POST /v1/push/devices`) and is removed on sign-out. A notification
  says only that a decision waits or a result is ready, and carries ids. Its actions are "Got it", "Not now"
  and "Open"; there is no Approve, because an approval is given only in the app, where its exact text shows.
  A tap opens the task (in Chat) or the decision (marked on Home); one for another account opens Home only.
- **Links** (`app/+native-intent.tsx`, `lib/links.ts`): `makacloud://task/<id>`, `makacloud://decision/<id>`
  and `makacloud://` (Home). A link carries only an id; anything else opens Home.
- Next (T29): the task page and the viewer; share; release profiles.

## Run and verify

Needs Node 22+. Not a root workspace (Expo and Metro do poorly inside the repository's workspace graph):

```sh
npm --prefix packages/cloud-client ci --workspaces=false
npm --prefix packages/cloud-mobile ci --workspaces=false
npm --prefix packages/cloud-mobile run typecheck
npm --prefix packages/cloud-mobile test          # jest-expo + React Native Testing Library
npm --prefix packages/cloud-mobile exec -- expo export --platform ios --platform android   # Metro bundles
```

Against the scripted stack the web tests use (the real server, a scripted runner, no model):

```sh
npm --prefix packages/cloud-web run stack         # api on 4174, control on 4175
node packages/cloud-mobile/scripts/e2e-seed.mjs http://127.0.0.1:4175 http://127.0.0.1:4174 decision
# in a simulator build made with MAKA_E2E=1:  maestro test .maestro/decision.yaml -e SERVER=... -e TOKEN=...
```

CI (`.github/workflows/fork-cloud-mobile.yml`) does this on a hosted macOS runner (iOS simulator, a release
build) and on Linux (an Android emulator), and keeps the screenshots as artifacts. `MAKA_E2E=1` only lets those
builds talk to the stack over plain http (`app.config.ts`); store builds never set it.

Not done by an agent, and listed for the owner: the Apple Developer account and bundle id (the one in
`app.config.ts` is provisional), App Store Connect, APNs; Google Play, the package name, FCM; the Expo account and
EAS project; signing keys and secrets (EAS only, set by the owner).

Notifications need the owner's part too: the EAS project (its id goes in `MAKA_EAS_PROJECT_ID` for the build;
without it the app says notifications are not available and asks the phone nothing), the APNs key and the FCM
project in that EAS project, `MAKA_CLOUD_EXPO_PUSH=1` on the server (and `MAKA_CLOUD_EXPO_ACCESS_TOKEN` if the
project requires one), and universal and App Links once the app's web domain is set.

`expo start --web` renders the same screens in a browser for review. A browser draws the blur fallback, never
Liquid Glass.
