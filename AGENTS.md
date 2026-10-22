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
| `package.json`, `package-lock.json` | T11: `packages/cloud-memory` joins workspaces and both build chains before its server consumer; npm regenerates the workspace/server dependency entries and normalizes existing Web Push transitive dev flags and entry order (no version changes) | never; on a sync, keep the entry and build order |
| `scripts/asf-license-headers.mjs` | `maka-cloud-fork` exclusion rule for our files | never |
| `README.md` | replaced with the Maka Cloud README; it keeps the ASF header, upstream's positioning sentence and its hero image, which `website/test/site.test.mjs` reads | never; on a sync, keep ours |
| `scripts/asf-license-headers.mjs` | go-live rehearsal lane: `deploy/` and the root `.dockerignore` join the `maka-cloud-fork` header exclusion | never; on a sync, keep the entries |
| `scripts/asf-source-release.mjs` | go-live rehearsal lane: `.dockerignore`, `Caddyfile`, `.service` and `.env` (the rehearsal's settings files) count as text release inputs | never; on a sync, keep the entries |
| `.github/dependabot.yml` | deleted: dependency bumps come through upstream syncs, not separate Dependabot PRs | never; on a sync, keep it deleted |
| `package.json`, `packages/runtime/package.json`, `package-lock.json`, `apps/desktop/artifact-budget.json`, `patches/@ai-sdk+*`, `scripts/generate-third-party-notices.mjs`, `LICENSE`, `*THIRD_PARTY_NOTICES.txt` | ai-sdk family upgrade for Claude Haiku 5.5 (branch `chore/ai-sdk-upgrade`) | upstream ships the same or newer ai-sdk versions |
| `package.json`, `package-lock.json` | T2: `packages/cloud-orchestrator` added to `workspaces`, and its build added to the `build` and `build:test` chains so CI runs its tests (the lockfile change is the new workspace entry only) | never; on a sync, keep our workspace entry and build step |
| `package.json`, `package-lock.json` | T1: `packages/cloud-instabox` added to `workspaces`, and its build added to the `build` and `build:test` chains so CI runs its tests (the lockfile change is the new workspace entry only) | never; on a sync, keep our workspace entry and build step |
| `package.json`, `package-lock.json` | T6: `packages/cloud-runners` added to `workspaces`, and its build added to the `build` and `build:test` chains so CI runs its tests (the lockfile change is the new workspace entry only) | never; on a sync, keep our workspace entry and build step |
| `package.json`, `package-lock.json` | T4: `packages/cloud-server` added to `workspaces`, and its build added to the `build` and `build:test` chains so CI runs its tests (the lockfile change is the new workspace entry only) | never; on a sync, keep our workspace entry and build step |
| `packages/cloud-server/package.json`, `package-lock.json` | T4 Web Push: the `web-push` package (MPL-2.0) and its dependencies, for `packages/cloud-server` only (the lockfile change is those entries, plus `dev` flags dropped from `inherits`, `minimist` and `safe-buffer`) | never; on a sync, take upstream's lockfile and rerun `npm install` |
| `packages/runtime/package.json` | `exports` gains `./workspace-executor`, `./grep-search`, `./text-line-window` so `@maka-cloud/instabox` can implement `WorkspaceExecutor` and reuse the ripgrep result parser (good candidate to send upstream) | upstream exports the same subpaths |
| `package.json`, `package-lock.json` | `packages/cloud-conductor-checks` added to `workspaces` and to the `build` and `build:test` chains, so CI builds and tests it (T3) | never; on a sync, keep the entries |
| `package.json`, `package-lock.json` | T20: `packages/cloud-supervisor` added to `workspaces`, and its build added to the `build` and `build:test` chains so CI runs its tests (the lockfile change is the new workspace entry only) | never; on a sync, keep our workspace entry and build step |
| `package.json`, `package-lock.json` | `packages/cloud-conductor` added to `workspaces` and to the `build` and `build:test` chains, so CI builds and tests it (T5; the lockfile change is the new workspace entry only) | never; on a sync, keep the entries |
| `package.json`, `package-lock.json` | `packages/cloud-playbooks` added to `workspaces` and to the `build` and `build:test` chains, so CI builds and tests it (T7; the lockfile change is the new workspace entry only) | never; on a sync, keep the entries |
| `package.json`, `package-lock.json` | `packages/cloud-host` added to `workspaces` and to the `build` and `build:test` chains, so CI builds and tests it (T5 PR B; the lockfile change is the new workspace entry only) | never; on a sync, keep the entries |
| `package.json`, `package-lock.json` | T20 PR 3b: the supervisor builds before `packages/cloud-host` in the `build` and `build:test` chains; the host's lockfile entry gains `@maka-cloud/supervisor` and the `ai` and `@ai-sdk/*` versions `packages/runtime` pins | never; on a sync, keep the order and the entry |
| `package.json`, `package-lock.json` | `packages/cloud-evals` added to `workspaces` and to the `build` and `build:test` chains, so CI builds and tests it (T10; the lockfile change is the new workspace entry and its dependency list) | never; on a sync, keep the entries |
| `package.json`, `package-lock.json` | `packages/cloud-gateway` added to `workspaces` and to the `build` and `build:test` chains before `packages/cloud-host`, so CI builds and tests it (model gateway; the lockfile change is the new workspace entry and the host's dependency on it) | never; on a sync, keep the entries and the order |
| `package.json`, `package-lock.json` | `packages/cloud-duties` added to `workspaces` and to the `build` and `build:test` chains before `packages/cloud-host`, so CI builds and tests it (T23; the lockfile change is the new workspace entry only) | never; on a sync, keep the entries and the order |
| `package.json`, `package-lock.json` | `packages/cloud-boxes` and `packages/cloud-plans` added to `workspaces` and to the `build` and `build:test` chains after `packages/cloud-runners`, so CI builds and tests them (T27; the lockfile change is the new workspace entry only) | never; on a sync, keep the entries |
| `package.json`, `package-lock.json` | `packages/cloud-modes` added to `workspaces` and to the `build` and `build:test` chains before `packages/cloud-memory`, so CI builds and tests it (T25; the lockfile change is the new workspace entry only) | never; on a sync, keep the entries and the order |
| `packages/cloud-runners/package.json`, `package-lock.json` | T28 piece 3: the `@anthropic-ai/claude-agent-sdk` package (exact 0.3.306; Anthropic's terms, see `docs/fork/THIRD_PARTY.md`), for `packages/cloud-runners` only. The lockfile change is the SDK, its platform binaries as optional entries, the packages its peers pull in (`@anthropic-ai/sdk`, `@opentelemetry/api`, and others), `dev` flags dropped from the packages `@modelcontextprotocol/sdk` reaches, and the `packages/cloud-duties` entry moved to its sorted place | never; on a sync, take upstream's lockfile and rerun `npm install` |
| `scripts/ci-workflow-policy.test.mjs`, `scripts/asf-license-headers.mjs` | T9: the new `fork-cloud-web.yml` lane joins the pull-request allowlist and the `maka-cloud-fork` header exclusion, so CI builds and tests `packages/cloud-web` (it is not a root workspace) | never; on a sync, keep the entries |
| `scripts/ci-workflow-policy.test.mjs`, `scripts/asf-license-headers.mjs` | T29: the new `fork-cloud-mobile.yml` lane (typecheck, tests, Metro bundles, an iOS simulator build and an Android emulator run of the Maestro flows) joins the pull-request allowlist and the `maka-cloud-fork` header exclusion; it is path-filtered on pull requests and unfiltered on `main`, so the filter-escape rule holds | never; on a sync, keep the entries |
| `scripts/ci-workflow-policy.test.mjs`, `scripts/asf-license-headers.mjs` | go-live rehearsal lane: `fork-deploy-rehearsal.yml` joins the pull-request allowlist and the `maka-cloud-fork` header exclusion, so CI builds the images and brings the stack up under Compose behind Caddy | never; on a sync, keep the entries |
| `scripts/ci-test-plan.mjs`, `scripts/ci-test-plan.test.mjs` | T8 D1/D3: `runtimeSandbox` (the user-namespace CI step) is also selected when `packages/cloud-playbooks` is tested, because each coding check runs in its own user and PID namespace | never; on a sync, keep the `packages/cloud-playbooks` clause and its test |
| `docs/code-origin-audit.md` | T14: exact-path non-text inventory entry for the synthetic cloud-web desktop test fixture | the fixture is removed or upstream records the same path |
| `package-lock.json` | T23 PR 4: the `packages/cloud-host` entry gains `@maka-cloud/duties` (the host wires the standing duties) | never; on a sync, take upstream's lockfile and rerun `npm install` |
| `scripts/run-workspace-tests-parallel.mjs`, `scripts/run-workspace-tests-parallel.test.mjs` | A workspace whose `test:dist` exits 0 but reports no `# tests N` line, or a total of zero, fails the run (an unbuilt package no longer passes empty); its output is read through a pipe and passed on | upstream does the same |
| `.github/workflows/ci.yml` | The `test` job's `runs-on` reads the repository variable `CI_RUNNER_TEST`, else `CI_RUNNER`, so it runs on the owner's Ubuntu 24.04 runners when set and on `ubuntu-24.04` when unset (always unset for a pull request from a fork); `setup-node`'s npm cache and the Electron cache restore run only on GitHub's runners (`docs/fork/ci.md`) | never; on a sync, keep the expression and the two conditions |
| `.github/workflows/ci.yml`, `scripts/ci-workflow-policy.test.mjs`, `scripts/run-workspace-tests-parallel.mjs`, `scripts/run-workspace-tests-parallel.test.mjs` | CI time limits: the `test` job's `timeout-minutes` goes from 45 to 75 (a full run was cut off at 45 under load); the runner gets `--workspace-timeout-minutes` and the job passes 30, because `desktop` and `cloud-playbooks` each hit the 15-minute per-workspace default; the policy test names the 75, and the Android job of `fork-cloud-mobile.yml` (60), as the exceptions to the 45-minute tier | upstream's `test` job runs in under 45 minutes again, or never; on a sync, keep the 75 |
