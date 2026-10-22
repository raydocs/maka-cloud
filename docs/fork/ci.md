# CI: every machine busy, each job where it runs best

The repository is public, so GitHub's standard runners cost nothing, and up to 20 of its jobs run at
once. The owner's machines take the jobs that run well on them, which leaves GitHub's slots for the
long `test` job.

Where a job runs is decided by repository variables, so moving a lane needs no commit: set the
variable and its jobs go to the owner's runners; delete it and they go back to GitHub's.

## Lanes

| Job | Runs on | Variable |
|---|---|---|
| ci `test` | `ubuntu-24.04` (GitHub) | `CI_RUNNER_TEST` (unset) |
| cloud-web, mobile `checks` | the VPS: `vps-1`, `vps-3`, `vps-4`, `vps-5` | `CI_RUNNER` = `["self-hosted","vps"]` |
| the rehearsal | the VPS, `vps-2` only | `CI_RUNNER_DOCKER` = `["vps-docker"]` |
| mobile `ios` | the Mac mini, `mac-mini` | `CI_RUNNER_MAC` = `["self-hosted","mac"]` |
| mobile `android` | the Mac mini, `mac-mini-2` | `CI_RUNNER_ANDROID` = `["mac-android"]` |

Each Mac label is on one runner only, so the Mac runs at most one iOS job and one emulator at a
time, side by side. The rehearsal binds ports 80 and 443 and uses a fixed Compose project, so only
one runner carries `vps-docker`.

`test` stays on GitHub's runners because of the VPS:
- One playbooks test ("a reproduction test that is killed by a signal…") fails there even when it
  runs alone.
- Timing-sensitive tests in `runtime` and `cli` failed when two full runs shared the server.

**Pull requests from forks.** A fork's pull request never runs on the owner's machines:
- The repository requires approval for every outside contributor's run.
- Every `runs-on` falls back to GitHub's image for a fork.
- The YAML can be edited by the pull request itself, so the real boundary is on the machines. Each
  runner's job-started hook (`ACTIONS_RUNNER_HOOK_JOB_STARTED`, outside the repository) refuses a
  `pull_request*`, `workflow_run` or `issue_comment` job whose head repository is not this one,
  before any step runs.

## Runners

| Runner | Host | Labels |
|---|---|---|
| `mac-mini` | Mac mini (Apple silicon, 12 cores, 16 GB) | `self-hosted`, `mac` |
| `mac-mini-2` | the same Mac, second instance | `mac-android` |
| `vps-1` | Ubuntu 24.04 server (12 vCPU, 15 GB, no KVM) | `self-hosted`, `vps`, `vps-test` |
| `vps-2` | the same server, kept for the rehearsal | `vps-test`, `vps-docker` |
| `vps-3`, `vps-4`, `vps-5` | the same server | `self-hosted`, `vps` |

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
- **Every runner:** the job-started hook in the runner's `.env`. It refuses fork jobs (above), then
  empties `RUNNER_TEMP`, as a fresh machine would. A left-over directory there once failed the
  DeepSeek toolchain step.

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
