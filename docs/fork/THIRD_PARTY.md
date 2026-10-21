# Third-party sources of the fork

What this fork takes from other projects, as `docs/fork/TASKS.md` ("Borrow before building")
requires: the source, the licence, what was taken, and where it is. Code taken under Apache-2.0
also needs the source's NOTICE; nothing below is Apache-2.0 code yet, so `NOTICE` is unchanged.

| Source | Licence | What was taken | Where |
|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` 0.3.306 | Anthropic's terms (`LICENSE.md` in the package: "Use is subject to the Legal Agreements" at code.claude.com/docs/en/legal-and-compliance) | The package itself as a dependency, unmodified: `query()` with `spawnClaudeCodeProcess`, hooks (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`). Its bundled native `claude` binary is not used: tasks run the `claude` installed in the sandbox. The SDK is used with API keys only, as the whole product is (`AGENTS.md`, "Product constraints"). | `packages/cloud-runners` (`sdk-turn.ts`, `hooks.ts`, `process-channel.ts`); pinned exactly in `packages/cloud-runners/package.json` |
| `vercel-labs/durable-harness` | Apache-2.0 | Design only, no code and none of its dependencies: the step log with memo keys and replay classes, epoch fencing of the log, the recovery note, the file-tail process channel (a process on a box whose stdin is a file and whose output is read by offset), the explicit environment allowlist. | `docs/fork/design/durable-tasks.md`; `packages/cloud-orchestrator/src/{steps,recovery}.ts`; `packages/cloud-runners/src/process-channel.ts` |
