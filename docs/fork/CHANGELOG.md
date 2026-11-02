# Maka Cloud changelog

Fork-only history. Upstream's product changelog stays in `/CHANGELOG.md`.

## 2026-11-02 (America/Denver)

- `188d2b9ef4c927c34398b9ddade20a7229e2866d` — Introduce `@maka-cloud/maka-engine` (`MakaEngine`) so cloud packages stop importing `@maka/core`, `runtime`, `storage`, `runtime-host` and `eval` directly. Prepares for upstream replacing `main` with `rust-preview` (late November 2026), when those TypeScript packages disappear and the Host speaks length-prefixed JSON over IPC/WebSocket. `TsInProcessEngine` is a behavior-preserving wrap of today's SessionManager; `RustHostEngine` is types-only protocol mapping. No session migration.
