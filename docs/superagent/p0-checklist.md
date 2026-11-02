# P0 checklist — first real Instabox run

This is what the owner must provide and how to verify it. **This repository
does not perform the live run.** No secrets belong in git.

P0 exit from the architecture doc: one real coding task on a scratch repo
(brief → Instabox → tests → cross-vendor review → PR → CI green) under the
spend cap.

## Secrets (required)

| Name | Where | Notes |
|---|---|---|
| `INSTABOX_API_KEY` | Instabox org / dashboard | Host refuses to start without it. Never on argv. |
| `ANTHROPIC_API_KEY` | Anthropic (or your gateway master key) | Host model traffic goes through `@maka-cloud/gateway`. Required for the product stack, not for the fake local loop. |

## Sandbox mapping (pick one)

| Mode | Config | Notes |
|---|---|---|
| Local loop / first single-box try | `INSTABOX_MACHINE_ID` | One existing running-or-startable machine. `HttpSandbox` / `createInstaboxSandboxFromEnv` throw if the key is set and this is missing. |
| Host product, fixed machines | `MAKA_CLOUD_SANDBOXES` | JSON `{"<inviteId>":"<machineId>"}`. One machine per invite. **Do not** also set `INSTABOX_MACHINE_ID` on the host (`INSTABOX_MACHINE_ID is no longer used`). |
| Host product, pool | `MAKA_CLOUD_BOXES=1` and `MAKA_CLOUD_BOX_TEMPLATE` | Server creates/sleeps/deletes boxes. Optional `MAKA_CLOUD_BOX_MAX` (1–32, default 3). |

Optional: `INSTABOX_API_URL` (default `https://api.instabox.sh`). Must not carry credentials in the URL.

## DNS / public URLs (host product, not the fake loop)

| Name | Why |
|---|---|
| Public HTTPS host for the API | GitHub App webhook target. |
| `MAKA_GITHUB_WEBHOOK_SECRET` | ≥16 characters. Duties + Super-agent Source at `/github/webhook`. |
| GitHub App (or PAT) that can receive `pull_request`, `issue_comment`, `workflow_run` | Events Super-agent normalizes. |
| `MAKA_CLOUD_MCP_PUBLIC_URL` | How the sandbox reaches orchestrator MCP (https, or http on loopback). |
| `MAKA_CLOUD_GATEWAY_PUBLIC_URL` | How the sandbox reaches the model gateway. |
| Scratch repo the Instabox account may clone | P0 task target. Prefer a throwaway repo. |

Do not point a public DNS name at the `--listen` local-loop port. That
listener is for laptop replay only.

## Optional, not required for P0

| Name | Why |
|---|---|
| `MAKA_CLOUD_SUPERAGENT_ACTORS` | Comma-separated logins allowed to spawn. Empty = any non-bot (still filtered). |
| `MAKA_CLOUD_SUPERAGENT_JUDGE=model` plus a judge key | Cheap Router model. Heuristic stays default. |
| `MAKA_CLOUD_ORG_SECRET_*` / `MAKA_CLOUD_ORG_SECRETS_FILE` | Local Org Secrets. Instabox org-secret injection is still not assumed. |
| `OPENAI_API_KEY` | Only if a Codex / OpenAI mode is in `MAKA_CLOUD_MODES`. |
| Web Push (`CLOUD_PUSH_*`) | Spend alerts. Not P0. |

## How to verify (owner does this; the agent does not)

1. **Key works.** With the key only in the environment:
   ```bash
   curl -sS -H "X-API-Key: $INSTABOX_API_KEY" \
     "${INSTABOX_API_URL:-https://api.instabox.sh}/v1/machines/$INSTABOX_MACHINE_ID"
   ```
   Expect JSON with `"id"` and a startable `"state"` (`running`, `stopped`, or
   `suspended`). `401` = bad key. `404` = wrong machine id or org.

2. **Local loop against that machine.** After `npm run build -w @maka-cloud/superagent`:
   ```bash
   INSTABOX_API_KEY=… INSTABOX_MACHINE_ID=… npm run local-loop -w @maka-cloud/superagent
   ```
   Expect `sandbox: instabox` and the same step list as the fake run. The
   commands are `echo spawn` / `echo comment` / `echo approved` — cheap, but
   they prove `ensureRunning` + `exec`.

3. **Host stack config.** `maka-cloud` / host setup still requires
   `INSTABOX_API_KEY` and either `MAKA_CLOUD_SANDBOXES` or
   `MAKA_CLOUD_BOXES=1` + template. Confirm the printed sandbox line names
   the invite→machine map or the template. Super-agent sqlite is
   `<dataDir>/superagent.db` (exclusive lock).

4. **Webhook.** From the GitHub App, send a ping to the public
   `/github/webhook`. Duties accept it; Super-agent ignores `ping`. Then open
   a PR on the scratch repo from an allowed actor and confirm a worker row
   in `superagent.db`.

5. **Spend cap.** Gateway and invite daily/monthly limits stay in force.
   P0 should use a cheap model (`claude-haiku-5-5` or the built-in quick mode).

## Still stubbed / out of this repo

- Pricing tables beyond the existing gateway prices.
- Instabox org-secret proxy injection (local `EnvOrgSecrets` only).
- P5 hi-device worker — interface only; see [p5-hi-device.md](p5-hi-device.md).
- boat.dev (`#452` / `#453`) stays parked.

## Migrations

None for P0. Super-agent schema 2 (`usage_events`) is package-local
(`superagent.db`). It is **not** a `cloud-server` migration.
