/**
 * Bash that runs inside the sandbox through `exec` (as the sandbox user, never through
 * `GET /files`). Values come in as environment variables, so nothing is spliced into
 * the script text except the fixed fragments below.
 *
 * Layout per task: `$MAKA_ROOT/<taskId>/` holds `brief.md`, `result.json`, a `workspace/`
 * directory, and for each CLI invocation ("run", `t1`, `t2`, ...) `<run>.lock`, `.sh`,
 * `.token`, `.pid`, `.out` (stdout and stderr together) and `.exit` (written last).
 */

/** True when `$1` is a live run whose environment carries its own token (guards pid reuse). */
const ALIVE_FN = `
alive() {
  local pid tok
  pid=$(cat "$1.pid" 2>/dev/null) || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  if [ -r "/proc/$pid/environ" ] && [ -r "$1.token" ]; then
    tok=$(cat "$1.token")
    tr '\\0' '\\n' < "/proc/$pid/environ" | grep -qxF "MAKA_RUN_TOKEN=$tok" || return 1
  fi
  return 0
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
 * second process. stdin: the run script.
 */
export const LAUNCH_SCRIPT = `set -eu
umask 077
mkdir -p "$MAKA_DIR"
cd "$MAKA_DIR"
if ! ( set -C; : > "$MAKA_RUN.lock" ) 2>/dev/null; then echo ALREADY; exit 0; fi
cat > "$MAKA_RUN.sh"
printf '%s' "$MAKA_RUN_TOKEN" > "$MAKA_RUN.token"
setsid nohup bash "$MAKA_RUN.sh" > /dev/null 2>&1 < /dev/null &
echo STARTED
`;

/** Read-only: does the lock of this run exist? */
export const INSPECT_SCRIPT = `if [ -e "$MAKA_DIR/$MAKA_RUN.lock" ]; then echo LOCKED; else echo FREE; fi`;

/**
 * The script a run executes. It is its own process group leader (setsid), records its pid, and
 * writes the exit file last, so "exit file present" means every byte of output is on disk.
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
exec > "$MAKA_RUN.out" 2>&1
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
  f="$d/$run.out"
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
 * Stops the runs of one task: TERM to the process group, a grace period, then KILL. Only a pid
 * whose environment carries the run's own token is signalled. Prints `KILLED <run>` per run.
 */
export const KILL_SCRIPT = `${ALIVE_FN}
cd "$MAKA_DIR" 2>/dev/null || { echo NONE; exit 0; }
found=0
for pidf in ./*.pid; do
  [ -f "$pidf" ] || continue
  base="\${pidf%.pid}"
  [ -f "$base.exit" ] && continue
  alive "$base" || continue
  pid=$(cat "$pidf")
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  waited=0
  while [ "$waited" -lt "\${MAKA_GRACE_TENTHS:-30}" ] && alive "$base"; do
    sleep 0.1
    waited=$((waited + 1))
  done
  if alive "$base"; then kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null; fi
  echo "KILLED \${base#./}"
  found=1
done
[ "$found" = 1 ] || echo NONE
`;

/** Prints `LIVE <dir>` for every task directory with a run still alive. */
export const SWEEP_SCRIPT = `${ALIVE_FN}
for d in "$MAKA_ROOT"/*/; do
  [ -d "$d" ] || continue
  name=$(basename "$d")
  for pidf in "$d"*.pid; do
    [ -f "$pidf" ] || continue
    base="\${pidf%.pid}"
    [ -f "$base.exit" ] && continue
    if alive "$base"; then echo "LIVE $name"; break; fi
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
