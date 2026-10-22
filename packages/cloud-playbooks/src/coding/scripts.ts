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
 *
 * Two scripts run as the agent's account instead, through `execCheck`: `BASE_REVERT_SCRIPT` and
 * `BASE_RESTORE_SCRIPT` edit the workspace, and the sandbox user must never write through a path
 * there (see `BASE_STAGE_SCRIPT`).
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
# A base check a closed process left half-way: its copy of the change belongs to the tree this
# clone replaces, and must not be put over the new one.
rm -rf -- "$MAKA_DIR/base-check" "$MAKA_DIR/base-stage"
mkdir "$tmp" && cd "$tmp" || exit 1
g init -q
if ! g fetch -q --depth=1 --no-tags "$MAKA_REPO_URL" "$MAKA_REF" > "$MAKA_DIR/clone.err" 2>&1; then
  echo CLONE_FAILED
  tail -c 2512 "$MAKA_DIR/clone.err"
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
 * the output on stdout, and \`BYTES <output bytes>\` and \`PERMS <lines>\` (the lines that match
 * \`$MAKA_PERMISSION_ERROR\`, over the whole output) on stderr. \`$MAKA_CHECK_TAG\` is an argument
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
  { tee >(grep -ciE -e "$MAKA_PERMISSION_ERROR" > "$mark/perms.part"; mv -f -- "$mark/perms.part" "$mark/perms") \\
    >(wc -c | sed 's/^/BYTES /' >&2) | tail -c "$MAKA_TAIL"; wait $!; }
rc=\${PIPESTATUS[0]}
isolated=0
[ -e "$mark/started" ] && isolated=1
# The count of lines with a permission error, over the whole output and not only its tail.
i=0
while [ ! -e "$mark/perms" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
[ -e "$mark/perms" ] && echo "PERMS $(cat -- "$mark/perms")" >&2
rm -rf -- "$mark"
if [ "$isolated" = 0 ]; then
  echo 'maka-check: the sandbox could not start the check in its own user and PID namespace (unshare --user --pid failed: the box must allow unprivileged user namespaces, which a container profile such as the Docker default seccomp refuses; no check can run until it does)' >&2
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

const UNDER_LINK_FN = `
# Whether a directory above the workspace path \$2 is a link: a removal or a write under it would
# follow the link out of the workspace (a kept path, or one the test put there).
under_link() {
  # Cut with the shell, not \$(dirname): a command substitution drops the newlines a name ends with.
  local d="$2"
  while :; do
    case "$d" in */*) d="\${d%/*}" ;; *) return 1 ;; esac
    [ -L "$1/$d" ] && return 0
  done
}
`;

/**
 * Puts the agent's copy of every reverted file back (the part of a base check that edits the
 * workspace, so it runs as the agent: see \`BASE_REVERT_SCRIPT\`). A leftover of an interrupted
 * check is put back by the same function. The backup directory itself belongs to the sandbox user,
 * who made it: only what is in it is emptied.
 */
const RESTORE_FN = `
${UNDER_LINK_FN}
restore() {
  [ -L "$bk" ] && return 1
  [ -d "$bk" ] || return 0
  if [ -f "$bk/reverted" ]; then
    local p
    while IFS= read -r -d '' p; do
      under_link "$ws" "$p" && return 1
      rm -rf -- "$ws/$p"
    done < "$bk/reverted"
    local f rel
    while IFS= read -r -d '' f; do
      rel="\${f#"$bk/files/"}"
      under_link "$ws" "$rel" && return 1
      mkdir -p -- "$(dirname -- "$ws/$rel")" && cp -a --remove-destination -- "$f" "$ws/$rel" || return 1
      # The backup kept the file's own mode; the agent writes the file as it did before the check.
      [ -L "$ws/$rel" ] || chmod g+rw -- "$ws/$rel" || return 1
    done < <(find "$bk/files" -mindepth 1 ! -type d -print0)
  fi
  find "$bk" -mindepth 1 -delete
}
`;

/**
 * The sandbox user's part of the base check: works out what the base version of every changed file
 * is, and hands it to the agent in \`$MAKA_DIR/base-stage\`. It runs as the sandbox user and so
 * never reads or writes a path in the workspace: the agent can swap a workspace directory for a
 * symlink at any moment (every task of a box shares one agent account), and no check of a path
 * holds until the next use of it. What it reads of the workspace goes through git against
 * \`control.git\`, which does not follow symlinked directories. The stage is made here, where the
 * agent cannot write, and only read: the list of paths (\`paths\`), their base modes (\`modes\`,
 * \`-\` for a path with no file or link in the base) and the base content of each as \`blobs/<n>\`
 * (n counts from 0), never a tree shaped like the paths. The backup directory \`base-check\` is made
 * here too, for the agent to write into. Files in \`$MAKA_KEEP\` (newline-separated: the
 * reproduction test) are left out. Prints \`STAGED <count>\`.
 */
export const BASE_STAGE_SCRIPT = `set -u
umask 027
${GIT_FN}${CHANGED_PATHS_FN}
${NEED_CONTROL}${NO_NESTED_REPO}ws="$MAKA_DIR/workspace"
st="$MAKA_DIR/base-stage"
bk="$MAKA_DIR/base-check"
nl=$'\\n'
keep="$nl\${MAKA_KEEP:-}$nl"
kept() {
  case "$1" in *"$nl"*) return 1 ;; esac
  case "$keep" in *"$nl$1$nl"*) return 0 ;; esac
  return 1
}
[ ! -L "$bk" ] || { echo "ERR base-check is a link"; exit 0; }
cd "$ws" || exit 1
rm -rf -- "$st"
mkdir -p "$st/blobs" || exit 1
changed_paths > "$st/all" || { echo LIST_FAILED; exit 0; }
: > "$st/paths"
: > "$st/modes"
n=0
while IFS= read -r -d '' p; do
  kept "$p" && continue
  mode=$(g ls-tree "$MAKA_BASE" -- "$p" | cut -d' ' -f1)
  printf '%s\\0' "$p" >> "$st/paths"
  # Only a file or a link has a base version to put back (a directory's files are listed on their own).
  case "$mode" in
    100644|100755|120000)
      g cat-file blob "$MAKA_BASE:$p" > "$st/blobs/$n" || { echo STAGE_FAILED; exit 0; }
      printf '%s\\0' "$mode" >> "$st/modes" ;;
    *) printf '%s\\0' - >> "$st/modes" ;;
  esac
  n=$((n + 1))
done < "$st/all"
rm -f -- "$st/all"
# A test that cannot read a file of the checkout fails with an ordinary exit status, which would be
# taken for "the test fails on the base": refuse the base check when a file of the sandbox user's
# making is not the agent group's to read (the agent's own files are its own). find does not
# follow links.
if [ -n "\${MAKA_AGENT_GROUP:-}" ]; then
  bad=$(find "$ws" -xdev ! -type l -user "$(id -u)" \\( ! -group "$MAKA_AGENT_GROUP" -o \\( -type d ! -perm -g+rx \\) -o \\( ! -type d ! -perm -g+r \\) \\) -print -quit)
  [ -z "$bad" ] || { printf 'UNREADABLE_FOR_AGENT %q\\n' "$bad"; exit 0; }
fi
# The agent reads the stage and writes the backup; the stage is not the agent's to change.
mkdir -p -- "$bk" || exit 1
if [ -n "\${MAKA_AGENT_GROUP:-}" ]; then
  chgrp -R -- "$MAKA_AGENT_GROUP" "$st" && chgrp -- "$MAKA_AGENT_GROUP" "$bk" || exit 1
fi
chmod 2750 "$st" "$st/blobs" && chmod 2770 "$bk" || exit 1
echo "STAGED $n"
`;

/**
 * The agent's part of the base check: runs as the agent's account (\`execCheck\`) because it edits
 * the agent's workspace, where a sandbox-user write could be sent through a symlink the agent put
 * there. Backs up every staged path into \`base-check\`, then removes it and puts the staged base
 * version in its place. A leftover of an interrupted check must be put back (\`BASE_RESTORE_SCRIPT\`)
 * before the stage is made, since the stage lists what differs from the base. Prints
 * \`REVERTED <count>\`.
 */
export const BASE_REVERT_SCRIPT = `set -u
${UNDER_LINK_FN}
# What is put back is the agent's own; the sandbox user is in its group and reads and removes it.
umask 007
ws="$MAKA_DIR/workspace"
bk="$MAKA_DIR/base-check"
st="$MAKA_DIR/base-stage"
cd "$ws" || exit 1
[ -d "$bk" ] && [ ! -L "$bk" ] && [ ! -e "$bk/reverted" ] || { echo RESTORE_FAILED; exit 0; }
[ -f "$st/paths" ] && [ -f "$st/modes" ] || { echo LIST_FAILED; exit 0; }
mkdir -p "$bk/files" || exit 1
: > "$bk/reverted.tmp" || exit 1
count=0
while IFS= read -r -d '' p; do
  case "/$p/" in //*|*/../*|*/./*) printf 'UNSAFE_PATH %q\\n' "$p"; exit 0 ;; esac
  under_link "$ws" "$p" && { printf 'UNSAFE_PATH %q\\n' "$p"; exit 0; }
  if [ -e "$p" ] || [ -L "$p" ]; then
    mkdir -p "$bk/files/$(dirname -- "$p")" && cp -a -- "$p" "$bk/files/$p" || exit 1
  fi
  printf '%s\\0' "$p" >> "$bk/reverted.tmp"
  count=$((count + 1))
done < "$st/paths"
mv "$bk/reverted.tmp" "$bk/reverted" || exit 1
# Everything goes first, and only then is the base put in: a link of the base put back before a path
# under it is removed would have that removal follow the link out of the workspace.
while IFS= read -r -d '' p; do rm -rf -- "$p"; done < "$st/paths"
n=0
exec 3< "$st/paths" 4< "$st/modes"
while IFS= read -r -d '' p <&3 && IFS= read -r -d '' mode <&4; do
  i=$n
  n=$((n + 1))
  case "$mode" in 100644|100755|120000) ;; *) continue ;; esac
  mkdir -p "$(dirname -- "$p")"
  if [ "$mode" = 120000 ]; then ln -s -- "$(cat -- "$st/blobs/$i")" "$p" || exit 1
  else
    cat -- "$st/blobs/$i" > "$p" || exit 1
    [ "$mode" = 100755 ] && chmod +x "$p"
  fi
done
# A link put back must lead inside the workspace, or nowhere: through one that leads out, or past a
# directory the agent cannot search, the test meets a permission error, an ordinary exit status that
# would be taken for "the test fails on the base". Resolved as the agent, after every link is back.
wsr=$(pwd -P) || exit 1
exec 3< "$st/paths" 4< "$st/modes"
while IFS= read -r -d '' p <&3 && IFS= read -r -d '' mode <&4; do
  [ "$mode" = 120000 ] || continue
  if to=$(LC_ALL=C realpath -e -- "$p" 2>&1); then
    case "$to/" in "$wsr"/*) continue ;; esac
  else
    case "$to" in *": No such file or directory"|*": Not a directory") continue ;; esac
  fi
  printf 'LINK_LEADS_OUT %q\\n' "$p"
  exit 0
done
echo "REVERTED $count"
`;

/**
 * Puts the change back after a base check. Idempotent. Prints RESTORED. It moves the agent's own
 * backup into the agent's workspace, so it runs as the agent's account (\`execCheck\`), like the revert.
 */
export const BASE_RESTORE_SCRIPT = `set -u
umask 007
${RESTORE_FN}
ws="$MAKA_DIR/workspace"
bk="$MAKA_DIR/base-check"
[ -d "$ws" ] || { echo RESTORED; exit 0; }
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
g add -A . 2> "$MAKA_DIR/changes.err" || { echo "ERR add $(tail -c 812 "$MAKA_DIR/changes.err" | tr '\\n' ' ')"; exit 0; }
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
