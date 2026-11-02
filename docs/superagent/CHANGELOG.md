# Super-agent changelog

Append-only. Newest first. Times are America/Denver, taken from the
first listed SHA's committer date (`git show -s --format=%cI`).
Every behavior change under `packages/cloud-superagent` must add an entry
in the same commit. `changelog.test.ts` fails the package suite when this
file is missing from the branch diff, when a later Super-agent commit
omits it, when uncommitted Super-agent edits leave it unchanged, or when
a heading time is more than five minutes off that SHA's committer date.

## 2026-11-02 16:01 MST — cursor/superagent-ledger-51be — 56d1a02e4

- **PR:** [#466](https://github.com/raydocs/maka-cloud/pull/466)
- **What:** Merge `origin/main` `4f54c25dc` (PR #464 Super-agent host) into Super-agent ledger. Kept T34 P3 (`superagent` before `runners`). `AGENTS.md` T34 wording and CHANGELOG conflicted; ours plus #464's changelog entry kept.
- **Why:** #464 landed on main. User asked to merge main up the remaining stack immediately.
- **Tests:** conflict resolution only; prior head `708b62670` already had non-iOS CI green
- **Live:** n/a
- **Migrations / risk:** none

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
