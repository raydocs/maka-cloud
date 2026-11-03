import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { SnapshotRef, WorkspaceHandle, WorkspaceSpec, WorkspaceStore } from './workspace.js';
import { writeWorktreeTree } from './workspace.js';

const execFileAsync = promisify(execFile);

/** Runs `git` and the install command. Tests inject one to count calls. */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

export interface LayeredStoreOptions {
  /** Holds `mirror/`, `base/`, `layers/` and `snapshots/`. Created on demand. */
  root: string;
  /** Run once, with `sh -c`, in each new base layer (for example `npm ci`). */
  installCommand?: string;
  /** Files whose contents key the base layer. Default: common JS lockfiles. */
  lockfiles?: readonly string[];
  /** `auto` probes once for a usable overlay mount; `off` always uses clone-shared. */
  overlay?: 'auto' | 'off';
  runner?: CommandRunner;
  /** Directories copied from the base into a clone-shared layer. Default `node_modules`. */
  dependencyDirs?: readonly string[];
}

export type LayerCopyMethod = 'clonefile' | 'reflink' | 'hardlink' | 'copy';
type OverlayMethod = 'kernel' | 'fuse';

const DEFAULT_LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
] as const;
const DEFAULT_DEPENDENCY_DIRS = ['node_modules'] as const;

const defaultRunner: CommandRunner = (file, args, options) =>
  execFileAsync(file, [...args], { cwd: options?.cwd, maxBuffer: 64 * 1024 * 1024 });

/**
 * Layered workspaces (docs/superagent/efficiency.md §1).
 *
 * - Base layer: a clone at one commit plus the install command, built once per
 *   (repo, commit, lockfile hash, install command) under `<root>/base/<key>`
 *   and made read-only (except under a user-mode fuse-overlayfs, see
 *   `buildBase`).
 * - Assignment layer: an overlay mount on the base (Linux, root or
 *   fuse-overlayfs), else `git clone --shared <base>` plus a copy of the
 *   dependency directories. The copy uses clonefile on macOS and reflink on
 *   Linux when the filesystem has them, else hard links. A hard link shares
 *   the inode with the base, so an in-place write to such a file fails with
 *   EACCES (the base is read-only) instead of changing the base; tools that
 *   replace files (unlink and create, as npm does) are unaffected. Root
 *   ignores file modes, so as root the hard-link fallback gives no such
 *   protection: use the overlay there.
 *
 * Every layer works on its own `worker/<workerId>` branch. This class reads no
 * environment variables.
 */
export class LayeredStore implements WorkspaceStore {
  readonly kind = 'layered' as const;
  /** Copy method the last clone-shared layer used (undefined before the first). */
  lastCopyMethod?: LayerCopyMethod;

  private readonly root: string;
  private readonly installCommand?: string;
  private readonly lockfiles: readonly string[];
  private readonly overlayMode: 'auto' | 'off';
  private readonly runner: CommandRunner;
  private readonly dependencyDirs: readonly string[];
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly baseBuilds = new Map<string, Promise<string>>();
  private overlayProbe?: Promise<OverlayMethod | null>;
  private reflinkFailed = false;

  constructor(options: LayeredStoreOptions) {
    this.root = resolve(options.root);
    this.installCommand = options.installCommand;
    this.lockfiles = options.lockfiles ?? DEFAULT_LOCKFILES;
    this.overlayMode = options.overlay ?? 'auto';
    this.runner = options.runner ?? defaultRunner;
    this.dependencyDirs = options.dependencyDirs ?? DEFAULT_DEPENDENCY_DIRS;
  }

  /** True when assignment layers are overlay mounts. Probes once and caches. */
  async overlayUsable(): Promise<boolean> {
    return (await this.overlayMethod()) !== null;
  }

  /** Builds the base layer for this spec if needed and returns its read-only directory. */
  async ensureBase(spec: Pick<WorkspaceSpec, 'repoUrl' | 'ref'>): Promise<string> {
    const sha = await this.resolveSha(spec.repoUrl, spec.ref);
    const mirror = await this.ensureMirror(spec.repoUrl, sha);
    const lockHash = await this.lockfileHash(mirror, sha);
    const key = `${sha.slice(0, 12)}-${hash([spec.repoUrl, sha, lockHash, this.installCommand ?? '']).slice(0, 16)}`;
    const dir = join(this.root, 'base', key);
    if (await exists(dir)) return dir;
    const pending = this.baseBuilds.get(key);
    if (pending) return pending;
    const build = this.buildBase(spec.repoUrl, mirror, sha, dir).finally(() => {
      this.baseBuilds.delete(key);
    });
    this.baseBuilds.set(key, build);
    return build;
  }

  async prepare(spec: WorkspaceSpec): Promise<WorkspaceHandle> {
    const base = await this.ensureBase(spec);
    const id = `layered:${spec.workerId}:${randomUUID().slice(0, 8)}`;
    const layerDir = this.layerDir(id);
    const branch = `worker/${safeName(spec.workerId)}`;
    await mkdir(layerDir, { recursive: true });
    try {
      const method = await this.overlayMethod();
      if (method) {
        const merged = spec.workDir ? resolve(spec.workDir) : join(layerDir, 'merged');
        const mounted = await this.mountLayer(method, base, layerDir, merged);
        if (mounted) {
          await this.startBranch(merged, spec.repoUrl, branch);
          await this.excludeDependencies(merged);
          return { id, kind: 'layered', dir: merged, layer: 'overlay' };
        }
      }
      const dir = spec.workDir ? resolve(spec.workDir) : join(layerDir, 'work');
      await this.runner('git', ['clone', '--shared', base, dir]);
      await this.startBranch(dir, spec.repoUrl, branch);
      await this.copyDependencies(base, dir);
      await this.excludeDependencies(dir);
      return { id, kind: 'layered', dir, layer: 'clone-shared' };
    } catch (error) {
      await removeTree(layerDir);
      throw error;
    }
  }

  async snapshot(handle: WorkspaceHandle): Promise<SnapshotRef> {
    const dir = requireDir(handle, 'snapshot');
    if (handle.layer !== 'overlay') return { id: await writeWorktreeTree(dir) };
    const n = await nextSnapshotIndex(this.snapshotsDir(handle.id));
    const dest = join(this.snapshotsDir(handle.id), String(n));
    await mkdir(dest, { recursive: true });
    await execFileAsync('cp', ['-a', `${join(this.layerDir(handle.id), 'upper')}/.`, `${dest}/`]);
    return { id: `${handle.id}#${n}` };
  }

  async restore(handle: WorkspaceHandle, ref: SnapshotRef): Promise<void> {
    const dir = requireDir(handle, 'restore');
    if (handle.layer !== 'overlay') {
      if (!/^[0-9a-f]{40,64}$/.test(ref.id)) {
        throw new Error(`Snapshot ${ref.id} is not a tree id for a clone-shared layer.`);
      }
      // Stage first so files created after the snapshot are known to the index
      // and read-tree removes them.
      await this.runner('git', ['-C', dir, 'add', '-A']);
      await this.runner('git', ['-C', dir, 'read-tree', '--reset', '-u', ref.id]);
      return;
    }
    const prefix = `${handle.id}#`;
    if (!ref.id.startsWith(prefix)) throw new Error(`Snapshot ${ref.id} belongs to another layer.`);
    const n = ref.id.slice(prefix.length);
    if (!/^\d+$/.test(n)) throw new Error(`Snapshot ${ref.id} is malformed.`);
    const snapshot = join(this.snapshotsDir(handle.id), n);
    if (!(await exists(snapshot))) throw new Error(`Snapshot ${ref.id} is gone.`);
    const method = await this.overlayMethod();
    if (!method) throw new Error('Overlay is not usable here, cannot restore an overlay layer.');
    const layerDir = this.layerDir(handle.id);
    const base = (await readFile(join(layerDir, 'base'), 'utf8')).trim();
    await unmount(dir);
    await removeTree(join(layerDir, 'upper'));
    await removeTree(join(layerDir, 'work'));
    await mkdir(join(layerDir, 'upper'), { recursive: true });
    await mkdir(join(layerDir, 'work'), { recursive: true });
    await execFileAsync('cp', ['-a', `${snapshot}/.`, `${join(layerDir, 'upper')}/`]);
    await mountOverlay(method, base, join(layerDir, 'upper'), join(layerDir, 'work'), dir);
  }

  async exportPatch(handle: WorkspaceHandle): Promise<string> {
    const dir = requireDir(handle, 'exportPatch');
    // Stage first: `git diff HEAD` misses new untracked files.
    await this.runner('git', ['-C', dir, 'add', '-A']);
    const { stdout } = await this.runner('git', ['-C', dir, 'diff', '--cached', 'HEAD']);
    return stdout;
  }

  /** Unmounts (if mounted) and removes the layer and its snapshots. Never the base. */
  async release(handle: WorkspaceHandle): Promise<void> {
    if (handle.layer === 'overlay' && handle.dir) await unmount(handle.dir);
    if (handle.layer === 'clone-shared' && handle.dir) await removeTree(handle.dir);
    if (handle.layer === 'overlay' && handle.dir) await removeTree(handle.dir);
    await removeTree(this.layerDir(handle.id));
    await removeTree(this.snapshotsDir(handle.id));
  }

  private layerDir(id: string): string {
    return join(this.root, 'layers', safeName(id));
  }

  private snapshotsDir(id: string): string {
    return join(this.root, 'snapshots', safeName(id));
  }

  private overlayMethod(): Promise<OverlayMethod | null> {
    if (!this.overlayProbe) this.overlayProbe = this.probeOverlay();
    return this.overlayProbe;
  }

  private async probeOverlay(): Promise<OverlayMethod | null> {
    if (this.overlayMode === 'off' || process.platform !== 'linux') return null;
    const methods: OverlayMethod[] = [];
    if (process.getuid?.() === 0) methods.push('kernel');
    if (await commandExists('fuse-overlayfs')) methods.push('fuse');
    for (const method of methods) {
      const dir = join(this.root, `probe-${randomUUID().slice(0, 8)}`);
      try {
        for (const part of ['lower', 'upper', 'work', 'merged']) {
          await mkdir(join(dir, part), { recursive: true });
        }
        await mountOverlay(
          method,
          join(dir, 'lower'),
          join(dir, 'upper'),
          join(dir, 'work'),
          join(dir, 'merged'),
        );
        await unmount(join(dir, 'merged'));
        return method;
      } catch {
        // try the next method
      } finally {
        await removeTree(dir);
      }
    }
    return null;
  }

  /** Mounts the layer; returns false (after cleaning up) when the mount fails. */
  private async mountLayer(
    method: OverlayMethod,
    base: string,
    layerDir: string,
    merged: string,
  ): Promise<boolean> {
    const upper = join(layerDir, 'upper');
    const work = join(layerDir, 'work');
    for (const dir of [upper, work, merged]) await mkdir(dir, { recursive: true });
    try {
      await mountOverlay(method, base, upper, work, merged);
      await writeFile(join(layerDir, 'base'), base);
      return true;
    } catch {
      await removeTree(upper);
      await removeTree(work);
      return false;
    }
  }

  private async startBranch(dir: string, repoUrl: string, branch: string): Promise<void> {
    await this.runner('git', ['-C', dir, 'remote', 'set-url', 'origin', repoUrl]);
    await this.runner('git', ['-C', dir, 'checkout', '-q', '-b', branch]);
  }

  /** Keep dependency directories out of `git add -A` (snapshots, patches). */
  private async excludeDependencies(dir: string): Promise<void> {
    const lines = this.dependencyDirs.map((name) => `/${name}/`).join('\n');
    await mkdir(join(dir, '.git', 'info'), { recursive: true });
    await appendFile(join(dir, '.git', 'info', 'exclude'), `\n${lines}\n`);
  }

  private async copyDependencies(base: string, dir: string): Promise<void> {
    for (const name of this.dependencyDirs) {
      const src = join(base, name);
      if (!(await exists(src))) continue;
      const dest = join(dir, name);
      const method = await this.copyDirectory(src, dest);
      this.lastCopyMethod = method;
      // A read-only copied directory could not take new entries. Files that
      // are hard links share the base inode: leave their modes alone.
      if (method === 'hardlink') await makeDirsWritable(dest);
      else await execFileAsync('chmod', ['-R', 'u+w', dest]);
    }
  }

  private async copyDirectory(src: string, dest: string): Promise<LayerCopyMethod> {
    if (process.platform === 'darwin') {
      await execFileAsync('cp', ['-c', '-R', '-p', src, dest]);
      return 'clonefile';
    }
    if (process.platform !== 'linux') {
      await execFileAsync('cp', ['-R', '-p', src, dest]);
      return 'copy';
    }
    if (!this.reflinkFailed) {
      try {
        await execFileAsync('cp', ['-a', '--reflink=always', src, dest]);
        return 'reflink';
      } catch {
        this.reflinkFailed = true;
        await removeTree(dest);
      }
    }
    await execFileAsync('cp', ['-al', src, dest]);
    return 'hardlink';
  }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.locks.set(key, tail);
    tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return next;
  }

  private mirrorPath(repoUrl: string): string {
    return join(this.root, 'mirror', `${hash([repoUrl]).slice(0, 16)}.git`);
  }

  private async hasCommit(mirror: string, sha: string): Promise<boolean> {
    try {
      await this.runner('git', ['-C', mirror, 'cat-file', '-e', `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** Bare clone of the repo, fetched again only when `sha` is not in it yet. */
  private ensureMirror(repoUrl: string, sha: string | null): Promise<string> {
    const mirror = this.mirrorPath(repoUrl);
    return this.withLock(`mirror:${mirror}`, async () => {
      if (!(await exists(mirror))) {
        const tmp = `${mirror}.tmp-${randomUUID().slice(0, 8)}`;
        await mkdir(join(this.root, 'mirror'), { recursive: true });
        try {
          await this.runner('git', ['clone', '--bare', '-q', repoUrl, tmp]);
          await rename(tmp, mirror);
        } catch (error) {
          await removeTree(tmp);
          if (!(await exists(mirror))) throw error;
        }
      }
      if (sha && !(await this.hasCommit(mirror, sha))) {
        await this.runner('git', [
          '-C',
          mirror,
          'fetch',
          '-q',
          'origin',
          '+refs/heads/*:refs/heads/*',
          '+refs/tags/*:refs/tags/*',
        ]);
        if (!(await this.hasCommit(mirror, sha))) {
          await this.runner('git', ['-C', mirror, 'fetch', '-q', 'origin', sha]);
        }
      }
      return mirror;
    });
  }

  private async resolveSha(repoUrl: string, ref: string | undefined): Promise<string> {
    const want = ref ?? 'HEAD';
    if (/^[0-9a-f]{40}$/.test(want)) return want;
    try {
      const patterns = [want, `refs/heads/${want}`, `refs/tags/${want}`, `refs/tags/${want}^{}`];
      const { stdout } = await this.runner('git', ['ls-remote', repoUrl, ...patterns]);
      const byName = new Map<string, string>();
      for (const line of stdout.split('\n')) {
        const [sha, name] = line.split('\t');
        if (sha && name) byName.set(name, sha);
      }
      for (const name of [
        want,
        `refs/heads/${want}`,
        `refs/tags/${want}^{}`,
        `refs/tags/${want}`,
      ]) {
        const sha = byName.get(name);
        if (sha) return sha;
      }
    } catch {
      // fall through to the mirror (a short sha is not listed by ls-remote)
    }
    const mirror = await this.ensureMirror(repoUrl, null);
    const lookup = () =>
      this.runner('git', ['-C', mirror, 'rev-parse', '--verify', '--quiet', `${want}^{commit}`]);
    try {
      return (await lookup()).stdout.trim();
    } catch {
      await this.runner('git', [
        '-C',
        mirror,
        'fetch',
        '-q',
        'origin',
        '+refs/heads/*:refs/heads/*',
        '+refs/tags/*:refs/tags/*',
      ]);
      const found = (await lookup().catch(() => ({ stdout: '' }))).stdout.trim();
      if (!found) throw new Error(`Cannot resolve ref ${want} in ${repoUrl}.`);
      return found;
    }
  }

  private async lockfileHash(mirror: string, sha: string): Promise<string> {
    const parts: string[] = [];
    for (const name of this.lockfiles) {
      try {
        const { stdout } = await this.runner('git', [
          '-C',
          mirror,
          'rev-parse',
          '--verify',
          '--quiet',
          `${sha}:${name}`,
        ]);
        if (stdout.trim()) parts.push(`${name}:${stdout.trim()}`);
      } catch {
        // lockfile not in this commit
      }
    }
    return parts.length > 0 ? hash(parts) : 'no-lockfile';
  }

  private async buildBase(
    repoUrl: string,
    mirror: string,
    sha: string,
    dir: string,
  ): Promise<string> {
    await mkdir(join(this.root, 'base'), { recursive: true });
    const tmp = join(this.root, 'base', `.tmp-${randomUUID().slice(0, 8)}`);
    try {
      await this.runner('git', ['clone', '-q', '--no-checkout', mirror, tmp]);
      await this.runner('git', ['-C', tmp, 'checkout', '-q', '--detach', sha]);
      await this.runner('git', ['-C', tmp, 'remote', 'set-url', 'origin', repoUrl]);
      if (this.installCommand) await this.runner('sh', ['-c', this.installCommand], { cwd: tmp });
      // A user-mode overlay (fuse-overlayfs) keeps file modes on copy-up, so
      // a read-only base would make every tracked file unwritable in a layer.
      if ((await this.overlayMethod()) !== 'fuse') {
        await execFileAsync('chmod', ['-R', 'a-w', tmp]);
      }
      try {
        await rename(tmp, dir);
      } catch (error) {
        // Another process finished the same base first: keep theirs.
        if (!(await exists(dir))) throw error;
        await removeTree(tmp);
      }
      return dir;
    } catch (error) {
      await removeTree(tmp);
      throw error;
    }
  }
}

function hash(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function requireDir(handle: WorkspaceHandle, action: string): string {
  if (!handle.dir) throw new Error(`LayeredStore ${action} needs a directory.`);
  return handle.dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function nextSnapshotIndex(dir: string): Promise<number> {
  try {
    const numbers = (await readdir(dir)).map(Number).filter(Number.isInteger);
    return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
  } catch {
    return 1;
  }
}

/** Read-only directories (copied from the base) cannot take new entries. */
async function makeDirsWritable(path: string): Promise<void> {
  try {
    await execFileAsync('find', [path, '-type', 'd', '-exec', 'chmod', 'u+w', '{}', '+']);
  } catch {
    // path is gone
  }
}

/**
 * Removes a layer. Only directory modes are changed: a hard-linked file shares
 * its inode with the base and must keep its mode, and unlinking needs only a
 * writable directory.
 */
async function removeTree(path: string): Promise<void> {
  await makeDirsWritable(path);
  await rm(path, { recursive: true, force: true });
}

async function commandExists(name: string): Promise<boolean> {
  try {
    await execFileAsync(name, ['--version']);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

function assertMountSafe(path: string): void {
  if (/[,:\s]/.test(path)) {
    throw new Error(`Overlay paths cannot contain commas, colons or spaces: ${path}`);
  }
}

async function mountOverlay(
  method: OverlayMethod,
  lower: string,
  upper: string,
  work: string,
  merged: string,
): Promise<void> {
  for (const path of [lower, upper, work, merged]) assertMountSafe(path);
  const options = `lowerdir=${lower},upperdir=${upper},workdir=${work}`;
  if (method === 'kernel') {
    await execFileAsync('mount', ['-t', 'overlay', 'overlay', '-o', options, merged]);
  } else {
    await execFileAsync('fuse-overlayfs', ['-o', options, merged]);
  }
}

async function isMounted(path: string): Promise<boolean> {
  try {
    const info = await readFile('/proc/self/mountinfo', 'utf8');
    return info.includes(` ${path} `);
  } catch {
    return false;
  }
}

async function unmount(path: string): Promise<void> {
  if (!(await isMounted(path))) return;
  for (const [file, args] of [
    ['umount', [path]],
    ['fusermount3', ['-u', path]],
    ['fusermount', ['-u', path]],
  ] as const) {
    try {
      await execFileAsync(file, [...args]);
      return;
    } catch {
      // try the next tool
    }
  }
  if (await isMounted(path)) throw new Error(`Cannot unmount ${path}.`);
}
