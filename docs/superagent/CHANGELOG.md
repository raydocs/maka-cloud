# Super-agent changelog

Append-only. Newest first. Times are America/Denver, taken from the
first listed SHA's committer date (`git show -s --format=%cI`).
Every behavior change under `packages/cloud-superagent` must add an entry
in the same commit. `changelog.test.ts` fails the package suite when this
file is missing from the branch diff, when a later Super-agent commit
omits it, when uncommitted Super-agent edits leave it unchanged, or when
a heading time is more than five minutes off that SHA's committer date.

## 2026-11-02 13:39 MST — cursor/superagent-usable-51be — dbe274210

- **PR:** [#470](https://github.com/raydocs/maka-cloud/pull/470)
- **What:** Merge `origin/main` `6682cdc34` (PR #469 MakaEngine) into Super-agent usable. Kept MakaEngine and T34 P3 (`superagent` before `runners`). `AGENTS.md` and `package.json` conflicted; both sides kept.
- **Why:** #469 landed on main; this PR was DIRTY. Prior `test` on `e6234fce7` (run 41508419480) failed desktop e2e `workhub-layout` (`aria-haspopup` expected `listbox`, got `dialog`). `apps/desktop` / `packages/ui` match #466 where that spec passed; prior #470 head `520f204b` was green. Upstream flake, not the usable build. Not a test we own; merge retriggers CI. Assertions unchanged.
- **Tests:** conflict resolution only
- **Live:** n/a
- **Migrations / risk:** none. Inherits #469 MakaEngine. No sqlite change.
