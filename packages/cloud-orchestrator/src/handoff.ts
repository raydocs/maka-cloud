import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ResultManifest, ResultManifestSchema, type TaskId } from './types.js';

export const MAX_BRIEF_BYTES = 256 * 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * Never follow a symlink, and never block opening a FIFO. Whatever is opened is
 * then checked through the descriptor, not through the path.
 */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export interface HandoffPaths {
  dir: string;
  briefPath: string;
  resultPath: string;
}

/**
 * Tasks hand work over as files: `brief.md` going down, `result.json` coming
 * back. Never a transcript.
 */
export class Handoff {
  constructor(private readonly root: string) {}

  paths(taskId: TaskId): HandoffPaths {
    if (!/^[A-Za-z0-9_-]+$/u.test(taskId)) throw new Error(`Unsafe task id: ${taskId}`);
    const dir = join(this.root, taskId);
    return { dir, briefPath: join(dir, 'brief.md'), resultPath: join(dir, 'result.json') };
  }

  async writeBrief(taskId: TaskId, brief: string): Promise<HandoffPaths> {
    if (Buffer.byteLength(brief, 'utf8') > MAX_BRIEF_BYTES) {
      throw new Error(`Brief exceeds ${MAX_BRIEF_BYTES} bytes`);
    }
    const paths = this.paths(taskId);
    await mkdir(this.root, { recursive: true });
    // Not recursive: the task dir must be new, so nothing already sitting at the
    // path (a symlink, say) is ever written through. Owner only.
    await mkdir(paths.dir, { mode: 0o700 });
    await writeFile(paths.briefPath, brief, { flag: 'wx' });
    return paths;
  }

  /** Removes the files of a task that was never recorded. Best effort. */
  async discard(taskId: TaskId): Promise<void> {
    await rm(this.paths(taskId).dir, { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * O_NOFOLLOW only covers the last component of `result.json`, so the task dir
   * is checked here: it must be a real directory, and it must resolve to where
   * it should under the handoff root.
   *
   * This leaves a window between the check and the open. It is acceptable
   * because runners never get write access to the handoff root (T6 rule), so
   * nothing that runs inside a task can swap the directory; the check guards
   * against a runner that was handed too much, it is not the access control.
   */
  private async checkTaskDir(taskId: TaskId, dir: string): Promise<string | undefined> {
    try {
      const info = await lstat(dir);
      if (info.isSymbolicLink()) return 'task directory is a symbolic link';
      if (!info.isDirectory()) return 'task directory is not a directory';
      if ((await realpath(dir)) !== join(await realpath(this.root), taskId)) {
        return 'task directory resolves outside the handoff root';
      }
    } catch {
      return 'task directory could not be checked';
    }
    return undefined;
  }

  /** Returns the validated manifest, or a reason it could not be accepted. */
  async readManifest(
    taskId: TaskId,
  ): Promise<{ ok: true; manifest: ResultManifest } | { ok: false; reason: string }> {
    const { dir, resultPath } = this.paths(taskId);
    const unsafe = await this.checkTaskDir(taskId, dir);
    if (unsafe !== undefined) return { ok: false, reason: `invalid manifest: ${unsafe}` };
    let text: string;
    let file;
    try {
      file = await open(resultPath, READ_FLAGS);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ELOOP') {
        return { ok: false, reason: 'invalid manifest: result.json is a symbolic link' };
      }
      if (code === 'ENOENT') {
        return { ok: false, reason: 'invalid manifest: result.json was not written' };
      }
      return { ok: false, reason: 'invalid manifest: result.json could not be opened' };
    }
    try {
      if (!(await file.stat()).isFile()) {
        return { ok: false, reason: 'invalid manifest: result.json is not a regular file' };
      }
      // The file can grow while it is read, so the cap applies to the bytes read, not to a size seen earlier.
      const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_MANIFEST_BYTES) {
        return { ok: false, reason: `invalid manifest: larger than ${MAX_MANIFEST_BYTES} bytes` };
      }
      text = buffer.toString('utf8', 0, length);
    } catch {
      return { ok: false, reason: 'invalid manifest: result.json could not be read' };
    } finally {
      await file.close().catch(() => undefined);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'invalid manifest: result.json is not valid JSON' };
    }
    const parsed = ResultManifestSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.join('.') || '(root)';
      return { ok: false, reason: `invalid manifest: ${where}: ${issue?.message ?? 'rejected'}` };
    }
    return { ok: true, manifest: parsed.data };
  }
}
