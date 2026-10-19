# maka-cloud agent instructions

maka-cloud is a fork of [Apache Maka](https://github.com/apache/maka) that we
build a cloud personal agent on. Upstream changes often and we merge it often,
so every change here has to keep the next upstream merge cheap.

## Working rules

- No test cheating: never hard-code expected values or special-case logic to
  make a test pass. Fix the behavior, or report that the test is wrong.
- Scoped edits: change only what the task needs. No reformatting, comment
  rewrites or unrelated "improvements", least of all in upstream files.
- Define success first, then run the narrowest check that proves it (one test
  file, a typecheck of the touched package). Run the full suite only when
  shared contracts change.
- Report results honestly, including failures and checks you could not run.

## Upstream sync

- `upstream` mirrors apache/maka `main`. Never commit to it.
  `.github/workflows/fork-upstream-sync.yml` refreshes it daily and opens a
  "Sync upstream apache/maka" pull request into `main` when `main` is behind.
- Merge that pull request with **Create a merge commit**. Squash or rebase
  drops the shared history and makes every later sync conflict again.
- To resolve conflicts, cut a branch from `main`, run `git merge upstream`,
  resolve there, and open that branch as the pull request instead.
- For `package-lock.json` conflicts, take upstream's lockfile and rerun
  `npm install` for our dependency changes. Never hand-merge a lockfile.
- After a sync, upstream patches in `patches/` may need porting. Port them, and
  re-check the tests they protect.

## Where our code goes

- Put product code in new packages named `packages/cloud-*`, and fork docs in
  `docs/fork/`. Integrate through Maka's extension points: the
  `WorkspaceExecutor` in `packages/runtime`, plugins, MCP servers, and model
  providers. Task briefs live in `docs/fork/TASKS.md`.
- Change an upstream file only when no extension point fits. Keep the change
  minimal, record it in "Fork delta" below, and prefer sending it upstream.
- Upstream files keep their ASF license headers. Our new files carry no ASF
  header. The `maka-cloud-fork` rule in `scripts/asf-license-headers.mjs`
  already excludes `packages/cloud-*` and `docs/fork/`; a fork file anywhere
  else must be added to that rule, or the pre-commit hook rejects it.
- Inherited upstream workflows other than `ci.yml` are disabled. Do not
  enable release, publish or scheduled upstream workflows here.

## Product constraints

- Models are reached with API keys only. Never use or extend the Claude
  subscription provider (`subscription-cloaked-request.ts`), and never offer a
  claude.ai login in the product.
- Claude conversation history is append-only. Do not prune, rewrite or reorder
  earlier turns: Claude Opus 5.5 checks preserved thinking against the history.
- Do not brand anything "Claude Code". "Claude Agent" or "<name> Powered by
  Claude" are allowed.
- Never commit secrets. This repository is public.

## Fork delta

Upstream files this fork changes, so a sync knows what to re-check.

| File | Change | Drop when |
|---|---|---|
| `scripts/asf-license-headers.mjs` | `maka-cloud-fork` exclusion rule for our files | never |
| `.github/dependabot.yml` | deleted: dependency bumps come through upstream syncs, not separate Dependabot PRs | never; on a sync, keep it deleted |
| `package.json`, `packages/runtime/package.json`, `package-lock.json`, `apps/desktop/artifact-budget.json`, `patches/@ai-sdk+*`, `scripts/generate-third-party-notices.mjs`, `LICENSE`, `*THIRD_PARTY_NOTICES.txt` | ai-sdk family upgrade for Claude Haiku 5.5 (branch `chore/ai-sdk-upgrade`) | upstream ships the same or newer ai-sdk versions |
| `package.json`, `package-lock.json` | T2: `packages/cloud-orchestrator` added to `workspaces`, and its build added to the `build` and `build:test` chains so CI runs its tests (the lockfile change is the new workspace entry only) | never; on a sync, keep our workspace entry and build step |
| `package.json`, `package-lock.json` | T1: `packages/cloud-instabox` added to `workspaces`, and its build added to the `build` and `build:test` chains so CI runs its tests (the lockfile change is the new workspace entry only) | never; on a sync, keep our workspace entry and build step |
| `package.json`, `package-lock.json` | T6: `packages/cloud-runners` added to `workspaces`, and its build added to the `build` and `build:test` chains so CI runs its tests (the lockfile change is the new workspace entry only) | never; on a sync, keep our workspace entry and build step |
| `package.json`, `package-lock.json` | T4: `packages/cloud-server` added to `workspaces`, and its build added to the `build` and `build:test` chains so CI runs its tests (the lockfile change is the new workspace entry only) | never; on a sync, keep our workspace entry and build step |
| `packages/runtime/package.json` | `exports` gains `./workspace-executor`, `./grep-search`, `./text-line-window` so `@maka-cloud/instabox` can implement `WorkspaceExecutor` and reuse the ripgrep result parser (good candidate to send upstream) | upstream exports the same subpaths |
| `package.json`, `package-lock.json` | `packages/cloud-conductor-checks` added to `workspaces` and to the `build` and `build:test` chains, so CI builds and tests it (T3) | never; on a sync, keep the entries |
| `package.json`, `package-lock.json` | `packages/cloud-conductor` added to `workspaces` and to the `build` and `build:test` chains, so CI builds and tests it (T5; the lockfile change is the new workspace entry only) | never; on a sync, keep the entries |
| `package.json`, `package-lock.json` | `packages/cloud-playbooks` added to `workspaces` and to the `build` and `build:test` chains, so CI builds and tests it (T7; the lockfile change is the new workspace entry only) | never; on a sync, keep the entries |
