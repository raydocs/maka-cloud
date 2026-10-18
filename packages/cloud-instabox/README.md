# @maka-cloud/instabox

A `WorkspaceExecutor` that runs Maka's built-in tools (Bash, Read, Write, Edit, Glob,
Grep) inside an [instabox](https://api.instabox.sh/v1/openapi.json) sandbox instead of on
the host. Pass it to `buildBuiltinTools({ executor })`; nothing else is wired.

```ts
import { createInstaboxWorkspaceExecutorFromEnv } from '@maka-cloud/instabox';

// INSTABOX_API_KEY=ibk_..., INSTABOX_MACHINE_ID=m_..., optional INSTABOX_API_URL
const executor = createInstaboxWorkspaceExecutorFromEnv();
```

The session `cwd` and every path are POSIX paths inside the sandbox.

## How each operation maps to the API

| Operation | instabox call |
|---|---|
| Bash | `POST /v1/machines/{id}/exec` (collected output, no streaming) |
| Read text up to 256 KiB | `GET /v1/machines/{id}/files`, after a containment check |
| Read binary, image or larger | `exec`, base64 in 512 KiB chunks |
| Write | `exec`: base64 chunks into a temp file beside the target, size check, then `mv -T` |
| Glob | `exec` (`find`), matched with `minimatch` |
| Grep | `exec` (`rg --json`), parsed by Maka's own `searchFiles` |
| Path resolution | `exec` (`realpath`), then a containment check against the canonical cwd |

## Behaviour worth knowing

- **`exec` is never replayed after the request may have reached the sandbox.** It has no
  `Idempotency-Key`. It is retried only on a response the server marks `retryable`.
  Lifecycle calls (resume, start) carry one key for all their retries.
- **`GET /files` reads as root, `exec` runs as the sandbox user.** The executor resolves
  and checks the path against the workspace on its side before every `GET /files` call.
  An empty `content` is never taken as an empty file: it is checked against the file
  size and re-read with `exec` when it disagrees.
- **Writes are atomic and binary-safe.** A failure at any chunk removes the temp file and
  leaves the target untouched. Files are limited to 32 MiB per read or write.
- **A paused sandbox is woken** (`wake`, `resume` or `start`) when `exec` answers
  `409 machine_not_running`, then the command is sent once more. That 409 means the
  command did not start.
- **Abort** drops the HTTP request and runs a kill script that finds the command's
  processes by a per-call token in their environment.
- **Not provided:** `ApplyPatch` and the descriptor-pinned `readModifyWrite` (a remote
  sandbox cannot pin host descriptors, so Edit falls back to read and write), `argv` and
  fd inputs from a host sandbox wrapper, and `host` path scope.
- **Known limits:** a Grep or Glob whose output exceeds one 1 MiB response fails with a
  request to narrow it. Output is delivered once when the command ends. Long commands that
  need streaming output are not covered here (use SSH).
- A crash between chunks of a write can leave a `.maka-<uuid>.tmp` file beside the target.

## Tests

`npm run test:dist -w @maka-cloud/instabox` builds and runs the tests against a fake
instabox HTTP server. The fake runs `exec` commands with local bash, so the helper scripts
run for real; the tests need bash, GNU coreutils and (for Grep) ripgrep, and skip the
ripgrep cases when it is missing. No test calls the real API.
