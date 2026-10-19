import { createHash } from 'node:crypto';
import {
  CHANGES_SCRIPT,
  CLONE_SCRIPT,
  PATCH_CHUNK_SCRIPT,
  type SandboxWorkspace,
} from '@maka-cloud/playbooks/coding';
import { DriverError, type Outcome } from './types.js';

export interface PatchLimits {
  /** Changed files a patch may hold. */
  maxFiles: number;
  /** Bytes of one new or changed file. */
  maxFileBytes: number;
  /** Bytes of all changed files together. */
  maxTotalBytes: number;
  /** Bytes of the patch. */
  maxPatchBytes: number;
}

/** The same caps as the coding playbook's delivery, so every subject is held to one rule. */
export const DEFAULT_PATCH_LIMITS: PatchLimits = {
  maxFiles: 300,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxPatchBytes: 1024 * 1024,
};

const CHUNK_BYTES = 192 * 1024;

function isRepoPath(path: string): boolean {
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.includes('\n'))
    return false;
  const parts = path.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..') && parts[0] !== '.git';
}

export function outcomeOf(patch: string, files: string[]): Outcome {
  return { patch, files, sha256: createHash('sha256').update(patch).digest('hex') };
}

/** Fetches one commit into a fresh workspace and returns its full sha. */
export async function cloneAt(
  ws: SandboxWorkspace,
  repoUrl: string,
  ref: string,
  signal: AbortSignal,
): Promise<string> {
  const out = await ws.exec(CLONE_SCRIPT, {
    envs: { MAKA_DIR: ws.dir, MAKA_REPO_URL: repoUrl, MAKA_REF: ref },
    timeoutSeconds: 600,
    signal,
  });
  const base = /^BASE ([0-9a-f]{40})$/mu.exec(out.stdout);
  if (!base) {
    const detail = out.stdout
      .replace(/^CLONE_FAILED\s*/u, '')
      .trim()
      .slice(0, 500);
    throw new DriverError(`could not fetch ${repoUrl} at ${ref}${detail ? `: ${detail}` : ''}`);
  }
  return base[1] as string;
}

/**
 * Reads the change out of the workspace as git would commit it, over exec as the sandbox user
 * (never `GET /files`, which reads as root). A symlink, a submodule, an unsafe path or a size
 * over a cap refuses the change, with the reason.
 */
export async function collectPatch(
  ws: SandboxWorkspace,
  baseSha: string,
  limits: PatchLimits,
  signal: AbortSignal,
): Promise<Outcome | { reason: string }> {
  const out = await ws.exec(CHANGES_SCRIPT, {
    envs: { MAKA_DIR: ws.dir, MAKA_BASE: baseSha },
    timeoutSeconds: 120,
    signal,
  });
  if (out.truncated) return { reason: 'the change is too large to read' };
  const lines = out.stdout.split('\n');
  const err = lines.find((line) => line.startsWith('ERR '));
  if (err) return { reason: `git could not list the change (${err.slice(4)})` };
  const raw = lines.find((line) => line.startsWith('RAW '));
  const patchLine = lines.find((line) => line.startsWith('PATCH '));
  if (raw === undefined || patchLine === undefined)
    return { reason: 'git could not list the change' };
  const sizes = new Map<string, number>();
  for (const line of lines) {
    const match = /^SIZE ([0-9a-f]{40}) (\d+)$/u.exec(line);
    if (match) sizes.set(match[1] as string, Number(match[2]));
  }
  const fields = Buffer.from(raw.slice(4), 'base64').toString('utf8').split('\0');
  const files: string[] = [];
  let total = 0;
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])$/u.exec(
      fields[i] as string,
    );
    if (!meta) return { reason: 'git listed the change in an unexpected form' };
    const path = fields[i + 1] as string;
    const mode = meta[2] as string;
    const status = meta[5] as string;
    if (!isRepoPath(path)) return { reason: `the change has an unsafe path: ${path}` };
    files.push(path);
    if (status === 'D') continue;
    if (mode === '120000') return { reason: `${path} is a symlink; symlinks are not graded` };
    if (mode === '160000') return { reason: `${path} is a nested repository` };
    if (mode !== '100644' && mode !== '100755')
      return { reason: `${path} has an unsupported file mode ${mode}` };
    const size = sizes.get(meta[4] as string);
    if (size === undefined) return { reason: `${path} could not be read` };
    if (size > limits.maxFileBytes)
      return { reason: `${path} is ${size} bytes, more than ${limits.maxFileBytes}` };
    total += size;
    if (total > limits.maxTotalBytes)
      return { reason: `the changed files are larger than ${limits.maxTotalBytes} bytes together` };
  }
  if (files.length === 0) return { reason: 'there is no change against the base commit' };
  if (files.length > limits.maxFiles)
    return { reason: `the change touches ${files.length} files, more than ${limits.maxFiles}` };
  const patchBytes = Number(patchLine.slice(6));
  if (!Number.isSafeInteger(patchBytes) || patchBytes < 0)
    return { reason: 'git could not size the change' };
  if (patchBytes > limits.maxPatchBytes)
    return { reason: `the patch is ${patchBytes} bytes, more than ${limits.maxPatchBytes}` };
  const parts: Buffer[] = [];
  for (let offset = 0; offset < patchBytes; offset += CHUNK_BYTES) {
    const chunk = await ws.exec(PATCH_CHUNK_SCRIPT, {
      envs: {
        MAKA_DIR: ws.dir,
        MAKA_OFF: String(offset),
        MAKA_LEN: String(Math.min(CHUNK_BYTES, patchBytes - offset)),
      },
      timeoutSeconds: 60,
      signal,
    });
    if (chunk.exitCode !== 0)
      throw new DriverError(`reading the patch failed (exit ${chunk.exitCode})`);
    parts.push(Buffer.from(chunk.stdout.trim(), 'base64'));
  }
  const bytes = Buffer.concat(parts);
  if (bytes.length !== patchBytes) return { reason: 'the patch changed while it was read' };
  return outcomeOf(bytes.toString('utf8'), files);
}
