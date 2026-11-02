# Super-agent changelog

Append-only. Newest first. Times are America/Denver, taken from the
first listed SHA's committer date (`git show -s --format=%cI`).
Every behavior change under `packages/cloud-superagent` must add an entry
in the same commit. `changelog.test.ts` fails the package suite when this
file is missing from the branch diff, when a later Super-agent commit
omits it, when uncommitted Super-agent edits leave it unchanged, or when
a heading time is more than five minutes off that SHA's committer date.

## 2026-11-02 14:54 MST — cursor/superagent-usable-51be

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
