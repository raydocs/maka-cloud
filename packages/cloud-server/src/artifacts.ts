import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_REF_LENGTH = 512;
const MAX_NAME_LENGTH = 120;

/** Where the bytes behind a manifest's artifact reference come from. */
export interface ArtifactSource {
  /**
   * Reads one reference of one task. A reference is a string the task wrote, so
   * a source treats it as hostile and answers `not_found` for anything it will
   * not read, whatever the reason.
   */
  read(taskId: string, ref: string): Promise<ArtifactRead>;
}

export type ArtifactRead =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: 'not_found' | 'too_large' };

export type ArtifactKind = 'file' | 'link';

export interface ArtifactListing {
  index: number;
  name: string;
  kind: ArtifactKind;
  /** Only for a link. It is shown to the client and never fetched by the server. */
  url?: string;
}

/** A plain `https:` URL without credentials is a link; anything else is read as a path. */
export function linkOf(ref: string): string | undefined {
  if (!/^https:\/\//iu.test(ref) || ref.length > MAX_REF_LENGTH) return undefined;
  try {
    const url = new URL(ref);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function listArtifact(ref: string, index: number): ArtifactListing {
  const link = linkOf(ref);
  if (link !== undefined) {
    return { index, name: displayName(new URL(link).host), kind: 'link', url: link };
  }
  return { index, name: displayName(ref.split('/').at(-1) ?? ''), kind: 'file' };
}

/** A name safe to show and to put in a header: no control characters, no path, bounded. */
export function displayName(raw: string): string {
  const name = raw.replace(/[^\w.@+-]+/gu, '_').slice(0, MAX_NAME_LENGTH);
  return name === '' || /^\.+$/u.test(name) ? 'artifact' : name;
}

/** The path components of a reference, or nothing when it is not a plain relative path. */
export function relativeParts(ref: string): string[] | undefined {
  if (ref === '' || ref.length > MAX_REF_LENGTH || ref.includes('\0') || ref.includes('\\')) {
    return undefined;
  }
  if (ref.startsWith('/') || /^[A-Za-z]:/u.test(ref)) return undefined;
  const parts = ref.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return undefined;
  return parts;
}

/** Never follow a symlink and never block on a FIFO; what was opened is checked through the descriptor. */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * Reads artifacts from a task's handoff directory and nothing else. Every path
 * component is `lstat`ed and may not be a symlink, the file must be a regular
 * file, the resolved path must stay inside the task's directory, and the size is
 * checked on the open descriptor. Runners never get write access to the handoff
 * root (T6 rule), so these checks guard against a runner that was handed too much.
 * Sources that live in a sandbox plug in through `ArtifactSource` instead.
 */
export class FileArtifactSource implements ArtifactSource {
  private readonly maxBytes: number;

  constructor(
    private readonly root: string,
    options: { maxBytes?: number } = {},
  ) {
    this.maxBytes = options.maxBytes ?? MAX_ARTIFACT_BYTES;
  }

  async read(taskId: string, ref: string): Promise<ArtifactRead> {
    const parts = relativeParts(ref);
    if (parts === undefined || !/^[A-Za-z0-9_-]+$/u.test(taskId)) return NOT_FOUND;
    try {
      const dir = join(this.root, taskId);
      let path = dir;
      if (!(await lstat(dir)).isDirectory()) return NOT_FOUND;
      for (const [i, part] of parts.entries()) {
        path = join(path, part);
        const info = await lstat(path);
        if (info.isSymbolicLink()) return NOT_FOUND;
        if (i < parts.length - 1 ? !info.isDirectory() : !info.isFile()) return NOT_FOUND;
      }
      const inside = join(await realpath(this.root), taskId);
      if (!(await realpath(path)).startsWith(`${inside}/`)) return NOT_FOUND;
      return await this.readFile(path);
    } catch {
      return NOT_FOUND;
    }
  }

  private async readFile(path: string): Promise<ArtifactRead> {
    const file = await open(path, READ_FLAGS);
    try {
      const info = await file.stat();
      if (!info.isFile()) return NOT_FOUND;
      if (info.size > this.maxBytes) return { ok: false, reason: 'too_large' };
      // Read one byte past the cap: a file that grew since `stat` is still refused.
      const buffer = Buffer.allocUnsafe(this.maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > this.maxBytes) return { ok: false, reason: 'too_large' };
      return { ok: true, bytes: Buffer.from(buffer.subarray(0, length)) };
    } finally {
      await file.close();
    }
  }
}

const NOT_FOUND: ArtifactRead = { ok: false, reason: 'not_found' };
