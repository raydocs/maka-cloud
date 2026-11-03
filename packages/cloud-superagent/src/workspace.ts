import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { LayeredStore } from './layered-workspace.js';

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

export type WorkspaceKind = 'git-clone' | 'layerfs' | 'layered';

export interface WorkspaceHandle {
  id: string;
  kind: WorkspaceKind;
  dir: string | null;
  /** LayeredStore only: how the writable layer is backed. */
  layer?: 'overlay' | 'clone-shared';
}

export interface SnapshotRef {
  id: string;
}

export interface WorkspaceStore {
  readonly kind: WorkspaceKind;
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
    return { id: await writeWorktreeTree(handle.dir) };
  }

  async exportPatch(handle: WorkspaceHandle): Promise<string> {
    if (!handle.dir) throw new Error('GitCloneStore exportPatch needs a directory.');
    // Stage first: `git diff HEAD` misses new untracked files.
    await run('git', ['-C', handle.dir, 'add', '-A']);
    const { stdout } = await run('git', ['-C', handle.dir, 'diff', '--cached', 'HEAD']);
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

  /**
   * Paths both forks changed away from the shared parent to different
   * contents. Gate 3: a clash is a conflict, not a silent overwrite.
   */
  conflicts(left: WorkspaceHandle, right: WorkspaceHandle): string[] {
    const a = this.branches.get(left.id);
    const b = this.branches.get(right.id);
    if (!a || !b) throw new Error('LayerFS conflict check needs two live branches.');
    const parentId = a.parent && a.parent === b.parent ? a.parent : undefined;
    const parent = parentId ? this.branches.get(parentId) : undefined;
    const paths = new Set([...Object.keys(a.files), ...Object.keys(b.files)]);
    const out: string[] = [];
    for (const path of [...paths].sort()) {
      const leftText = a.files[path];
      const rightText = b.files[path];
      if (leftText === undefined || rightText === undefined || leftText === rightText) continue;
      const base = parent?.files[path];
      if (leftText !== base && rightText !== base) out.push(path);
    }
    return out;
  }

  async release(handle: WorkspaceHandle): Promise<void> {
    this.branches.delete(handle.id);
  }
}

export type WorkspaceMode = 'layered' | 'clone';

/** `MAKA_CLOUD_WORKSPACE=layered` selects LayeredStore. Anything else is `clone`. */
export function workspaceModeFromEnv(env: NodeJS.ProcessEnv = process.env): WorkspaceMode {
  return env.MAKA_CLOUD_WORKSPACE?.trim().toLowerCase() === 'layered' ? 'layered' : 'clone';
}

export function createWorkspaceStore(
  options: {
    layerfs?: boolean;
    mode?: WorkspaceMode;
    /** Layered mode only: where bases, layers and snapshots live. */
    root?: string;
    /** Layered mode only: run once in each new base layer. */
    installCommand?: string;
  } = {},
): WorkspaceStore {
  if (options.layerfs) return new LayerFsStore(true);
  if (options.mode === 'layered') {
    return new LayeredStore({
      root: options.root ?? join(tmpdir(), 'maka-layered'),
      installCommand: options.installCommand,
    });
  }
  return new GitCloneStore();
}

/**
 * Tree of the worktree including untracked files, on a temp index so HEAD
 * and the real index stay put. `rev-parse HEAD` only names the last commit.
 */
export async function writeWorktreeTree(dir: string): Promise<string> {
  const index = join(dir, '.git', `maka-tree-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    await run('git', ['-C', dir, 'add', '-A'], { env });
    const { stdout } = await run('git', ['-C', dir, 'write-tree'], { env });
    return stdout.trim();
  } finally {
    await rm(index, { force: true });
  }
}

/** Helper used by git-clone tests to make a local source repo. */
export async function initLocalRepo(files: Record<string, string>, dir?: string): Promise<string> {
  const root = dir ?? (await mkdtemp(join(tmpdir(), 'maka-repo-')));
  await run('git', ['init', '-b', 'main', root]);
  await run('git', ['-C', root, 'config', 'user.email', 'superagent@test']);
  await run('git', ['-C', root, 'config', 'user.name', 'Superagent Test']);
  await run('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  await run('git', ['-C', root, 'config', 'core.hooksPath', '/dev/null']);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  await run('git', ['-C', root, 'add', '-A']);
  await run('git', ['-C', root, 'commit', '-m', 'init']);
  return root;
}
