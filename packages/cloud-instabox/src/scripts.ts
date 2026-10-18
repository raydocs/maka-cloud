import { randomUUID } from 'node:crypto';

/**
 * Helper scripts run through `exec` (`bash -lc`). Parameters travel in `envs`, never in
 * the command text, so file names and patterns need no quoting. Every script frames
 * its result as `<marker><field>\0<field>\0...<marker>` so login-profile output around
 * it cannot be mistaken for a result. Scripts exit 0 after framing an `ERR` field;
 * a non-zero exit means the script itself broke.
 */

export function newMarker(): string {
  return `@@maka-${randomUUID()}@@`;
}

export function parseFramed(stdout: string, marker: string): string[] | undefined {
  const start = stdout.indexOf(marker);
  if (start < 0) return undefined;
  const end = stdout.indexOf(marker, start + marker.length);
  if (end < 0) return undefined;
  const fields = stdout.slice(start + marker.length, end).split('\0');
  fields.pop();
  return fields;
}

const FAIL = `
M="$MAKA_M"
fail() { printf '%s' "$M"; printf 'ERR\\0%s\\0' "$1"; printf '%s' "$M"; exit 0; }
`;

/** MAKA_MODE: existing | writable | entry. Prints OK, root, path, "<type>|<size>". */
export const RESOLVE_SCRIPT = `${FAIL}
cd -- "$MAKA_CWD" 2>/dev/null || fail "No such file or directory: $MAKA_CWD"
root=$(realpath -e -- "$MAKA_CWD" 2>&1) || fail "$root"
case "$MAKA_MODE" in
  existing) p=$(realpath -e -- "$MAKA_PATH" 2>&1) || fail "$p" ;;
  writable) p=$(realpath -m -- "$MAKA_PATH" 2>&1) || fail "$p" ;;
  entry)
    d=$(realpath -m -- "$(dirname -- "$MAKA_PATH")" 2>&1) || fail "$d"
    p="\${d%/}/$(basename -- "$MAKA_PATH")" ;;
  *) fail "unknown mode" ;;
esac
st=""
if [ "$MAKA_MODE" = existing ]; then st=$(stat -c '%F|%s' -- "$p" 2>&1) || fail "$st"; fi
printf '%s' "$M"; printf 'OK\\0%s\\0%s\\0%s\\0' "$root" "$p" "$st"; printf '%s' "$M"
`;

/** Reads MAKA_LENGTH bytes at MAKA_OFFSET of a regular file as one base64 field. */
export const READ_CHUNK_SCRIPT = `${FAIL}
[ -f "$MAKA_PATH" ] || fail "not a regular file: $MAKA_PATH"
printf '%s' "$M"; printf 'OK\\0'
tail -c +"$((MAKA_OFFSET + 1))" -- "$MAKA_PATH" | head -c "$MAKA_LENGTH" | base64 -w0
printf '\\0%s' "$M"
`;

/**
 * One chunk of an atomic write. Chunks arrive as base64 on stdin and append to a temp
 * file beside the target; the last chunk checks the byte count, copies the target's mode
 * and renames over it. The target is untouched until that final \`mv\`.
 * MAKA_FIRST / MAKA_LAST: "1" on the first / last chunk.
 */
export const WRITE_CHUNK_SCRIPT = `
T="$MAKA_TMP"
drop() { rm -f -- "$T"; exit "$1"; }
if [ "$MAKA_FIRST" = 1 ]; then
  set -C
  : > "$T" || exit 1
  set +C
fi
base64 -d >> "$T" || drop 2
if [ "$MAKA_LAST" = 1 ]; then
  [ "$(stat -c %s -- "$T")" = "$MAKA_SIZE" ] || drop 3
  if [ -e "$MAKA_PATH" ]; then chmod --reference="$MAKA_PATH" -- "$T" 2>/dev/null; fi
  mv -fT -- "$T" "$MAKA_PATH" || drop 4
fi
`;

export const REMOVE_TEMP_SCRIPT = `rm -f -- "$MAKA_TMP"`;

/**
 * Lists entries below MAKA_SUB (relative to MAKA_CWD) as NUL-separated paths, then find's
 * exit status as the last field. A MAKA_SUB that is not a directory lists nothing.
 */
export const LIST_SCRIPT = `${FAIL}
cd -- "$MAKA_CWD" 2>/dev/null || fail "No such file or directory: $MAKA_CWD"
if [ ! -d "$MAKA_SUB" ]; then printf '%s0\\0%s' "$M" "$M"; exit 0; fi
printf '%s' "$M"
find "$MAKA_SUB" -printf '%p\\0'
rc=$?
printf '%s\\0%s' "$rc" "$M"
`;

/** Kills every process of an aborted command, found by the token in its environment. */
export const KILL_SCRIPT = `
for d in /proc/[0-9]*; do
  if tr '\\0' '\\n' < "$d/environ" 2>/dev/null | grep -qxF "MAKA_EXEC_TOKEN=$MAKA_KILL_TOKEN"; then
    kill -KILL "\${d#/proc/}" 2>/dev/null
  fi
done
exit 0
`;
