/**
 * Bash that runs inside the sandbox through `exec` (as the sandbox user, never through
 * `GET /files`). Values come in as environment variables, so nothing is spliced into
 * the script text except the fixed fragments below.
 *
 * Layout per task: `$MAKA_ROOT/<taskId>/` holds `brief.md`, `result.json`, a `workspace/`
 * directory, and for each CLI invocation ("run", `t1`, `t2`, ...) `<run>.lock`, `.sh`,
 * `.token`, `.pid`, `.cancel` (a stop request) and `.exit` (written last). The raw stdout and
 * stderr of a run (`<run>.out`) can hold secrets the CLI printed, so it is kept in
 * `$MAKA_LOG_ROOT/<taskId>/`, on memory-backed storage that a snapshot of the sandbox's files
 * does not contain, and deleted when the run is stopped.
 */

/**
 * True when `$1` is a live run whose environment carries its own token (guards pid reuse). A
 * zombie (killed, not yet reaped) is not alive.
 */
const ALIVE_FN = `
pstate() {
  local line
  IFS= read -r line < "/proc/$1/stat" 2>/dev/null || return 1
  line=\${line##*) }
  printf '%s' "\${line%% *}"
}
alive() {
  local pid tok st
  pid=$(cat "$1.pid" 2>/dev/null) || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  st=$(pstate "$pid") || return 1
  [ "$st" = Z ] && return 1
  if [ -r "/proc/$pid/environ" ] && [ -r "$1.token" ]; then
    tok=$(cat "$1.token")
    tr '\\0' '\\n' < "/proc/$pid/environ" | grep -qxF "MAKA_RUN_TOKEN=$tok" || return 1
  fi
  return 0
}
`;

/**
 * Process groups. A run is its own group leader (setsid), so its children share the group id with
 * the leader's pid, and survive the leader when they ignore TERM or are left running at its exit.
 * `group_pids <pgid>` prints every process that is not a zombie and is in that process group or
 * session. `group_is_run <base> <pgid>` is true when the run's leader is alive, or when one of
 * those processes carries the run's token: the group is then the run's own, not a recycled id.
 */
const GROUP_FN = `
group_pids() {
  local stat line pid pgrp sid st
  for stat in /proc/[0-9]*/stat; do
    IFS= read -r line < "$stat" 2>/dev/null || continue
    pid=\${line%% *}
    line=\${line##*) }
    read -r st _ pgrp sid _ <<< "$line"
    case "$st" in Z|X) continue ;; esac
    if [ "$pgrp" = "$1" ] || [ "$sid" = "$1" ]; then printf '%s\\n' "$pid"; fi
  done
}
group_is_run() {
  local tok pid
  alive "$1" && return 0
  tok=$(cat "$1.token" 2>/dev/null) || return 1
  [ -n "$tok" ] || return 1
  for pid in $(group_pids "$2"); do
    if [ -r "/proc/$pid/environ" ] && tr '\\0' '\\n' < "/proc/$pid/environ" | grep -qxF "MAKA_RUN_TOKEN=$tok"; then return 0; fi
  done
  return 1
}
`;

/** stdin: the brief, when `MAKA_WRITE_BRIEF` is set. */
export const PREPARE_SCRIPT = `set -eu
umask 077
mkdir -p "$MAKA_DIR/workspace"
if [ -n "\${MAKA_WRITE_BRIEF:-}" ]; then
  cat > "$MAKA_DIR/brief.md.tmp"
  mv -f "$MAKA_DIR/brief.md.tmp" "$MAKA_DIR/brief.md"
fi
`;

/**
 * Starts one run, at most once. The exclusive create of the lock file is the guard: exec has no
 * Idempotency-Key, so a retried start finds the lock and reports ALREADY instead of launching a
 * second process. A stop request that got here first (`<run>.cancel`) wins: CANCELLED, nothing
 * starts. Whoever wins the lock also clears the previous turn's `result.json`, so a turn that
 * writes nothing cannot be taken for one that did; a retried start never reaches that line.
 * stdin: the run script.
 */
export const LAUNCH_SCRIPT = `set -eu
umask 077
mkdir -p "$MAKA_DIR"
cd "$MAKA_DIR"
if ! ( set -C; : > "$MAKA_RUN.lock" ) 2>/dev/null; then echo ALREADY; exit 0; fi
if [ -e "$MAKA_RUN.cancel" ]; then echo CANCELLED; exit 0; fi
rm -rf -- result.json result.read
cat > "$MAKA_RUN.sh"
printf '%s' "$MAKA_RUN_TOKEN" > "$MAKA_RUN.token"
setsid nohup bash "$MAKA_RUN.sh" > /dev/null 2>&1 < /dev/null &
echo STARTED
`;

/** Read-only: does the lock of this run exist? */
export const INSPECT_SCRIPT = `if [ -e "$MAKA_DIR/$MAKA_RUN.lock" ]; then echo LOCKED; else echo FREE; fi`;

/**
 * The script a run executes. It is its own process group leader (setsid), records its pid, honours
 * a stop request that arrived first, and writes the exit file last, so "exit file present" means
 * every byte of output is on disk. With `MAKA_LOG_DIR` set, the raw output goes there instead of
 * next to the run, and only if that directory is memory-backed: output can hold secrets the CLI
 * printed, and a snapshot of the sandbox's files must never contain them.
 */
export function buildRunScript(input: {
  /** Shell lines run before the command, e.g. unsetting variables and the credential guard. */
  preamble: string;
  /** The command line, already quoted. */
  command: string;
}): string {
  return `set -u
cd "$MAKA_DIR" || exit 1
echo $$ > "$MAKA_RUN.pid.tmp" && mv -f "$MAKA_RUN.pid.tmp" "$MAKA_RUN.pid"
finish() { echo "$1" > "$MAKA_DIR/$MAKA_RUN.exit.tmp"; mv -f "$MAKA_DIR/$MAKA_RUN.exit.tmp" "$MAKA_DIR/$MAKA_RUN.exit"; }
if [ -e "$MAKA_RUN.cancel" ]; then finish 143; exit 143; fi
out="$MAKA_RUN.out"
if [ -n "\${MAKA_LOG_DIR:-}" ]; then
  umask 077
  if mkdir -p "$MAKA_LOG_DIR" 2>/dev/null && [ -d "$MAKA_LOG_DIR" ] && [ ! -L "$MAKA_LOG_DIR" ] && [ -O "$MAKA_LOG_DIR" ] \\
    && chmod 700 "$MAKA_LOG_DIR" && case "$(stat -f -c %T "$MAKA_LOG_DIR" 2>/dev/null)" in tmpfs|ramfs) true ;; *) false ;; esac; then
    out="$MAKA_LOG_DIR/$MAKA_RUN.out"
  else
    echo "MAKA_GUARD: raw output needs memory-backed storage at $MAKA_LOG_DIR and will not be written to disk" > "$MAKA_RUN.out"
    finish 43
    exit 43
  fi
fi
exec > "$out" 2>&1
export PATH="$HOME/.maka-cli/bin:$PATH"
${input.preamble}
cd "$MAKA_WORKDIR" || { echo "MAKA_GUARD: cannot enter the task workspace"; finish 1; exit 1; }
${input.command}
rc=$?
finish "$rc"
exit "$rc"
`;
}

/**
 * One exec for every watched run on a machine. stdin: lines `<dir> <run> <offset> <cap>`.
 * Per line: `T <dir> <run> <state> <size> <base64 bytes from offset>`. The state is read before
 * the bytes, so a run reported as exited has all its output in what follows.
 */
export const POLL_SCRIPT = `${ALIVE_FN}
while IFS=' ' read -r dir run off cap; do
  [ -n "$dir" ] || continue
  d="$MAKA_ROOT/$dir"
  if [ -f "$d/$run.exit" ]; then st="exit:$(cat "$d/$run.exit")"
  elif [ -f "$d/$run.pid" ]; then
    if alive "$d/$run"; then st=running
    elif [ -f "$d/$run.exit" ]; then st="exit:$(cat "$d/$run.exit")"
    else st=dead; fi
  elif [ -f "$d/$run.lock" ]; then st=starting
  else st=none; fi
  f="\${MAKA_LOG_ROOT:-/nonexistent}/$dir/$run.out"
  [ -f "$f" ] || f="$d/$run.out"
  size=0; data=""
  if [ -f "$f" ]; then
    size=$(stat -c %s "$f" 2>/dev/null || echo 0)
    if [ "$size" -gt "$off" ]; then
      data=$(tail -c +$((off + 1)) "$f" | head -c "$cap" | base64 -w0)
    fi
  fi
  printf 'T %s %s %s %s %s\\n' "$dir" "$run" "$st" "$size" "$data"
done
`;

/**
 * Stops the runs of one task, and everything they started: TERM to the process group, a grace
 * period, then KILL to whatever is left of the group, whether or not the group's leader is still
 * running or already exited (a child that ignores TERM outlives it). Only a group that is the
 * run's own is signalled: its leader is alive with the run's token, or a process in the group
 * carries it. Afterwards the group must be empty; if not, the script prints `SURVIVORS <run>`
 * and exits 1. Prints `KILLED <run>` for each run it had something to stop in, `NONE` if there
 * was nothing. Runs that have not started yet are marked (`<run>.cancel`, and the runs named in
 * `MAKA_CANCEL_RUNS`) so that they never do, and the raw output under `MAKA_LOG_DIR` is deleted.
 *
 * With `MAKA_ONLY_RUNS` (run names, space separated) it touches those runs alone: their process
 * groups, locks and raw output files, never another run of the task. A run's cleanup uses this, so
 * that it cannot reach a later turn of the same task that has started since.
 */
export const KILL_SCRIPT = `${ALIVE_FN}${GROUP_FN}
cleanup_logs() {
  [ -n "\${MAKA_LOG_DIR:-}" ] || return 0
  if [ -n "\${MAKA_ONLY_RUNS:-}" ]; then
    for run in $MAKA_ONLY_RUNS; do rm -f -- "$MAKA_LOG_DIR/$run.out"; done
  else
    rm -rf -- "$MAKA_LOG_DIR"
  fi
}
cd "$MAKA_DIR" 2>/dev/null || { cleanup_logs; echo NONE; exit 0; }
umask 077
locks="./*.lock"
pids="./*.pid"
if [ -n "\${MAKA_ONLY_RUNS:-}" ]; then
  locks=""
  pids=""
  for run in $MAKA_ONLY_RUNS; do locks="$locks ./$run.lock"; pids="$pids ./$run.pid"; done
fi
for run in \${MAKA_CANCEL_RUNS:-}; do : > "$run.cancel"; done
for lockf in $locks; do
  [ -f "$lockf" ] || continue
  lockbase="\${lockf%.lock}"
  [ -f "$lockbase.exit" ] || : > "$lockbase.cancel"
done
found=0
survivors=0
for pidf in $pids; do
  [ -f "$pidf" ] || continue
  base="\${pidf%.pid}"
  pid=$(cat "$pidf" 2>/dev/null) || continue
  case "$pid" in ''|*[!0-9]*) continue ;; esac
  group_is_run "$base" "$pid" || continue
  members=$(group_pids "$pid")
  [ -n "$members" ] || continue
  found=1
  kill -TERM -- "-$pid" 2>/dev/null
  for m in $members; do kill -TERM "$m" 2>/dev/null; done
  waited=0
  while [ "$waited" -lt "\${MAKA_GRACE_TENTHS:-30}" ] && [ -n "$(group_pids "$pid")" ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  kill -KILL -- "-$pid" 2>/dev/null
  for m in $(group_pids "$pid"); do kill -KILL "$m" 2>/dev/null; done
  waited=0
  while [ "$waited" -lt 30 ] && [ -n "$(group_pids "$pid")" ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  if [ -n "$(group_pids "$pid")" ]; then
    echo "SURVIVORS \${base#./}"
    survivors=1
  else
    echo "KILLED \${base#./}"
  fi
done
cleanup_logs
[ "$found" = 1 ] || echo NONE
[ "$survivors" = 0 ]
`;

/** Prints `LIVE <dir>` for every task directory with a run still alive, or a leftover of one. */
export const SWEEP_SCRIPT = `${ALIVE_FN}${GROUP_FN}
for d in "$MAKA_ROOT"/*/; do
  [ -d "$d" ] || continue
  name=$(basename "$d")
  for pidf in "$d"*.pid; do
    [ -f "$pidf" ] || continue
    base="\${pidf%.pid}"
    pid=$(cat "$pidf" 2>/dev/null) || continue
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    if group_is_run "$base" "$pid" && [ -n "$(group_pids "$pid")" ]; then echo "LIVE $name"; break; fi
  done
done
echo DONE
`;

/**
 * Copies result.json into a private file, capped at 1 MiB + 1, refusing symlinks and anything
 * that is not a regular file. The open uses O_NOFOLLOW (dd iflag=nofollow), so a symlink swapped
 * in after the check still fails. Prints one of MISSING, SYMLINK, NOTFILE, UNREADABLE, or
 * `OK <bytes>`.
 */
export const RESULT_STAGE_SCRIPT = `set -u
cd "$MAKA_DIR" 2>/dev/null || { echo MISSING; exit 0; }
f=result.json
if [ -L "$f" ]; then echo SYMLINK; exit 0; fi
if [ ! -e "$f" ]; then echo MISSING; exit 0; fi
if [ ! -f "$f" ]; then echo NOTFILE; exit 0; fi
rm -f result.read
( set -C; dd if="$f" iflag=nofollow,nonblock status=none 2>/dev/null | head -c 1048577 > result.read ) 2>/dev/null || { echo UNREADABLE; exit 0; }
echo "OK $(stat -c %s result.read)"
`;

/** Prints `MAKA_OFF`..`MAKA_OFF + MAKA_LEN` of the staged copy as base64. */
export const RESULT_CHUNK_SCRIPT = `cd "$MAKA_DIR" && tail -c +$((MAKA_OFF + 1)) result.read | head -c "$MAKA_LEN" | base64 -w0`;

export const RESULT_CLEAN_SCRIPT = `rm -f "$MAKA_DIR/result.read"`;

/** Removes a task's directory entry for a failed install, so the next task can try again. */
export const REMOVE_DIR_SCRIPT = `rm -rf -- "$MAKA_DIR"`;

/** True (exit 0) when the CLI at the pinned version is installed. */
export function cliCheckScript(binary: string): string {
  return `export PATH="$HOME/.maka-cli/bin:$PATH"
[ -f "$MAKA_MARKER" ] && command -v ${binary} >/dev/null 2>&1 && ${binary} --version 2>&1 | grep -qF -- "$MAKA_VERSION"`;
}
