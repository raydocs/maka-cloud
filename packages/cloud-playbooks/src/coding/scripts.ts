/**
 * Shell scripts the coding runner runs in the task's sandbox with exec, as the sandbox user.
 * Every script takes its input from `MAKA_*` variables (never interpolated into the script
 * text) and works inside `$MAKA_DIR`, the task's directory; the repository is
 * `$MAKA_DIR/workspace`. The agent owns the repository's own `.git` (its config, attributes and
 * hooks), so the sandbox user never reads it: after the clone, git runs against `control.git` in
 * the task directory, which only the sandbox user can enter, with no configuration of its own
 * beyond what is on the command line and the working tree as the only thing it reads from the
 * agent. A filter, a hook or a textconv named in the agent's `.git/config` or `.gitattributes` has
 * no definition there and so nothing to run.
 */

const GIT_FN = String.raw`
export GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT GIT_EXTERNAL_DIFF GIT_ASKPASS GIT_SSH GIT_SSH_COMMAND GIT_PAGER
g() { git --git-dir="$MAKA_DIR/control.git" --work-tree="$MAKA_DIR/workspace" -c safe.directory='*' -c diff.ignoreSubmodules=all -c status.submoduleSummary=false -c submodule.recurse=false -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.attributesFile=/dev/null -c core.excludesFile=/dev/null -c core.quotepath=off -c advice.detachedHead=false "$@"; }
`;

/**
 * A repository inside the workspace (a populated submodule, a `git init` in a directory) has a
 * `.git` the agent owns, and git runs a child git in it for the directories it knows as gitlinks:
 * that child would read the agent's configuration and attributes. None is allowed while the runner
 * looks at the tree.
 */
const NO_NESTED_REPO = String.raw`nested=$(find "$MAKA_DIR/workspace" -mindepth 2 -name .git -print -quit 2>/dev/null)
[ -z "$nested" ] || { echo "ERR nested repository $nested"; exit 0; }
`;

/** What every script that reads the repository first checks: the control repository was made at the clone. */
const NEED_CONTROL = String.raw`[ -d "$MAKA_DIR/control.git" ] && [ ! -L "$MAKA_DIR/control.git" ] || { echo "ERR control repository missing"; exit 0; }
`;

/**
 * Fetches one commit of the repository into a fresh workspace, replacing whatever was there.
 * Builds it beside the workspace and swaps it in, so a retried call starts over cleanly.
 * Prints `BASE <sha>`, or `CLONE_FAILED` and the end of git's error output.
 */
export const CLONE_SCRIPT = `set -u
umask 077
export GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.quotepath=off -c advice.detachedHead=false "$@"; }
mkdir -p "$MAKA_DIR" || exit 1
ws="$MAKA_DIR/workspace"
tmp="$MAKA_DIR/workspace.clone"
cg="$MAKA_DIR/control.git"
rm -rf -- "$tmp" "$MAKA_DIR/control.git.clone"
mkdir "$tmp" && cd "$tmp" || exit 1
g init -q
if ! g fetch -q --depth=1 --no-tags "$MAKA_REPO_URL" "$MAKA_REF" > "$MAKA_DIR/clone.err" 2>&1; then
  echo CLONE_FAILED
  tail -c 2000 "$MAKA_DIR/clone.err"
  exit 0
fi
g checkout -q --detach FETCH_HEAD || { echo CLONE_FAILED; exit 0; }
sha=$(g rev-parse HEAD) || { echo CLONE_FAILED; exit 0; }
# The repository the runner itself reads: its own copy of the commit's objects and an index of the
# commit, in a directory the agent cannot enter. Nothing of it comes from the workspace's \`.git\`
# after this point (the agent writes that), and nothing runs from it.
ccl="$MAKA_DIR/control.git.clone"
git --git-dir="$ccl" init -q || { echo CLONE_FAILED; exit 0; }
cp -a "$tmp/.git/objects/." "$ccl/objects/" || { echo CLONE_FAILED; exit 0; }
[ ! -f "$tmp/.git/shallow" ] || cp "$tmp/.git/shallow" "$ccl/shallow" || { echo CLONE_FAILED; exit 0; }
printf '%s\\n' "$sha" > "$ccl/HEAD"
GIT_INDEX_FILE="$ccl/index" git --git-dir="$ccl" --work-tree="$tmp" -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null read-tree "$sha" || { echo CLONE_FAILED; exit 0; }
# The checkout is made with the umask above, so only the sandbox user could read it: hand it to the
# agent's group (when there is one) before the agent exists, so no file is swapped underneath.
if [ -n "\${MAKA_AGENT_GROUP:-}" ]; then
  chgrp -R -h -- "$MAKA_AGENT_GROUP" "$tmp" || { echo CLONE_FAILED; exit 0; }
  find "$tmp" ! -type d ! -type l -exec chmod g+rwX {} + || { echo CLONE_FAILED; exit 0; }
  find "$tmp" -type d -exec chmod 2770 {} + || { echo CLONE_FAILED; exit 0; }
fi
cd "$MAKA_DIR" || exit 1
rm -rf -- "$ws" "$cg"
mv "$tmp" "$ws"
mv "$ccl" "$cg"
echo "BASE $sha"
`;

/** How every process of a task's checks is marked: the tag of each check starts with this. */
export function checkTagPrefix(taskId: string): string {
  return `maka-check:${taskId}:`;
}

/** The part of a check's tag that follows the task's prefix and names the attempt that runs it, when known. */
export function checkAttemptMark(attempt: number | undefined): string {
  return attempt === undefined ? '' : `e${Math.trunc(attempt)}.`;
}

/**
 * Runs one check (a test command) to its end, inside one exec, so its exit status is the exec's
 * own, which the sandbox API reports to the host; nothing the check writes is read as its result.
 * The command runs in a new user and PID namespace whose first process is ours: when it ends, the
 * kernel kills every process left in the namespace, and nothing inside can leave it (\`setsid\`,
 * \`env -u\` and double forks included) or signal or trace the processes outside. The namespace's
 * first process marks a fresh directory once it runs; without the mark the check was not
 * isolated, and the script exits 125 with a \`maka-check:\` line on stderr (which the check cannot
 * write to). \`timeout\` ends the command after \`$MAKA_TIMEOUT\` seconds (TERM, then KILL 5 s
 * later); an outer one ends the namespace 10 s after that. Prints the last \`$MAKA_TAIL\` bytes of
 * the output on stdout and \`BYTES <output bytes>\` on stderr. \`$MAKA_CHECK_TAG\` is an argument
 * of the processes outside the namespace and of its first process, so CHECK_STOP_SCRIPT finds them.
 */
export const CHECK_SCRIPT = `set -u
umask 077
cd "$MAKA_DIR/workspace" 2>/dev/null || { echo 'maka-check: the workspace is missing' >&2; exit 125; }
mark=$(mktemp -d) || { echo 'maka-check: no temporary directory' >&2; exit 125; }
timeout -s KILL "$((MAKA_TIMEOUT + 15))" \\
  unshare --user --map-current-user --pid --fork --kill-child -- \\
  bash -c ': > "$1/started" || exit 125; timeout -k 5 "$3" bash -c "$2" < /dev/null & wait $!' \\
  "$MAKA_CHECK_TAG" "$mark" "$MAKA_CMD" "$MAKA_TIMEOUT" < /dev/null 2>&1 |
  { tee >(wc -c | sed 's/^/BYTES /' >&2) | tail -c "$MAKA_TAIL"; wait $!; }
rc=\${PIPESTATUS[0]}
isolated=0
[ -e "$mark/started" ] && isolated=1
rm -rf -- "$mark"
if [ "$isolated" = 0 ]; then
  echo 'maka-check: the sandbox could not start the check in its own user and PID namespace (unshare)' >&2
  exit 125
fi
exit "$rc"
`;

/**
 * Stops the checks whose tag starts with \`$MAKA_CHECK_TAG\` (one check, or with
 * checkTagPrefix every check of a task): kills the processes that carry the tag, which ends their
 * namespaces, then waits until no process of those namespaces is left. Prints STOPPED, NONE or
 * SURVIVORS. With \`$MAKA_CHECK_UP_TO\` a check whose tag names a later attempt (\`e<attempt>.\`
 * after the prefix) is left alone: it is the new driver's, and a stop that arrives late from an
 * earlier attempt must not reach it.
 */
export const CHECK_STOP_SCRIPT = `set -u
self=$(readlink /proc/self/ns/pid)
tagged() {
  local arg rest n
  while IFS= read -r -d '' arg; do
    case "$arg" in
      "$MAKA_CHECK_TAG"*)
        rest="\${arg#"$MAKA_CHECK_TAG"}"
        if [ -n "\${MAKA_CHECK_UP_TO:-}" ]; then
          case "$rest" in
            e[0-9]*.*)
              n="\${rest#e}"
              n="\${n%%.*}"
              case "$n" in ''|*[!0-9]*) ;; *) [ "$n" -gt "$MAKA_CHECK_UP_TO" ] && return 1 ;; esac
              ;;
          esac
        fi
        return 0
        ;;
    esac
  done < "$1/cmdline" 2>/dev/null
  return 1
}
nss=""
found=0
for p in /proc/[0-9]*; do
  [ "\${p#/proc/}" = "$$" ] && continue
  tagged "$p" || continue
  found=1
  ns=$(readlink "$p/ns/pid" 2>/dev/null) || ns=""
  [ -n "$ns" ] && [ "$ns" != "$self" ] && nss="$nss $ns"
  kill -KILL "\${p#/proc/}" 2>/dev/null
done
[ "$found" = 1 ] || { echo NONE; exit 0; }
left() {
  local p ns stat
  for p in /proc/[0-9]*; do
    ns=$(readlink "$p/ns/pid" 2>/dev/null) || continue
    case " $nss " in *" $ns "*) ;; *) continue ;; esac
    stat=$(cat "$p/stat" 2>/dev/null) || continue
    stat=\${stat##*) }
    [ "\${stat%% *}" = Z ] || return 0
  done
  return 1
}
waited=0
while [ -n "$nss" ] && left; do
  [ "$waited" -ge 50 ] && { echo SURVIVORS; exit 0; }
  sleep 0.1
  waited=$((waited + 1))
done
echo STOPPED
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

/**
 * Copies a file of the task directory into `handoff/`, where the agent's account can read it: the
 * task directory only lets that account pass through it, and the runner's files there are private.
 * The copy is group-readable and replaces any earlier one atomically. `handoff/` is made by the
 * runner that starts the agent, and made here if the agent has not run yet.
 */
export const PUBLISH_FILE_SCRIPT = `set -eu
umask 077
cd "$MAKA_DIR"
mkdir -p handoff
tmp=$(mktemp handoff/.publish.XXXXXX)
cat -- "$MAKA_FILE" > "$tmp"
chmod 640 "$tmp"
mv -fT -- "$tmp" "handoff/$MAKA_FILE"
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
# Lets git keep the control repository's index fresh, so a sample hashes what changed, not every file.
export GIT_OPTIONAL_LOCKS=1
[ -d "$MAKA_DIR/control.git" ] || { echo "ERR control repository missing"; exit 0; }
cd "$MAKA_DIR/workspace" 2>/dev/null || exit 0
${NO_NESTED_REPO}g status --porcelain=v1 --ignore-submodules=all -z --untracked-files=all --no-renames 2>/dev/null | head -c 500000 \\
  | while IFS= read -r -d '' entry; do
    p="\${entry:3}"
    if [ -L "$p" ]; then echo "L $p"
    elif [ -f "$p" ]; then echo "H $(g hash-object --no-filters -- "$p" 2>/dev/null) $p"
    elif [ ! -e "$p" ]; then echo "D $p"
    fi
  done | head -n "$MAKA_MAX_FILES"
`;

/**
 * `inside <path>` succeeds when the directory holding `<path>` resolves, symlinks followed, to
 * somewhere in the real workspace (`$wsreal`). The agent can swap a directory for a symlink, and a
 * script running as the sandbox user must not remove or write through it.
 */
const INSIDE_FN = String.raw`
inside() {
  local d
  d=$(realpath -m -- "$(dirname -- "$1")") || return 1
  case "$d/" in "$wsreal"/*) return 0 ;; esac
  return 1
}
`;

/** Lists, NUL-separated, every path that differs from the base commit (untracked included, ignored not). */
const CHANGED_PATHS_FN = String.raw`
changed_paths() {
  local idx="$MAKA_DIR/changes.index"
  rm -f -- "$idx"
  GIT_INDEX_FILE="$idx" g read-tree "$MAKA_BASE" || return 1
  GIT_INDEX_FILE="$idx" g add -A . || return 1
  GIT_INDEX_FILE="$idx" g diff --cached --ignore-submodules=all --no-renames --name-only -z "$MAKA_BASE"
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
const RESTORE_FN = `${INSIDE_FN}
restore() {
  [ -d "$bk" ] || return 0
  if [ -f "$bk/reverted" ]; then
    local p
    while IFS= read -r -d '' p; do
      inside "$ws/$p" || return 1
      rm -rf -- "$ws/$p"
    done < "$bk/reverted"
    # One file at a time: a copy of the whole backup tree would put the backup's own directories
    # (private to the sandbox user) over the workspace's, and the agent could not enter them.
    local f rel
    while IFS= read -r -d '' f; do
      rel="\${f#"$bk/files/"}"
      inside "$ws/$rel" || return 1
      mkdir -p -- "$(dirname -- "$ws/$rel")" && cp -a --remove-destination -- "$f" "$ws/$rel" || return 1
      # The backup kept the file's own mode; the agent writes the file as it did before the check.
      [ -L "$ws/$rel" ] || chmod g+rw -- "$ws/$rel" || return 1
    done < <(find "$bk/files" -mindepth 1 ! -type d -print0)
  fi
  rm -rf -- "$bk"
}
`;

export const BASE_REVERT_SCRIPT = `set -u
# What is put back is the agent's to read and write too (the directories hand their group down).
umask 007
${GIT_FN}${CHANGED_PATHS_FN}${RESTORE_FN}
${NEED_CONTROL}${NO_NESTED_REPO}ws="$MAKA_DIR/workspace"
wsreal=$(realpath -- "$ws") || exit 1
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
  inside "$ws/$p" || { echo "UNSAFE_PATH $p"; exit 0; }
  if [ -e "$p" ] || [ -L "$p" ]; then
    mkdir -p "$bk/files/$(dirname -- "$p")" && cp -a -- "$p" "$bk/files/$p" || exit 1
  fi
  printf '%s\\0' "$p" >> "$bk/reverted.tmp"
  count=$((count + 1))
done < "$bk/paths"
mv "$bk/reverted.tmp" "$bk/reverted"
while IFS= read -r -d '' p; do
  # An earlier path of this loop can have put a symlink where a directory of this one was.
  inside "$ws/$p" || { echo "UNSAFE_PATH $p"; exit 0; }
  rm -rf -- "$p"
  mode=$(g ls-tree "$MAKA_BASE" -- "$p" | cut -d' ' -f1)
  # Only a file or a link has a base version to put back (a directory's files are listed on their own).
  case "$mode" in 100644|100755|120000) ;; *) continue ;; esac
  mkdir -p "$(dirname -- "$p")"
  if [ "$mode" = 120000 ]; then ln -s "$(g cat-file blob "$MAKA_BASE:$p")" "$p"
  else
    g cat-file blob "$MAKA_BASE:$p" > "$p" || exit 1
    [ "$mode" = 100755 ] && chmod +x "$p"
  fi
done < "$bk/reverted"
# A test that cannot read a file of the checkout fails with an ordinary exit status, which would be
# taken for "the test fails on the base": refuse the base check when a file of the sandbox user's
# making is not the agent group's to read (the agent's own files are its own).
if [ -n "\${MAKA_AGENT_GROUP:-}" ]; then
  bad=$(find "$ws" -xdev ! -type l -user "$(id -u)" \\( ! -group "$MAKA_AGENT_GROUP" -o \\( -type d ! -perm -g+rx \\) -o \\( ! -type d ! -perm -g+r \\) \\) -print -quit)
  [ -z "$bad" ] || { echo "UNREADABLE_FOR_AGENT $bad"; exit 0; }
fi
echo "REVERTED $count"
`;

/** Puts the change back after a base check. Idempotent. Prints RESTORED. */
export const BASE_RESTORE_SCRIPT = `set -u
umask 007
${RESTORE_FN}
ws="$MAKA_DIR/workspace"
bk="$MAKA_DIR/base-check"
[ -d "$ws" ] || { echo RESTORED; exit 0; }
wsreal=$(realpath -- "$ws") || exit 1
restore && echo RESTORED || echo RESTORE_FAILED
`;

/**
 * The change against the base commit as git would commit it: \`RAW <base64 of diff --raw -z>\`,
 * then \`PATCH <bytes>\` with \`change.patch\` written to the task directory, then one
 * \`SIZE <sha> <bytes>\` per new blob. Prints \`ERR <what>\` when git fails.
 */
export const CHANGES_SCRIPT = `set -u
umask 077
${GIT_FN}
${NEED_CONTROL}cd "$MAKA_DIR/workspace" || { echo "ERR workspace"; exit 0; }
${NO_NESTED_REPO}idx="$MAKA_DIR/changes.index"
rm -f -- "$idx"
export GIT_INDEX_FILE="$idx"
g read-tree "$MAKA_BASE" 2>/dev/null || { echo "ERR base"; exit 0; }
g add -A . 2> "$MAKA_DIR/changes.err" || { echo "ERR add $(tail -c 300 "$MAKA_DIR/changes.err" | tr '\\n' ' ')"; exit 0; }
raw=$(g diff --cached --ignore-submodules=all --raw -z --no-renames --abbrev=40 "$MAKA_BASE" | base64 -w0) || { echo "ERR diff"; exit 0; }
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
[ -d "$MAKA_DIR/control.git" ] || exit 1
cd "$MAKA_DIR/workspace" || exit 1
g cat-file blob "$MAKA_SHA" | tail -c +$((MAKA_OFF + 1)) | head -c "$MAKA_LEN" | base64 -w0
`;

/** One chunk of \`change.patch\`. */
export const PATCH_CHUNK_SCRIPT = `set -u
cd "$MAKA_DIR" || exit 1
[ -f change.patch ] && [ ! -L change.patch ] || exit 1
tail -c +$((MAKA_OFF + 1)) change.patch | head -c "$MAKA_LEN" | base64 -w0
`;
