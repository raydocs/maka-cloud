import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface WorkspaceSpec {
  tenantId: string;
  workerId: string;
  repoUrl: string;
  ref?: string;
  workDir?: string;
  /** LayerFS only: refuse if true (no FUSE/Docker in this slice). */
  liveMount?: boolean;
  seedFiles?: Record<string, string>;
  forkOf?: string;
}

export interface WorkspaceHandle {
  id: string;
  kind: 'git-clone' | 'layerfs';
  dir: string | null;
}

export interface SnapshotRef {
  id: string;
}

export interface WorkspaceStore {
  readonly kind: 'git-clone' | 'layerfs';
  prepare(spec: WorkspaceSpec): Promise<WorkspaceHandle>;
  snapshot(handle: WorkspaceHandle): Promise<SnapshotRef>;
  exportPatch(handle: WorkspaceHandle): Promise<string>;
  release(handle: WorkspaceHandle): Promise<void>;
}

export class GitCloneStore implements WorkspaceStore {
  readonly kind = 'git-clone' as const;

  async prepare(spec: WorkspaceSpec): Promise<WorkspaceHandle> {
    const dir = spec.workDir ?? (await mkdtemp(join(tmpdir(), 'maka-ws-')));
    await run('git', ['clone', spec.repoUrl, dir]);
    if (spec.ref) await run('git', ['-C', dir, 'checkout', spec.ref]);
    return { id: `git:${spec.workerId}`, kind: 'git-clone', dir };
  }

  async snapshot(handle: WorkspaceHandle): Promise<SnapshotRef> {
    if (!handle.dir) throw new Error('GitCloneStore snapshot needs a directory.');
    const { stdout } = await run('git', ['-C', handle.dir, 'rev-parse', 'HEAD']);
    return { id: stdout.trim() };
  }

  async exportPatch(handle: WorkspaceHandle): Promise<string> {
    if (!handle.dir) throw new Error('GitCloneStore exportPatch needs a directory.');
    const { stdout } = await run('git', ['-C', handle.dir, 'diff', 'HEAD']);
    return stdout;
  }

  async release(handle: WorkspaceHandle): Promise<void> {
    if (!handle.dir) return;
    await rm(handle.dir, { recursive: true, force: true });
  }
}

export class LayerFsDisabledError extends Error {
  constructor() {
    super('LayerFS is off (MAKA_CLOUD_LAYERFS is unset). GitCloneStore is the default.');
    this.name = 'LayerFsDisabledError';
  }
}

export class LayerFsMountUnsupportedError extends Error {
  constructor() {
    super(
      'LayerFS live mount is not available in this slice: no FUSE, Docker or LayerFS server is started. See docs/fork/architecture/superagent.md §10.',
    );
    this.name = 'LayerFsMountUnsupportedError';
  }
}

interface LayerBranch {
  files: Record<string, string>;
  parent?: string;
}

/**
 * Metadata-only LayerFS adapter. Records branches and forks. Does not start a
 * server, FUSE daemon or Docker. A live mount throws.
 */
export class LayerFsStore implements WorkspaceStore {
  readonly kind = 'layerfs' as const;
  private readonly branches = new Map<string, LayerBranch>();
  private n = 0;

  constructor(private readonly enabled: boolean) {}

  async prepare(spec: WorkspaceSpec): Promise<WorkspaceHandle> {
    if (!this.enabled) throw new LayerFsDisabledError();
    if (spec.liveMount) throw new LayerFsMountUnsupportedError();
    this.n += 1;
    const id = spec.forkOf ?? `lfs:${spec.workerId}:${this.n}`;
    if (spec.forkOf) {
      const parent = this.branches.get(spec.forkOf);
      if (!parent) throw new Error(`LayerFS fork source ${spec.forkOf} is gone.`);
      const forkId = `lfs:${spec.workerId}:${this.n}`;
      this.branches.set(forkId, { files: { ...parent.files }, parent: spec.forkOf });
      return { id: forkId, kind: 'layerfs', dir: null };
    }
    this.branches.set(id, { files: { ...(spec.seedFiles ?? {}) } });
    return { id, kind: 'layerfs', dir: null };
  }

  async snapshot(handle: WorkspaceHandle): Promise<SnapshotRef> {
    const branch = this.branches.get(handle.id);
    if (!branch) throw new Error(`LayerFS branch ${handle.id} is gone.`);
    return { id: handle.id };
  }

  async exportPatch(handle: WorkspaceHandle): Promise<string> {
    const branch = this.branches.get(handle.id);
    if (!branch) throw new Error(`LayerFS branch ${handle.id} is gone.`);
    const parent = branch.parent ? this.branches.get(branch.parent) : undefined;
    const lines: string[] = [];
    const keys = new Set([...Object.keys(parent?.files ?? {}), ...Object.keys(branch.files)]);
    for (const path of [...keys].sort()) {
      const before = parent?.files[path];
      const after = branch.files[path];
      if (before === after) continue;
      lines.push(`--- a/${path}`);
      lines.push(`+++ b/${path}`);
      if (before !== undefined) lines.push(`-${before}`);
      if (after !== undefined) lines.push(`+${after}`);
    }
    return lines.join('\n');
  }

  write(handle: WorkspaceHandle, path: string, content: string): void {
    const branch = this.branches.get(handle.id);
    if (!branch) throw new Error(`LayerFS branch ${handle.id} is gone.`);
    branch.files[path] = content;
  }

  async release(handle: WorkspaceHandle): Promise<void> {
    this.branches.delete(handle.id);
  }
}

export function createWorkspaceStore(options: { layerfs?: boolean } = {}): WorkspaceStore {
  if (options.layerfs) return new LayerFsStore(true);
  return new GitCloneStore();
}

/** Helper used by git-clone tests to make a local source repo. */
export async function initLocalRepo(files: Record<string, string>, dir?: string): Promise<string> {
  const root = dir ?? (await mkdtemp(join(tmpdir(), 'maka-repo-')));
  await run('git', ['init', '-b', 'main', root]);
  await run('git', ['-C', root, 'config', 'user.email', 'superagent@test']);
  await run('git', ['-C', root, 'config', 'user.name', 'Superagent Test']);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  await run('git', ['-C', root, 'add', '-A']);
  await run('git', ['-C', root, 'commit', '-m', 'init']);
  return root;
}
