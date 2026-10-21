# cloud-client (T29)

The logic the web app (`packages/cloud-web`) and the phone apps (`packages/cloud-mobile`) share, so a change is
made once: the API client and its event stream (`client.ts`), the server's contract (`contract.ts`), the event
reducer (`state.ts`), how things are put in words (`presentation.ts`, `errors.ts`) and how an inbox answer is
sent exactly once (`inboxAnswer.ts`).

The flows both clients run live here as plain classes that React reads through `useSyncExternalStore`
(`store.ts`): `ConversationFeed` (the stream, the task list, results, one action at a time, a message
retried under one id), `HomeFeed` (waiting decisions, what was done since the last visit, what runs next),
`ConversationStarter`, and `openWorkspace` (sign-in and where to land). What a device must supply is an
interface: `VisitStore` for Home's last visit; `fetch` is passed to the client. The words and ordering
rules (`home.ts`, `inbox.ts`, `duties.ts`, `sources.ts`) are plain functions.

- Source only. `main` is `src/index.ts`; clients import `@maka-cloud/client` through a bundler alias, so there is
  no build between an edit and the apps.
- No DOM and no UI framework. The hosts supply `fetch` (with a streaming body), `TextDecoder` and `crypto`.
  `tests/portable.test.ts` fails if `src/` names a browser-only API.
- Not a root workspace (its toolchain pins match `cloud-web`'s, not the root's):

```sh
npm --prefix packages/cloud-client ci --workspaces=false
npm --prefix packages/cloud-client run typecheck
npm --prefix packages/cloud-client test
```

Format with the Biome that `cloud-web` pins: `npm --prefix packages/cloud-web exec -- biome format --write ../cloud-client`.
