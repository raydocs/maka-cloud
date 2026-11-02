# BYOM — Bring Your Own Machine

Default **off**. A worker still runs on an Instabox box unless the owner
turns this on, pairs a device, and opts a repo in.

The device daemon (`@maka-cloud/superagent-device`) is a Node/TypeScript
process the owner installs on their own computer (a Mac mini for
`xcodebuild`, or a workstation that holds uncommitted work). It **dials
out** to the cloud over an authenticated long-poll. No inbound ports.

```
Mac / Linux daemon  --(HTTPS long-poll)-->  cloud ByomHub
        |                                         |
   workspace jail                          pairing + HMAC
   allow/deny list                         per-tenant device
   max runtime                             ExecutionTarget
```

## What the cloud sees

Capabilities only: `os`, `arch`, `cpu`, toolchains (`xcodebuild`, `git`,
…), labels. Exec results are stdout, stderr, and an exit code.

The cloud **never** receives the device's local secrets. The daemon's
exec environment is `PATH`, `HOME` (the jail root), and
`GIT_TERMINAL_PROMPT=0`. Keychain, SSH keys, cloud-vendor env, and the
pairing secret after minting do not go back on the wire. The pairing
secret is minted by the cloud and stored on both sides so they can HMAC
later; it is not a user secret.

## Pairing and auth

1. Cloud issues a short-lived pairing code (default 10 minutes, one use).
2. Device presents the code and its capabilities.
3. Cloud returns `deviceId` + a device credential. The code is consumed.
4. Later messages carry `deviceId`, timestamp, nonce, and
   `HMAC-SHA256(secret, deviceId|ts|nonce|type)`.
5. The cloud replies to `hello` with a `serverMac` over the same secret
   so the device knows it is talking to the hub that minted it.

The device is scoped to the tenant that created the pairing code. A job
for another tenant is refused.

## Policy (cloud and device)

Both sides enforce the same rules. The device must, because a compromised
cloud can otherwise send arbitrary commands.

| Control | Default |
|---|---|
| Command denylist | `sudo`, `rm -rf`, metadata `curl`/`wget`, `ssh`/`scp`, `osascript`, keychain `security`, and similar |
| Command allowlist | `argv[0]` basename must exactly match a listed toolchain (`git`, `npm`, `xcodebuild`, …). No shell parse |
| Shells / wrappers | Not on the default list (`sh`, `bash`, `zsh`, `dash`, `env`, `xargs`, …) |
| `allowShell` | Per-device, default **false**. Only pairing or `setAllowShell` can turn it on |
| Workspace jail | `cwd` must resolve inside the owner-chosen root |
| Max runtime | 15 minutes, then SIGKILL |
| Repo opt-in | Empty list. A repo is refused until the owner adds it |
| Kill switch | Tenant, device, or global. Next poll returns `killed` |
| Audit | Pair, hello, exec, refuse, kill, offline, `allowShell` — Super-agent ledger |

`SandboxPort` `cmd` strings are tokenized into argv and exec'd directly
(`spawn(argv[0], rest)`, no `shell: true`). Pipes, redirects, `&&` / `;`,
unquoted `$`, and `FOO=bar cmd` are refused with reason `shell_not_allowed`.
The runner never falls back to `sh -c`.

`allowShell: true` is the explicit per-device exception. The owner sets it
on the pairing code or later via `Superagent.setByomAllowShell` /
`ByomHub.setAllowShell`. Enabling writes `byom_allow_shell` to the hub
audit and the Super-agent ledger, and live workers show `allowShell` on
progress. A job that actually goes through a shell also records
`byom_shell_used`. The denylist still applies to the full string.

That is still best-effort, not a proven sandbox. Treat a paired machine as
an execution farm for the opted-in repos.

## ExecutionTarget

A worker runs on:

- `instabox` — default `SandboxPort` (FakeSandbox in CI, HttpSandbox live)
- `device` — a paired, online device whose capabilities match the need
  (`os=darwin`, `toolchains=xcodebuild`, …)

If the chosen device is offline the task **waits**. Progress shows
`waiting on human: device_offline`. The watchdog does not treat that as
stuck. Inbox events are not consumed until the device is back.

## Enable (owner)

Cloud (still off unless both are set):

```bash
export MAKA_CLOUD_BYOM=1
export MAKA_CLOUD_BYOM_REPOS='acme/ios,acme/app'
```

The Super-agent constructor does **not** read those itself. The host
must pass `byomSettingsFromEnv()` / a `ByomHub` in. Tests never set
these.

Device:

```bash
export MAKA_CLOUD_BYOM_URL='https://<host>/v1/superagent/byom'
export MAKA_CLOUD_BYOM_CODE='…'          # env, not argv
export MAKA_CLOUD_BYOM_STATE="$HOME/.maka/device.json"
export MAKA_CLOUD_BYOM_ROOT="$HOME/src/ios"
export MAKA_CLOUD_BYOM_TOOLS='git,node,xcodebuild'
npm run start -w @maka-cloud/superagent-device -- --once
```

## Threat model

### Cloud compromise ⇒ device risk

If an attacker controls the Super-agent host or the ByomHub credential
store they can:

- Send any **allowlisted** command into the opted-in workspace root on
  every paired device for that tenant.
- Read whatever those commands print (source, test output, local
  uncommitted files under the jail).
- Keep doing so until the owner hits the kill switch or unplugs the
  daemon.

They cannot (by design):

- Open inbound ports on the device.
- Reach paths outside the jail via `cwd`.
- Run a shell, `env`/`xargs`, or any piped/redirected `cmd` unless the
  owner turned on that device's `allowShell`. The default path is
  argv-only.
- Run denylisted binaries (`sudo`, `ssh`, metadata `curl`, …). The
  denylist still wins when `allowShell` is on.
- Pull the device keychain, SSH agent, or unrelated env. Those never
  leave the machine.
- Act as another tenant: jobs are scoped to the pairing tenant.

### Device compromise ⇒ cloud risk

A stolen device credential lets the thief poll that device's job queue
and return fake exec results. They do not get other tenants' jobs, the
model API keys, or Instabox credentials. Rotate by killing the device
and pairing again.

### Pairing-code theft

A code in flight is a one-time, short-lived capability to attach a
**new** device to that tenant. Treat it like a device-login code. Do
not put it on argv (shell history).

### Residual

Allowlisted toolchains can still run code (`python -c`, `node -e`,
`xcodebuild`). That is the point of pairing the machine. A stolen
`allowShell` device can run `sh -c` of anything the denylist does not
catch — treat that switch as equivalent to giving the cloud a login
shell on that host.

BYOM is not Instabox. The owner is extending the trusted computing base
to a machine they control. Only pair hosts you would let run
`xcodebuild` / `npm test` on that repo. Default off exists so this TCB
does not grow until someone opts in.

## Tests

`packages/cloud-superagent/src/__tests__/byom.test.ts` and
`byom-cli.test.ts` drive an in-process `DeviceDaemon` (or
`FakeDeviceDaemon`) over `LoopbackTransport` / a fake `fetch`.
`@maka-cloud/superagent-device` repeats the loopback path so the
installable package cannot drift. No live cloud, no inbound listen.
