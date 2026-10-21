/**
 * What a setup snapshot must not carry. A snapshot is the whole disk of the builder box, and every box
 * made from it (for any task of the invite) boots from that disk, so the builder is cleaned before it is
 * saved: known credential, history and transcript paths in the homes of the sandbox user and the agent
 * account are removed, and so are other tasks' folders and untracked `.env`/`.npmrc` files in the
 * checkout. A second pass then only looks, and the snapshot is refused if it finds any.
 */

/** Paths relative to a home directory. */
export const SENSITIVE_HOME_PATHS = [
  '.ssh',
  '.aws',
  '.azure',
  '.config/gcloud',
  '.config/gh',
  '.config/claude',
  '.docker/config.json',
  '.kube/config',
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.yarnrc.yml',
  '.pypirc',
  '.claude',
  '.claude.json',
  '.codex',
  '.gnupg',
  '.bash_history',
  '.zsh_history',
  '.python_history',
  '.node_repl_history',
  '.psql_history',
  '.mysql_history',
  '.lesshst',
  '.viminfo',
] as const;

/** Folders whose contents belong to tasks, not to a setup (everything in them is removed). */
export const TASK_DIRS = ['/data/work', '/data/maka'] as const;

/** Under `TASK_DIRS`, these entries stay: the checkouts of the setups themselves. */
const KEPT_IN_TASK_DIRS = ['/data/maka/repos'] as const;

/**
 * Prints `FOUND <path>` for each sensitive path. With `MAKA_SCRUB_MODE=clean` it removes each one first
 * (as the user, then with `sudo -n` for what the agent account owns) and lists what is still there; with
 * `check` it only lists. Exits 7 when anything is listed in `check` mode, always 0 in `clean` mode.
 * Untracked `.env`, `.env.*` and `.npmrc` files in the checkout count (examples and tracked files do not).
 */
export const SCRUB_SCRIPT = scrubScript();

/** The script for other folders than the real ones; tests use it on a scratch tree. */
export function scrubScript(
  taskDirs: readonly string[] = TASK_DIRS,
  kept: readonly string[] = KEPT_IN_TASK_DIRS,
): string {
  return `set -u
mode="\${MAKA_SCRUB_MODE:-check}"
homes="\${HOME:-}"
if [ -n "\${MAKA_AGENT_USER:-}" ]; then
  agent_home="$(getent passwd "$MAKA_AGENT_USER" 2>/dev/null | cut -d: -f6)"
  [ -n "$agent_home" ] && homes="$homes $agent_home"
fi
found=0
note() { echo "FOUND $1"; found=1; }
drop() {
  [ "$mode" = clean ] || return 0
  rm -rf -- "$1" 2>/dev/null || sudo -n rm -rf -- "$1" 2>/dev/null || true
}
sweep() {
  [ -e "$1" ] || [ -L "$1" ] || return 0
  drop "$1"
  if [ -e "$1" ] || [ -L "$1" ]; then note "$1"; fi
}
for home in $homes; do
  [ -n "$home" ] || continue
  for rel in ${SENSITIVE_HOME_PATHS.join(' ')}; do
    sweep "$home/$rel"
  done
done
for dir in ${taskDirs.join(' ')}; do
  [ -d "$dir" ] || continue
  for entry in "$dir"/* "$dir"/.[!.]*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    case "$entry" in ${kept.map((entry) => `${entry})`).join(' ')} continue ;; esac
    sweep "$entry"
  done
done
if [ -n "\${MAKA_REPO_DIR:-}" ] && [ -d "$MAKA_REPO_DIR" ]; then
  find "$MAKA_REPO_DIR" -maxdepth 4 \\( -name .git -o -name node_modules \\) -prune -o \\
    -type f \\( -name .env -o -name '.env.*' -o -name .npmrc \\) -print 2>/dev/null | while IFS= read -r file; do
    case "$file" in *.example|*.sample|*.template|*.defaults) continue ;; esac
    if git -C "$MAKA_REPO_DIR" ls-files --error-unmatch -- "$file" >/dev/null 2>&1; then continue; fi
    echo "$file"
  done > "\${TMPDIR:-/tmp}/maka-scrub-env.$$"
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    sweep "$file"
  done < "\${TMPDIR:-/tmp}/maka-scrub-env.$$"
  rm -f -- "\${TMPDIR:-/tmp}/maka-scrub-env.$$"
fi
if [ "$mode" = check ] && [ "$found" = 1 ]; then exit 7; fi
exit 0
`;
}
