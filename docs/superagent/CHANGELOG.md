# Super-agent changelog

Append-only. Newest first. Times are America/Denver, taken from the
first listed SHA's committer date (`git show -s --format=%cI`).
Every behavior change under `packages/cloud-superagent` must add an entry
in the same commit. `changelog.test.ts` fails the package suite when this
file is missing from the branch diff, when a later Super-agent commit
omits it, when uncommitted Super-agent edits leave it unchanged, or when
a heading time is more than five minutes off that SHA's committer date.

## 2026-11-02 16:53 MST — cursor/superagent-usable-51be — 9238f1d88

- **PR:** [#470](https://github.com/raydocs/maka-cloud/pull/470)
- **What:** Merge `origin/main` `e83340599` (PR #465 Super-agent workspaces) into Super-agent usable. CHANGELOG conflicted; both sides kept, newest first.
- **Why:** #465 landed on main; remaining stack PRs needed main forwarded. Linux-only gates.
- **Tests:** conflict resolution only; prior head `46c3b8579`
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 16:53 MST — cursor/superagent-ledger-51be — cdec5b8b5

- **PR:** [#466](https://github.com/raydocs/maka-cloud/pull/466)
- **What:** Merge `origin/main` `e83340599` (PR #465 Super-agent workspaces) into Super-agent ledger. CHANGELOG conflicted; both sides kept, newest first.
- **Why:** #465 landed on main; this PR was DIRTY. User asked to merge main forward and report Linux-green SHAs.
- **Tests:** conflict resolution only; prior head `9a9f8ba87` already had Linux CI green or in progress
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 16:02 MST — cursor/superagent-usable-51be — 7ca1e8eca

- **PR:** [#470](https://github.com/raydocs/maka-cloud/pull/470)
- **What:** Merge `origin/main` `4f54c25dc` (PR #464 Super-agent host) into Super-agent usable. Kept T34 P3 (`superagent` before `runners`). `AGENTS.md` T34 wording and CHANGELOG conflicted; ours plus incoming entries kept.
- **Why:** #464 landed on main. User asked to merge main up the remaining stack immediately.
- **Tests:** conflict resolution only; prior head `ac67c930c` already had non-iOS CI green
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 16:01 MST — cursor/superagent-ledger-51be — 56d1a02e4

- **PR:** [#466](https://github.com/raydocs/maka-cloud/pull/466)
- **What:** Merge `origin/main` `4f54c25dc` (PR #464 Super-agent host) into Super-agent ledger. Kept T34 P3 (`superagent` before `runners`). `AGENTS.md` T34 wording and CHANGELOG conflicted; ours plus #464's changelog entry kept.
- **Why:** #464 landed on main. User asked to merge main up the remaining stack immediately.
- **Tests:** conflict resolution only; prior head `708b62670` already had non-iOS CI green
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 16:00 MST — cursor/superagent-workspaces-51be — 3dc73baac

- **PR:** [#465](https://github.com/raydocs/maka-cloud/pull/465)
- **What:** Merge `origin/main` `4f54c25dc` (PR #464 Super-agent host) into Super-agent workspaces. Kept T34 P3 (`superagent` before `runners`). `AGENTS.md` T34 wording and CHANGELOG conflicted; ours plus #464's changelog entry kept.
- **Why:** #464 landed on main; this PR was DIRTY. User asked to merge main up the remaining stack immediately.
- **Tests:** conflict resolution only; prior head `19bf5136f` already had non-iOS CI green
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 14:54 MST — cursor/superagent-usable-51be — b792005a4

- **PR:** [#470](https://github.com/raydocs/maka-cloud/pull/470)
- **What:** No code change. Retrigger CI after classifying the `android` failure on `c5f9465b4`.
- **Why:** Fork cloud-mobile `android` on run 41521663761 job 125538961097 failed at "Run the flows on an Android emulator" with no Maestro `e2e-output` (artifact was only `stack.log`). Annotation: `/usr/bin/sh` exit 1. Same wave: #466 and #471 `android` succeeded; this PR's `test` / `real-accounts` / `rehearsal` / `cloud-web` / `checks` succeeded. Emulator flake, not the usable build. Prior `test` on `e6234fce7` was upstream desktop e2e `workhub-layout` (`aria-haspopup` listbox vs dialog); later head green.
- **Tests:** none (docs / retrigger)
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 13:42 MST — cursor/superagent-usable-51be — 6bdd4b03f

- **PR:** [#470](https://github.com/raydocs/maka-cloud/pull/470)
- **What:** Removed leftover `AGENTS.md` conflict markers on the `asf-license-headers` fork-delta row. Kept both `docs/superagent` and `scripts/cloud-maka-engine-boundary.mjs` exclusions.
- **Why:** The main-merge commit resolved the T34/MakaEngine table but left a second hunk at line 65.
- **Tests:** none (docs table only)
- **Live:** n/a
- **Migrations / risk:** none

## 2026-11-02 13:39 MST — cursor/superagent-usable-51be — dbe274210

- **PR:** [#470](https://github.com/raydocs/maka-cloud/pull/470)
- **What:** Merge `origin/main` `6682cdc34` (PR #469 MakaEngine) into Super-agent usable. Kept MakaEngine and T34 P3 (`superagent` before `runners`). `AGENTS.md` and `package.json` conflicted; both sides kept.
- **Why:** #469 landed on main; this PR was DIRTY. Prior `test` on `e6234fce7` (run 41508419480) failed desktop e2e `workhub-layout` (`aria-haspopup` expected `listbox`, got `dialog`). `apps/desktop` / `packages/ui` match #466 where that spec passed; prior #470 head `520f204b` was green. Upstream flake, not the usable build. Not a test we own; merge retriggers CI. Assertions unchanged.
- **Tests:** conflict resolution only
- **Live:** n/a
- **Migrations / risk:** none. Inherits #469 MakaEngine. No sqlite change.

## 2026-11-02 13:38 MST — cursor/superagent-workspaces-51be — b10cab40f

- **PR:** [#465](https://github.com/raydocs/maka-cloud/pull/465)
- **What:** Merge `origin/main` `6682cdc34` (PR #469 MakaEngine) into Super-agent workspaces. Kept MakaEngine (workspace, `build`/`build:eval` after `@maka/eval`, fork-lane/Dockerfile step, import-boundary) and T34 P3 (`superagent` still builds before `runners`). `AGENTS.md` and `package.json` conflicted; both sides kept. `docs/superagent` joins the ASF header exclusion.
- **Why:** #469 landed on main; this PR was DIRTY. User asked to merge main up the stack and keep MakaEngine.
- **Tests:** conflict resolution only
- **Live:** n/a
- **Migrations / risk:** none. Inherits #469 MakaEngine. No sqlite change.

## 2026-11-02 13:38 MST — cursor/superagent-ledger-51be — d12b53238

- **PR:** [#466](https://github.com/raydocs/maka-cloud/pull/466)
- **What:** Merge `origin/main` `6682cdc34` (PR #469 MakaEngine) into Super-agent ledger. Kept MakaEngine and T34 P3 (`superagent` before `runners`). `AGENTS.md` and `package.json` conflicted; both sides kept. `docs/superagent` joins the ASF header exclusion.
- **Why:** #469 landed on main; this PR was DIRTY. Prior `test` on `7f900d01c` (run 41507887910) failed three desktop e2e cold-start specs (`composer-directory-reference`, `composer-session-reference`, `expected-failure-feedback`) — splash only, 20s composer timeout. Unrelated to the ledger; `cloud-runners` cancel-install passed. Not a test we own; merge retriggers CI. Assertions unchanged.
- **Tests:** conflict resolution only
- **Live:** n/a
- **Migrations / risk:** none. Inherits #469 MakaEngine. No sqlite change.

## 2026-11-02 13:36 MST — cursor/superagent-host-51be — 6251b7923

- **PR:** [#464](https://github.com/raydocs/maka-cloud/pull/464)
- **What:** Merge `origin/main` `6682cdc34` (PR #469 MakaEngine) into Super-agent host. Kept MakaEngine (`packages/cloud-maka-engine`, build order after `@maka/eval`, fork-lane/Dockerfile build step, import-boundary test) and the T34 Super-agent host rows. Only `AGENTS.md` conflicted; both fork-delta tables kept. `docs/superagent` joins the ASF header exclusion so this file is allowed.
- **Why:** #469 landed on main; this PR was DIRTY. User asked to merge main up the stack and keep MakaEngine.
- **Tests:** conflict resolution only; desktop e2e flakes on later PRs are unrelated
- **Live:** n/a
- **Migrations / risk:** none. Inherits #469 MakaEngine. No sqlite change.
