# Third-party sources of the fork

What this fork takes from other projects, as `docs/fork/TASKS.md` ("Borrow before building")
requires: the source, the licence, what was taken, and where it is. Code taken under Apache-2.0
also needs the source's NOTICE; nothing below is Apache-2.0 code yet, so `NOTICE` is unchanged.

| Source | Licence | What was taken | Where |
|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` 0.3.306 | Anthropic's terms (`LICENSE.md` in the package: "Use is subject to the Legal Agreements" at code.claude.com/docs/en/legal-and-compliance) | The package itself as a dependency, unmodified: `query()` with `spawnClaudeCodeProcess`, hooks (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`). Its bundled native `claude` binary is not used: tasks run the `claude` installed in the sandbox. The SDK is used with API keys only, as the whole product is (`AGENTS.md`, "Product constraints"). | `packages/cloud-runners` (`sdk-turn.ts`, `hooks.ts`, `process-channel.ts`); pinned exactly in `packages/cloud-runners/package.json` |
| `vercel-labs/durable-harness` | Apache-2.0 | Design only, no code and none of its dependencies: the step log with memo keys and replay classes, epoch fencing of the log, the recovery note, the file-tail process channel (a process on a box whose stdin is a file and whose output is read by offset), the explicit environment allowlist. | `docs/fork/design/durable-tasks.md`; `packages/cloud-orchestrator/src/{steps,recovery}.ts`; `packages/cloud-runners/src/process-channel.ts` |
| `elie222/rakazo` `apps/mobile` and `docs/mobile-release.md` | Apache-2.0 | Design only, no code (T29 PR 3): the folder layout of an Expo app next to a Metro config that watches shared source, and the Maestro-on-device idea; the release profiles and push setup are taken in the later T29 PRs and will say so here | `packages/cloud-mobile` |
| Maestro 2.11.0 (`mobile-dev-inc/Maestro`) | Apache-2.0 | A test tool the mobile CI downloads, checks against a pinned digest and runs; none of its code is in the repository or in a build | `.github/workflows/fork-cloud-mobile.yml`, `packages/cloud-mobile/.maestro` |
| `Ephemeral-AI-Lab/layerfs` 1.0.0 | MIT | Nothing yet: a proposal for task workspaces after launch, gated on isolation and a measured gain | `docs/fork/design/layerfs.md` |
