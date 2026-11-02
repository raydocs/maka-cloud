# Super-agent changelog

Append-only. Newest first. Times are America/Denver, taken from the
first listed SHA's committer date (`git show -s --format=%cI`).
Every behavior change under `packages/cloud-superagent` must add an entry
in the same commit. `changelog.test.ts` fails the package suite when this
file is missing from the branch diff, when a later Super-agent commit
omits it, when uncommitted Super-agent edits leave it unchanged, or when
a heading time is more than five minutes off that SHA's committer date.

## 2026-11-02 13:38 MST — cursor/superagent-workspaces-51be — b10cab40f

- **PR:** [#465](https://github.com/raydocs/maka-cloud/pull/465)
- **What:** Merge `origin/main` `6682cdc34` (PR #469 MakaEngine) into Super-agent workspaces. Kept MakaEngine (workspace, `build`/`build:eval` after `@maka/eval`, fork-lane/Dockerfile step, import-boundary) and T34 P3 (`superagent` still builds before `runners`). `AGENTS.md` and `package.json` conflicted; both sides kept. `docs/superagent` joins the ASF header exclusion.
- **Why:** #469 landed on main; this PR was DIRTY. User asked to merge main up the stack and keep MakaEngine.
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
