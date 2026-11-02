# Maka Cloud fork changelog

Dates are America/Denver. Each entry names the upstream apache/maka commit this
fork absorbed and any fork-side follow-up.

## 2026-11-02

Merged apache/maka `5d3a0629a` (`feat(assistant): add compact chat and pet cards with single-choice replies (#6301)`).

- Runtime Host compatibility epoch **237 → 238** for assistant cards and durable single-choice reply/status operations. Older peers cannot display cards or submit and synchronize their choices safely.
- `packages/runtime/src/model-history.ts` now appends card text onto assistant replay items and counts that text in history estimates.
- `packages/core` exports `./assistant-card`. Assistant messages and runtime text events may carry an optional `card`.
- No fork-side code changes: cloud-conductor still does not emit cards, and append-only history holds when `card` is absent.

- `188d2b9ef4c927c34398b9ddade20a7229e2866d` — Introduce `@maka-cloud/maka-engine` (`MakaEngine`) so cloud packages stop importing `@maka/core`, `runtime`, `storage`, `runtime-host` and `eval` directly. Prepares for upstream replacing `main` with `rust-preview` (late November 2026), when those TypeScript packages disappear and the Host speaks length-prefixed JSON over IPC/WebSocket. `TsInProcessEngine` is a behavior-preserving wrap of today's SessionManager; `RustHostEngine` is types-only protocol mapping. No session migration.
