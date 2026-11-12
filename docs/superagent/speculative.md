# Speculative execution

Default **off**. Architecture §1.1 still stands: Super-agent does not
silently "reproduce and fix" before a live run unless the owner turns
this on.

When enabled, certain **unowned** triggers may start a background worker
**before** the Router or a human decides:

- `ci_failed` on a repo in the watch list
- `issue_opened` whose title/body matches an opt-in rule

The worker has the lowest scheduler priority (`0`). It may edit a
worktree and run tests. It **must not** push, comment, or open a PR.
`Safety.gate` returns `speculative_blocked`; `mayPush` is false until
`acceptSpeculative`.

Results sit on the worker (`plan`, `evidence`, `workspaceRef`) with
`speculative.status = ready`. `acceptSpeculative` creates the
subscription (the worker becomes the subject owner) and records cost.
`discardSpeculative` retires the worker, calls the cleanup port
(worktree / box), and records cost. The usage ledger is the existing
per-worker rows plus `speculative_started` / `_accepted` / `_discarded`
/ `_refused` audit lines.

## Hard caps

| Cap | Default |
|---|---|
| Enabled | `false` |
| Max concurrent speculative runs per tenant | `1` |
| Daily speculative tokens | `50_000` |
| Daily speculative USD | `1` |
| Repo / issue opt-in | empty (nothing matches) |

A refused attempt is audited and the event continues through the normal
admission path (unowned CI stays `unowned_ci`).

## Enable (owner)

```bash
export MAKA_CLOUD_SPECULATIVE=1
export MAKA_CLOUD_SPECULATIVE_REPOS='acme/app'
export MAKA_CLOUD_SPECULATIVE_ISSUE='login'   # optional issue rule
```

The Super-agent constructor does **not** read those itself, and the host does
not pass `speculativeSettingsFromEnv()` in: speculative runs cannot be turned
on in the product. Tests never set these.
