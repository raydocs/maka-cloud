# @maka-cloud/plans

The user's own Claude and ChatGPT plans, linked per invite (T27). This first piece holds the Claude
setup token; the ChatGPT side (the server owns the refresh token) comes with the Codex app-server runner.

- `PlanVault` keeps one sealed credential per invite and vendor in a SQLite file. The seal is AES-256-GCM
  with the invite and vendor in the associated data, so a value copied to another row does not open.
- The key is 32 bytes (`parsePlanKey`: base64 or 64 hex digits). Without it nothing can be linked.
- A status (`linked`, `expired`, `broken`, `unlinked`, with dates and a 30-day warning) never holds the
  credential. The only way to read it is `claudeProcessEnv(inviteId)`, the environment of the `claude`
  process and nothing else.
- `markBroken` (a 401) drops the credential at once; `unlink` deletes it and overwrites the sealed copy.

Not wired into the server yet: the key setting, the Settings routes and the runner injection are separate
pieces. See `docs/fork/TASKS.md` T27.
