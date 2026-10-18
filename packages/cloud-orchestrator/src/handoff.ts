import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ResultManifest, ResultManifestSchema, type TaskId } from './types.js';

export const MAX_BRIEF_BYTES = 256 * 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;

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
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.briefPath, brief, { flag: 'wx' });
    return paths;
  }

  /** Returns the validated manifest, or a reason it could not be accepted. */
  async readManifest(
    taskId: TaskId,
  ): Promise<{ ok: true; manifest: ResultManifest } | { ok: false; reason: string }> {
    const { resultPath } = this.paths(taskId);
    let text: string;
    try {
      const info = await stat(resultPath);
      if (info.size > MAX_MANIFEST_BYTES) {
        return { ok: false, reason: `invalid manifest: larger than ${MAX_MANIFEST_BYTES} bytes` };
      }
      text = await readFile(resultPath, 'utf8');
    } catch {
      return { ok: false, reason: 'invalid manifest: result.json was not written' };
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
