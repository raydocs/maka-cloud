import { randomBytes } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RemoteMachine } from './machine.js';
import { isPlainPath } from './inputs.js';

/** What the runner exports from a task's workspace into its handoff directory. */
export const MAX_EXPORT_FILES = 20;
export const MAX_EXPORT_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_EXPORT_TOTAL_BYTES = 8 * 1024 * 1024;

/**
 * The runner adds one line with this prefix to a finished task's `done`: the artifacts it exported
 * to the handoff directory, as space-separated relative paths. A model cannot put it there: the
 * runner drops every `done` entry that starts this way before adding its own. A playbook that needs
 * to know a file really is in the handoff directory reads this line, since a manifest checker sees
 * the manifest only.
 */
export const EXPORTED_PREFIX = 'runner-exported:';

/**
 * A `done` entry that starts this way says the playbook kept a change for the owner instead of
 * delivering it. Only the playbook's own host code writes it, so a manifest an agent wrote loses
 * every such line before the runner hands it on.
 */
export const KEPT_PREFIX = 'kept:';

export interface ExportLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_EXPORT_LIMITS: ExportLimits = {
  maxFiles: MAX_EXPORT_FILES,
  maxFileBytes: MAX_EXPORT_FILE_BYTES,
  maxTotalBytes: MAX_EXPORT_TOTAL_BYTES,
};

export type ExportOutcome = { ok: true; exported: string[] } | { ok: false; reason: string };

/**
 * Writes `bytes` to `<handoffDir>/<ref>` and nowhere else. This is host code writing validated
 * bytes into the handoff directory the orchestrator made (mode 0700); the sandbox still has no
 * write access to it. Every directory on the way must be a real directory (not a symlink) or is
 * created 0700, the file is written 0600 to a temporary name and renamed over a regular file or
 * nothing, and `reserved` names (the brief and the manifest) are never replaced.
 */
export async function writeHandoffFile(
  handoffDir: string,
  ref: string,
  bytes: Buffer,
  reserved: readonly string[],
): Promise<void> {
  if (!isPlainPath(ref)) throw new Error('not a plain relative path');
  const parts = ref.split('/');
  if (reserved.includes(parts[0] as string)) throw new Error('that name is reserved');
  await requireDirectory(handoffDir, 'the task directory');
  let dir = handoffDir;
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    const info = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (info === undefined) {
      await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    }
    await requireDirectory(dir, part);
  }
  const target = join(dir, parts.at(-1) as string);
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (existing !== undefined && !existing.isFile()) {
    throw new Error('something that is not a regular file is already there');
  }
  const temp = join(dir, `.export-${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function requireDirectory(path: string, what: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`${what} is a symbolic link`);
  if (!info.isDirectory()) throw new Error(`${what} is not a directory`);
}

/** Why one ref cannot be exported at all, before the sandbox is asked. */
function unexportable(ref: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(ref)) return 'it is a link, not a file';
  return isPlainPath(ref) ? undefined : 'it is not a plain path relative to the workspace';
}

/**
 * Exports the artifacts a finished task listed in its manifest, from its workspace (read as the
 * sandbox user) into `handoffDir`, under the same relative path the manifest names, so a reader
 * that resolves a manifest entry under the task's handoff directory finds the file. Links are left
 * alone. A `required` artifact that is not listed or cannot be exported makes the whole export
 * fail; any other that cannot is reported through `note` and skipped.
 */
export async function exportArtifacts(input: {
  machine: RemoteMachine;
  taskId: string;
  handoffDir: string;
  reserved: readonly string[];
  listed: readonly string[];
  required: readonly string[];
  limits?: ExportLimits;
  signal: AbortSignal;
  note(text: string): void;
}): Promise<ExportOutcome> {
  const limits = input.limits ?? DEFAULT_EXPORT_LIMITS;
  for (const ref of input.required) {
    if (!input.listed.includes(ref)) {
      return { ok: false, reason: `the manifest does not list ${ref}, which the brief requires` };
    }
  }
  // Required files first, so the cap on the count can never leave one out.
  const order = [
    ...input.required,
    ...input.listed.filter((ref) => !input.required.includes(ref)),
  ].filter((ref, index, all) => all.indexOf(ref) === index);
  const exported: string[] = [];
  let total = 0;
  let considered = 0;
  for (const ref of order) {
    const mustWork = input.required.includes(ref);
    const skip = (why: string): ExportOutcome | undefined => {
      if (mustWork)
        return { ok: false, reason: `required artifact ${ref} was not exported: ${why}` };
      if (!/^https:\/\//iu.test(ref)) input.note(`artifact ${ref} was not exported: ${why}`);
      return undefined;
    };
    const unusable = unexportable(ref);
    if (unusable !== undefined) {
      const failed = skip(unusable);
      if (failed) return failed;
      continue;
    }
    if (considered >= limits.maxFiles) {
      const failed = skip(`more than ${limits.maxFiles} artifacts are listed`);
      if (failed) return failed;
      continue;
    }
    considered++;
    if (input.signal.aborted) throw input.signal.reason;
    const room = Math.min(limits.maxFileBytes, limits.maxTotalBytes - total);
    const read = await input.machine.readWorkspaceFile(input.taskId, ref, room, input.signal);
    if (!read.ok) {
      const tooBig = room < limits.maxFileBytes && /^it is larger than/u.test(read.reason);
      const failed = skip(
        tooBig ? `the artifacts together would be over ${limits.maxTotalBytes} bytes` : read.reason,
      );
      if (failed) return failed;
      continue;
    }
    try {
      await writeHandoffFile(input.handoffDir, ref, read.bytes, input.reserved);
    } catch (error) {
      const failed = skip(error instanceof Error ? error.message : String(error));
      if (failed) return failed;
      continue;
    }
    total += read.bytes.length;
    exported.push(ref);
  }
  if (exported.length > 0) {
    input.note(`${exported.length} artifact${exported.length === 1 ? '' : 's'} exported`);
  }
  return { ok: true, exported };
}

/**
 * The manifest as the orchestrator will read it: any `done` entry that claims an export is
 * dropped (it is the runner's to make), and the runner's own line is added when something was
 * exported. Bytes that need no change are returned as they are.
 */
export function attestExports(bytes: Buffer, exported: readonly string[]): Buffer {
  const manifest = JSON.parse(bytes.toString('utf8')) as { done: string[] };
  const kept = manifest.done.filter((entry) => {
    const line = entry.trimStart();
    return !line.startsWith(EXPORTED_PREFIX) && !line.startsWith(KEPT_PREFIX);
  });
  if (kept.length === manifest.done.length && exported.length === 0) return bytes;
  manifest.done =
    exported.length > 0 ? [...kept, `${EXPORTED_PREFIX} ${exported.join(' ')}`] : kept;
  return Buffer.from(JSON.stringify(manifest));
}
