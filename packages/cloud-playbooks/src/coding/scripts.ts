/**
 * Shell scripts the coding runner runs in the task's sandbox with exec, as the sandbox user.
 * Every script takes its input from `MAKA_*` variables (never interpolated into the script
 * text) and works inside `$MAKA_DIR`, the task's directory; the repository is
 * `$MAKA_DIR/workspace`. Git runs with hooks and fsmonitor off, so nothing the agent put in the
 * repository's config runs when the runner looks at the work.
 */

const GIT_FN = String.raw`
export GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1
g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.quotepath=off -c advice.detachedHead=false "$@"; }
`;

/**
 * Fetches one commit of the repository into a fresh workspace, replacing whatever was there.
 * Builds it beside the workspace and swaps it in, so a retried call starts over cleanly.
 * Prints `BASE <sha>`, or `CLONE_FAILED` and the end of git's error output.
 */
export const CLONE_SCRIPT = `set -u
umask 077
${GIT_FN}
mkdir -p "$MAKA_DIR" || exit 1
ws="$MAKA_DIR/workspace"
tmp="$MAKA_DIR/workspace.clone"
rm -rf -- "$tmp"
mkdir "$tmp" && cd "$tmp" || exit 1
g init -q
if ! g fetch -q --depth=1 --no-tags "$MAKA_REPO_URL" "$MAKA_REF" > "$MAKA_DIR/clone.err" 2>&1; then
  echo CLONE_FAILED
  tail -c 2000 "$MAKA_DIR/clone.err"
  exit 0
fi
g checkout -q --detach FETCH_HEAD || { echo CLONE_FAILED; exit 0; }
sha=$(g rev-parse HEAD) || { echo CLONE_FAILED; exit 0; }
cd "$MAKA_DIR" || exit 1
rm -rf -- "$ws"
mv "$tmp" "$ws"
echo "BASE $sha"
`;

/**
 * Starts one check (a test command) detached, at most once per check name. It runs as its own
 * session under \`timeout\`, records its pid and run token the way the runners' scripts do, so
 * the runners' task-wide stop also stops a check, and writes \`<check>.exit\` last.
 * Prints STARTED or ALREADY.
 */
export const CHECK_START_SCRIPT = `set -u
umask 077
cd "$MAKA_DIR" || exit 1
n="$MAKA_CHECK"
if ! ( set -C; : > "$n.started" ) 2>/dev/null; then echo ALREADY; exit 0; fi
rm -f -- "$n.exit" "$n.pid" "$n.out"
printf '%s' "$MAKA_RUN_TOKEN" > "$n.token"
setsid bash -c '
  echo $$ > "$1.pid"
  cd "$2" || { echo 127 > "$1.exit"; exit 127; }
  timeout -k 5 "$3" bash -c "$4" < /dev/null
  rc=$?
  echo "$rc" > "$1.exit.tmp" && mv -f "$1.exit.tmp" "$1.exit"
' maka-check "$MAKA_DIR/$n" "$MAKA_CWD" "$MAKA_TIMEOUT" "$MAKA_CMD" > "$n.out" 2>&1 < /dev/null &
echo STARTED
`;

/**
 * Where a check is: \`EXIT <code> <output bytes>\` followed by a line with the base64 of the
 * output's last \`$MAKA_TAIL\` bytes, RUNNING, STARTING (started, no pid yet) or DEAD.
 */
export const CHECK_STATUS_SCRIPT = `set -u
cd "$MAKA_DIR" 2>/dev/null || { echo DEAD; exit 0; }
n="$MAKA_CHECK"
report() {
  echo "EXIT $(cat "$n.exit") $(stat -c %s "$n.out" 2>/dev/null || echo 0)"
  tail -c "$MAKA_TAIL" "$n.out" 2>/dev/null | base64 -w0
  echo
}
if [ -f "$n.exit" ]; then report; exit 0; fi
if [ -f "$n.pid" ]; then
  pid=$(cat "$n.pid")
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo RUNNING; exit 0; fi
  if [ -f "$n.exit" ]; then report; exit 0; fi
  echo DEAD
  exit 0
fi
if [ -f "$n.started" ]; then echo STARTING; else echo DEAD; fi
`;

/**
 * Reads a small JSON file the agent wrote into the task directory, refusing symlinks and
 * anything that is not a regular file. Prints MISSING, SYMLINK, NOTFILE, TOOBIG or
 * \`OK <base64>\`.
 */
export const READ_SMALL_SCRIPT = `set -u
cd "$MAKA_DIR" 2>/dev/null || { echo MISSING; exit 0; }
f="$MAKA_FILE"
if [ -L "$f" ]; then echo SYMLINK; exit 0; fi
if [ ! -e "$f" ]; then echo MISSING; exit 0; fi
if [ ! -f "$f" ]; then echo NOTFILE; exit 0; fi
data=$(dd if="$f" iflag=nofollow,nonblock status=none 2>/dev/null | head -c "$((MAKA_MAX + 1))" | base64 -w0)
if [ "$(printf '%s' "$data" | base64 -d | wc -c)" -gt "$MAKA_MAX" ]; then echo TOOBIG; exit 0; fi
echo "OK $data"
`;

/** Writes stdin to a file in the task directory (the failure brief), replacing it atomically. */
export const WRITE_FILE_SCRIPT = `set -eu
umask 077
cd "$MAKA_DIR"
rm -f -- "$MAKA_FILE.tmp"
cat > "$MAKA_FILE.tmp"
mv -f -- "$MAKA_FILE.tmp" "$MAKA_FILE"
`;

/**
 * Content hashes of every file that differs from the last commit, for the edit-loop watch.
 * Read-only: no index lock is taken. Lines \`H <sha> <path>\`, \`L <path>\` (symlink) or
 * \`D <path>\` (deleted).
 */
export const SAMPLE_SCRIPT = `set -u
${GIT_FN}
cd "$MAKA_DIR/workspace" 2>/dev/null || exit 0
g status --porcelain=v1 -z --untracked-files=all --no-renames 2>/dev/null | head -c 500000 \\
  | while IFS= read -r -d '' entry; do
    p="\${entry:3}"
    if [ -L "$p" ]; then echo "L $p"
    elif [ -f "$p" ]; then echo "H $(g hash-object --no-filters -- "$p" 2>/dev/null) $p"
    elif [ ! -e "$p" ]; then echo "D $p"
    fi
  done | head -n "$MAKA_MAX_FILES"
`;

/** Lists, NUL-separated, every path that differs from the base commit (untracked included, ignored not). */
const CHANGED_PATHS_FN = String.raw`
changed_paths() {
  local idx="$MAKA_DIR/changes.index"
  rm -f -- "$idx"
  GIT_INDEX_FILE="$idx" g read-tree "$MAKA_BASE" || return 1
  GIT_INDEX_FILE="$idx" g add -A . || return 1
  GIT_INDEX_FILE="$idx" g diff --cached --no-renames --name-only -z "$MAKA_BASE"
  local rc=$?
  rm -f -- "$idx"
  return $rc
}
`;

/**
 * Puts the base commit's version of every changed file back, except the files in
 * \`$MAKA_KEEP\` (newline-separated: the reproduction test), keeping a copy of each so
 * \`BASE_RESTORE_SCRIPT\` can put the change back. A leftover of an interrupted check is
 * restored first. Prints \`REVERTED <count>\`.
 */
const RESTORE_FN = String.raw`
restore() {
  [ -d "$bk" ] || return 0
  if [ -f "$bk/reverted" ]; then
    while IFS= read -r -d '' p; do rm -rf -- "$ws/$p"; done < "$bk/reverted"
    cp -a "$bk/files/." "$ws/" || return 1
  fi
  rm -rf -- "$bk"
}
`;

export const BASE_REVERT_SCRIPT = `set -u
umask 077
${GIT_FN}${CHANGED_PATHS_FN}${RESTORE_FN}
ws="$MAKA_DIR/workspace"
bk="$MAKA_DIR/base-check"
cd "$ws" || exit 1
restore || { echo RESTORE_FAILED; exit 0; }
mkdir -p "$bk/files" || exit 1
declare -A keep
while IFS= read -r k; do [ -n "$k" ] && keep["$k"]=1; done <<< "$MAKA_KEEP"
changed_paths > "$bk/paths" || { echo LIST_FAILED; exit 0; }
: > "$bk/reverted.tmp"
count=0
while IFS= read -r -d '' p; do
  [ -n "\${keep[$p]:-}" ] && continue
  if [ -e "$p" ] || [ -L "$p" ]; then
    mkdir -p "$bk/files/$(dirname -- "$p")" && cp -a -- "$p" "$bk/files/$p" || exit 1
  fi
  printf '%s\\0' "$p" >> "$bk/reverted.tmp"
  count=$((count + 1))
done < "$bk/paths"
mv "$bk/reverted.tmp" "$bk/reverted"
while IFS= read -r -d '' p; do
  rm -rf -- "$p"
  mode=$(g ls-tree "$MAKA_BASE" -- "$p" | cut -d' ' -f1)
  [ -n "$mode" ] || continue
  mkdir -p "$(dirname -- "$p")"
  if [ "$mode" = 120000 ]; then ln -s "$(g cat-file blob "$MAKA_BASE:$p")" "$p"
  else
    g cat-file blob "$MAKA_BASE:$p" > "$p" || exit 1
    [ "$mode" = 100755 ] && chmod +x "$p"
  fi
done < "$bk/reverted"
echo "REVERTED $count"
`;

/** Puts the change back after a base check. Idempotent. Prints RESTORED. */
export const BASE_RESTORE_SCRIPT = `set -u
${RESTORE_FN}
ws="$MAKA_DIR/workspace"
bk="$MAKA_DIR/base-check"
[ -d "$ws" ] || { echo RESTORED; exit 0; }
restore && echo RESTORED
`;

/**
 * The change against the base commit as git would commit it: \`RAW <base64 of diff --raw -z>\`,
 * then \`PATCH <bytes>\` with \`change.patch\` written to the task directory, then one
 * \`SIZE <sha> <bytes>\` per new blob. Prints \`ERR <what>\` when git fails.
 */
export const CHANGES_SCRIPT = `set -u
umask 077
${GIT_FN}
cd "$MAKA_DIR/workspace" || { echo "ERR workspace"; exit 0; }
idx="$MAKA_DIR/changes.index"
rm -f -- "$idx"
export GIT_INDEX_FILE="$idx"
g read-tree "$MAKA_BASE" 2>/dev/null || { echo "ERR base"; exit 0; }
g add -A . 2> "$MAKA_DIR/changes.err" || { echo "ERR add $(tail -c 300 "$MAKA_DIR/changes.err" | tr '\\n' ' ')"; exit 0; }
raw=$(g diff --cached --raw -z --no-renames --abbrev=40 "$MAKA_BASE" | base64 -w0) || { echo "ERR diff"; exit 0; }
echo "RAW $raw"
g diff --cached --binary --no-renames --no-ext-diff --no-textconv "$MAKA_BASE" > "$MAKA_DIR/change.patch" || { echo "ERR patch"; exit 0; }
echo "PATCH $(stat -c %s "$MAKA_DIR/change.patch")"
g diff --cached --raw -z --no-renames --abbrev=40 "$MAKA_BASE" | tr '\\0' '\\n' \\
  | awk '/^:/ { print $4 }' | grep -v '^0\\{40\\}$' | sort -u | g cat-file --batch-check='SIZE %(objectname) %(objectsize)'
rm -f -- "$idx"
`;

/** One chunk of a blob: base64 of \`$MAKA_LEN\` bytes from \`$MAKA_OFF\`. */
export const BLOB_CHUNK_SCRIPT = `set -u
${GIT_FN}
cd "$MAKA_DIR/workspace" || exit 1
g cat-file blob "$MAKA_SHA" | tail -c +$((MAKA_OFF + 1)) | head -c "$MAKA_LEN" | base64 -w0
`;

/** One chunk of \`change.patch\`. */
export const PATCH_CHUNK_SCRIPT = `set -u
cd "$MAKA_DIR" || exit 1
[ -f change.patch ] && [ ! -L change.patch ] || exit 1
tail -c +$((MAKA_OFF + 1)) change.patch | head -c "$MAKA_LEN" | base64 -w0
`;
