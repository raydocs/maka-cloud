import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { secretValuesOf } from './log.js';

/** What a backup holds, as paths relative to the data directory. Nothing else is ever copied. */
export interface BackupLayout {
  /** SQLite files, copied with the online backup API so a running writer cannot tear them. */
  databases: readonly string[];
  /** Plain files. */
  files: readonly string[];
  /** Directories. SQLite files inside are copied with the backup API, symbolic links are skipped. */
  trees: readonly string[];
  /** Applied to the copy of a database before it is kept, never to the live one. */
  redact?: Readonly<Record<string, (copy: DatabaseSync) => void>>;
}

export class BackupError extends Error {
  override name = 'BackupError';
  /** Its message is ours (paths and reasons), so the log may print it. */
  readonly safeToLog = true;
}

const STAMP = /^\d{8}T\d{6}Z(?:-\d+)?$/u;
const MANIFEST = 'manifest.json';
const SQLITE_HEADER = 'SQLite format 3\0';
const SQLITE_COMPANION = /-(?:wal|shm|journal)$/u;
const SCAN_CHUNK = 1 << 20;
/** Shapes that are secrets wherever they appear: private keys and this system's own tokens. */
const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bmk[iog]_[\w.-]{16,}/u,
];

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface Manifest {
  version: 1;
  createdAt: string;
  files: ManifestFile[];
}

export interface BackupResult {
  stamp: string;
  path: string;
  files: number;
  bytes: number;
  removed: string[];
}

export interface BackupOptions {
  dataDir: string;
  backupDir: string;
  layout: BackupLayout;
  /** Environment whose secret values must not appear in any file of the backup. */
  env: NodeJS.ProcessEnv;
  /**
   * Databases only the running server can read (it holds them exclusively), by path in `layout`:
   * each writes a consistent copy to the path it is given.
   */
  inProcess?: Readonly<Record<string, (destination: string) => Promise<void>>>;
  /** How many backups to keep. */
  keep?: number;
  now?: () => number;
}

const DEFAULT_KEEP = 7;

function stampOf(at: number): string {
  return new Date(at)
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d+Z$/u, 'Z');
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function isSqlite(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(SQLITE_HEADER.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead === buffer.length && buffer.toString('latin1') === SQLITE_HEADER;
  } finally {
    await handle.close();
  }
}

/** A consistent copy of a database another process may be writing. */
async function copyDatabase(source: string, destination: string): Promise<void> {
  const db = new DatabaseSync(source);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    // The backup call itself fails with no usable message on a locked file, so ask first.
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    await sqliteBackup(db, destination);
  } catch (error) {
    if (/locked|busy/iu.test(String((error as Error).message))) {
      throw new BackupError(
        `${source} is held by a running server, which backs itself up (set MAKA_CLOUD_BACKUP_DIR for it); stop the server to back up from the command line`,
      );
    }
    throw error;
  } finally {
    if (db.isOpen) db.close();
  }
}

/** Turns off the journal of a finished copy so it is one self-contained file. */
function settle(path: string, redact: ((copy: DatabaseSync) => void) | undefined): void {
  const db = new DatabaseSync(path);
  try {
    if (redact) {
      // Freed pages would keep what a delete removed, so overwrite them and compact.
      db.exec('PRAGMA secure_delete = ON');
      redact(db);
      db.exec('VACUUM');
    }
    db.exec('PRAGMA journal_mode = DELETE');
  } finally {
    db.close();
  }
}

async function copyTree(
  sourceRoot: string,
  destinationRoot: string,
  onFile: (relativePath: string) => void,
): Promise<void> {
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const from = join(directory, entry.name);
      const rel = relative(sourceRoot, from);
      const to = join(destinationRoot, rel);
      // A link could lead out of the data directory; it is not followed and not kept.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await mkdir(to, { recursive: true, mode: 0o700 });
        await walk(from);
      } else if (entry.isFile()) {
        if (SQLITE_COMPANION.test(entry.name)) {
          const main = from.replace(SQLITE_COMPANION, '');
          if (await exists(main)) continue;
        }
        await mkdir(dirname(to), { recursive: true, mode: 0o700 });
        if (await isSqlite(from)) await copyDatabase(from, to);
        else await copyFile(from, to);
        onFile(rel);
      }
    }
  };
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  await walk(sourceRoot);
}

async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(relative(root, path).split(sep).join('/'));
    }
  };
  await walk(root);
  return found.sort();
}

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** True when the file holds a secret value of the environment or a secret-shaped string. */
async function holdsSecret(path: string, values: readonly string[]): Promise<boolean> {
  const needles = values.map((value) => Buffer.from(value));
  const overlap = Math.max(256, ...needles.map((needle) => needle.length));
  const handle = await open(path, 'r');
  try {
    let tail = Buffer.alloc(0);
    for (;;) {
      const chunk = Buffer.alloc(SCAN_CHUNK);
      const { bytesRead } = await handle.read(chunk, 0, SCAN_CHUNK, null);
      if (bytesRead === 0) return false;
      const window = Buffer.concat([tail, chunk.subarray(0, bytesRead)]);
      if (needles.some((needle) => window.includes(needle))) return true;
      const text = window.toString('latin1');
      if (SECRET_SHAPES.some((shape) => shape.test(text))) return true;
      tail = window.subarray(Math.max(0, window.length - overlap));
    }
  } finally {
    await handle.close();
  }
}

async function readManifest(directory: string): Promise<Manifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(directory, MANIFEST), 'utf8'));
  } catch {
    throw new BackupError(`${directory} has no readable ${MANIFEST}`);
  }
  const m = parsed as Partial<Manifest> | null;
  if (
    m === null ||
    typeof m !== 'object' ||
    m.version !== 1 ||
    typeof m.createdAt !== 'string' ||
    Number.isNaN(Date.parse(m.createdAt)) ||
    !Array.isArray(m.files)
  ) {
    throw new BackupError(`${directory} has a malformed ${MANIFEST}`);
  }
  const seen = new Set<string>();
  for (const file of m.files as unknown[]) {
    const f = file as Partial<ManifestFile> | null;
    if (
      f === null ||
      typeof f !== 'object' ||
      typeof f.path !== 'string' ||
      typeof f.size !== 'number' ||
      !Number.isSafeInteger(f.size) ||
      f.size < 0 ||
      typeof f.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(f.sha256) ||
      seen.has(f.path)
    ) {
      throw new BackupError(`${directory} has a malformed ${MANIFEST}`);
    }
    seen.add(f.path);
  }
  return m as Manifest;
}

/** Backups in a directory, newest first. A directory that is not a finished backup is not listed. */
export async function listBackups(
  backupDir: string,
): Promise<Array<{ stamp: string; createdAt: number }>> {
  let names: string[];
  try {
    names = await readdir(backupDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const found: Array<{ stamp: string; createdAt: number }> = [];
  for (const name of names) {
    if (!STAMP.test(name)) continue;
    try {
      const manifest = await readManifest(join(backupDir, name));
      found.push({ stamp: name, createdAt: Date.parse(manifest.createdAt) });
    } catch {
      // Not a backup this code finished; it is left alone.
    }
  }
  return found.sort((a, b) => b.createdAt - a.createdAt || (a.stamp < b.stamp ? 1 : -1));
}

/** Writes one backup and removes the oldest beyond `keep`. Nothing partial is ever left under a stamp. */
export async function backupAll(options: BackupOptions): Promise<BackupResult> {
  const { dataDir, backupDir, layout } = options;
  if (isInside(dataDir, backupDir) || isInside(backupDir, dataDir)) {
    throw new BackupError(
      'The backup directory and the data directory must not contain each other',
    );
  }
  const now = options.now ?? Date.now;
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const startedAt = now();
  const scratch = join(backupDir, `.tmp-${stampOf(startedAt)}-${process.pid}`);
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { mode: 0o700 });
  try {
    const kept: string[] = [];
    for (const rel of layout.databases) {
      const source = join(dataDir, rel);
      const destination = join(scratch, rel);
      const inProcess = options.inProcess?.[rel];
      if (!inProcess && !(await exists(source))) continue;
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      if (inProcess) await inProcess(destination);
      else await copyDatabase(source, destination);
      settle(destination, layout.redact?.[rel]);
      kept.push(rel);
    }
    for (const rel of layout.files) {
      const source = join(dataDir, rel);
      if (!(await exists(source))) continue;
      await mkdir(dirname(join(scratch, rel)), { recursive: true, mode: 0o700 });
      await copyFile(source, join(scratch, rel));
      kept.push(rel);
    }
    for (const rel of layout.trees) {
      const source = join(dataDir, rel);
      if (!(await exists(source))) continue;
      await copyTree(source, join(scratch, rel), () => undefined);
    }

    // Defence in depth: nothing that leaves the data directory may hold a key.
    const secrets = secretValuesOf(options.env);
    const files: ManifestFile[] = [];
    let bytes = 0;
    for (const rel of await listFiles(scratch)) {
      const path = join(scratch, rel);
      if (await holdsSecret(path, secrets)) {
        throw new BackupError(`The backup would hold a secret (in ${rel}), so it was not written`);
      }
      const size = (await stat(path)).size;
      bytes += size;
      files.push({ path: rel, size, sha256: await digest(path) });
    }
    const manifest: Manifest = {
      version: 1,
      createdAt: new Date(startedAt).toISOString(),
      files,
    };
    await writeFile(join(scratch, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });

    let stamp = stampOf(startedAt);
    for (let n = 2; await exists(join(backupDir, stamp)); n += 1) {
      stamp = `${stampOf(startedAt)}-${n}`;
    }
    await rename(scratch, join(backupDir, stamp));
    const removed = await prune(backupDir, options.keep ?? DEFAULT_KEEP);
    return { stamp, path: join(backupDir, stamp), files: files.length, bytes, removed };
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}

/** Removes finished backups beyond the newest `keep`, and nothing else. */
async function prune(backupDir: string, keep: number): Promise<string[]> {
  const removed: string[] = [];
  for (const old of (await listBackups(backupDir)).slice(Math.max(1, keep))) {
    await rm(join(backupDir, old.stamp), { recursive: true, force: true });
    removed.push(old.stamp);
  }
  return removed;
}

/** Checks a backup against its manifest: every file present with its size and hash, and no other. */
export async function verifyBackup(directory: string, layout: BackupLayout): Promise<Manifest> {
  const manifest = await readManifest(directory);
  const allowed = (path: string): boolean =>
    layout.databases.includes(path) ||
    layout.files.includes(path) ||
    layout.trees.some((tree) => path.startsWith(`${tree}/`));
  for (const file of manifest.files) {
    const clean = normalize(file.path).split(sep).join('/');
    if (clean !== file.path || isAbsolute(file.path) || file.path.split('/').includes('..')) {
      throw new BackupError(`The manifest names a path outside the backup: ${file.path}`);
    }
    if (!allowed(file.path)) {
      throw new BackupError(`The manifest names a file this server does not keep: ${file.path}`);
    }
  }
  const listed = new Set(manifest.files.map((file) => file.path));
  for (const present of await listFiles(directory)) {
    if (present !== MANIFEST && !listed.has(present)) {
      throw new BackupError(`The backup holds a file its manifest does not list: ${present}`);
    }
  }
  for (const file of manifest.files) {
    const path = join(directory, file.path);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch {
      throw new BackupError(`The backup is missing ${file.path}`);
    }
    if (!info.isFile() || info.size !== file.size || (await digest(path)) !== file.sha256) {
      throw new BackupError(`${file.path} does not match its checksum; the backup is damaged`);
    }
  }
  return manifest;
}

/** Throws unless nothing is serving from these databases: a running server holds them exclusively. */
export async function assertNoServer(dataDir: string, layout: BackupLayout): Promise<void> {
  for (const rel of layout.databases) {
    const path = join(dataDir, rel);
    if (!(await exists(path))) continue;
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA busy_timeout = 0');
      db.exec('PRAGMA locking_mode = EXCLUSIVE');
      db.exec('BEGIN IMMEDIATE');
      db.exec('ROLLBACK');
    } catch (error) {
      if (/locked|busy/iu.test(String((error as Error).message))) {
        throw new BackupError(`${rel} is in use: stop the server before restoring`);
      }
      throw error;
    } finally {
      if (db.isOpen) db.close();
    }
  }
}

export interface RestoreResult {
  stamp: string;
  files: number;
  /** Where what was in the data directory before went; nothing is deleted. */
  previous: string;
}

/**
 * Puts a backup back. The backup is verified first and the server must be stopped. What is in the
 * data directory is moved aside, never deleted, and put back if the restore fails.
 */
export async function restoreBackup(options: {
  dataDir: string;
  backupDir: string;
  stamp: string;
  layout: BackupLayout;
  now?: () => number;
}): Promise<RestoreResult> {
  const { dataDir, backupDir, stamp, layout } = options;
  if (!STAMP.test(stamp)) throw new BackupError(`${stamp} is not a backup name`);
  const source = join(backupDir, stamp);
  const manifest = await verifyBackup(source, layout);
  await assertNoServer(dataDir, layout);

  const at = stampOf((options.now ?? Date.now)());
  const staged = join(dataDir, `.restore-${at}`);
  const previous = join(dataDir, `pre-restore-${at}`);
  await rm(staged, { recursive: true, force: true });
  await mkdir(staged, { recursive: true, mode: 0o700 });
  try {
    for (const file of manifest.files) {
      const to = join(staged, file.path);
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      await copyFile(join(source, file.path), to);
      if ((await digest(to)) !== file.sha256) {
        throw new BackupError(`${file.path} changed while it was being restored`);
      }
    }
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }

  await assertNoServer(dataDir, layout);
  await mkdir(previous, { recursive: true, mode: 0o700 });
  const moved: Array<{ from: string; to: string }> = [];
  const restored: string[] = [];
  const entries = [
    ...layout.databases.flatMap((rel) => [rel, `${rel}-wal`, `${rel}-shm`, `${rel}-journal`]),
    ...layout.files,
    ...layout.trees,
  ];
  try {
    for (const rel of entries) {
      const live = join(dataDir, rel);
      if (!(await exists(live))) continue;
      const aside = join(previous, rel);
      await mkdir(dirname(aside), { recursive: true, mode: 0o700 });
      await rename(live, aside);
      moved.push({ from: live, to: aside });
    }
    const topLevel = [...layout.databases, ...layout.files, ...layout.trees];
    for (const rel of topLevel) {
      const from = join(staged, rel);
      if (!(await exists(from))) continue;
      await mkdir(dirname(join(dataDir, rel)), { recursive: true });
      await rename(from, join(dataDir, rel));
      restored.push(rel);
    }
  } catch (error) {
    for (const rel of restored.reverse())
      await rm(join(dataDir, rel), { recursive: true, force: true });
    for (const { from, to } of moved.reverse()) await rename(to, from);
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
  await rm(staged, { recursive: true, force: true });
  return { stamp, files: manifest.files.length, previous };
}
