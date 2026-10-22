# CI: GitHub's runners for Linux, the owner's Mac for the phone apps

The repository is public, so GitHub's standard runners cost nothing and run many jobs at once. Every
Linux job runs there. The phone apps run on the owner's Mac mini, because GitHub's macOS queue was
the slowest part of a pull request (85 minutes median wait for `ios`, against 7 minutes on the Mac).
The VPS stays registered as a standby.

Where a job runs is decided by repository variables, so moving a lane needs no commit: set the
variable and its jobs go to the owner's runners; delete it and they go back to GitHub's.

## Lanes

| Job | Runs on today | Variable that moves it |
|---|---|---|
| ci `test` | `ubuntu-24.04` (GitHub) | `CI_RUNNER_TEST`, else `CI_RUNNER` |
| cloud-web, mobile `checks` | `ubuntu-24.04` (GitHub) | `CI_RUNNER` |
| the rehearsal | `ubuntu-24.04` (GitHub) | `CI_RUNNER_DOCKER`, else `CI_RUNNER` |
| mobile `ios` and `android` | the Mac mini | `CI_RUNNER_MAC` = `["self-hosted","mac"]` (set) |

A pull request from a fork never runs on the owner's machines, whatever the variables say: every
`runs-on` falls back to GitHub's image when `github.event.pull_request.head.repo.fork` is true. The
repository also requires approval before any workflow runs for an outside contributor
(`all_external_contributors`).

## Runners

| Runner | Host | Labels |
|---|---|---|
| `mac-mini` | Mac mini (Apple silicon) | `self-hosted`, `mac` |
| `vps-1` | Ubuntu 24.04 server (12 vCPU, 15 GB, no KVM) | `self-hosted`, `vps`, `vps-test` |
| `vps-2` | the same server, second instance | `vps-test`, `vps-docker` |

The VPS is a standby, not the default, for three reasons:
- GitHub's runners are free and parallel here.
- On the VPS, the playbooks test "a reproduction test that is killed by a signal…" fails even when
  it runs alone.
- Timing-sensitive tests in `runtime` and `cli` fail when two full runs share the server.

To use it again, set `CI_RUNNER` to `["self-hosted","vps"]`, after that test passes there.

The VPS has no `/dev/kvm`, so the Android emulator runs on the Mac: an arm64 emulator and an
`arm64-v8a` build. On GitHub's image it is x86_64 under KVM.

## What the hosts need (set up by hand, not in the repository)

- **Mac:**
  - Xcode with an iPhone simulator.
  - JDK 17 (`brew install openjdk@17`) and the Android SDK at `~/Library/Android/sdk`: platform-tools,
    emulator, platforms 34 and 36, build-tools 36, NDK 27.1, CMake 3.22.1, and the
    `android-34;google_apis;arm64-v8a` image.
  - In the runner's `.env`: `ANDROID_HOME`, `ANDROID_SDK_ROOT` and `ADB_MDNS=0`. adb's mDNS discovery
    aborts on a malformed service name from a home network, which killed adb in the middle of an install.
  - `brew install flock` to run the playbooks tests locally.
- **VPS:**
  - Docker with the Compose plugin, with the runner user in the `docker` group.
  - Passwordless `sudo` for the runner user, because the steps run `apt-get` and `sysctl`.
  - `gpg`, Xvfb and `x11-utils`.
  - Electron's desktop libraries: `libgtk-3-0t64`, `libnss3`, `libasound2t64`, `libgbm1`, `libxss1`,
    `libxtst6`, `libatk-bridge2.0-0t64` and `libcups2t64`.
  - rustup on the runner's `.path`.
- **Both:** a job-started hook (`ACTIONS_RUNNER_HOOK_JOB_STARTED` in the runner's `.env`) that empties
  `RUNNER_TEMP`, as a fresh machine would. A left-over directory there once failed the DeepSeek
  toolchain step.

## Keeping it fast

- **Path filters:** cloud-web and the rehearsal run on a pull request only when it touches
  `packages/`, the root manifests or their own files (the rehearsal also `deploy/`). Every push to
  `main` runs them without a filter, and the rehearsal also runs nightly.
- **Caches:** GitHub's runners restore the npm and Electron caches. A self-hosted runner keeps
  `~/.npm`, the Electron cache and `~/.gradle` itself, so those steps are skipped there.
- **Batch CI changes into one pull request.** A change to `ci.yml`, a shared script or the lockfile
  makes `test` select every package, which takes about 30 minutes. Any other change tests only what
  it touches: about 8 minutes for a `packages/cloud-*` change.
- **Where the time goes on a full run:** upstream's `runtime` and `cli` take about 15 minutes each,
  and our `cloud-playbooks` about 13. Each playbooks test drives several fake agent runs (10 to 27
  seconds per test), and its files run one at a time.
