import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import {
  assertNoServer,
  BackupError,
  backupAll,
  listBackups,
  restoreBackup,
  verifyBackup,
} from '../backup.js';
import { backupLayoutOf, dataPathsOf } from '../config.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

async function dirs(t: TestContext): Promise<{ dataDir: string; backupDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'cloud-host-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const backupDir = join(root, 'backups');
  await mkdir(dataDir);
  return { dataDir, backupDir };
}

function createDb(path: string, rows: string[] = ['first'], wal = true): void {
  const db = new DatabaseSync(path);
  if (wal) db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)');
  for (const row of rows) db.prepare('INSERT INTO notes (text) VALUES (?)').run(row);
  db.close();
}

function notesOf(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare('SELECT text FROM notes ORDER BY id').all() as Array<{ text: string }>).map(
      (row) => row.text,
    );
  } finally {
    db.close();
  }
}

/** A data directory with every file the server keeps, each holding something of its own. */
async function populate(dataDir: string, tag = 'a'): Promise<void> {
  const paths = dataPathsOf(dataDir);
  for (const path of [
    paths.dbPath,
    paths.invitesPath,
    paths.supervisorDbPath,
    paths.gatewaySpendPath,
    paths.dutiesDbPath,
  ]) {
    createDb(path, [`${tag} in ${path.slice(dataDir.length)}`]);
  }
  await writeFile(paths.runnerSessionsPath, `{"sessions":"${tag}"}`);
  await writeFile(paths.codingDeliveriesPath, `{"deliveries":"${tag}"}`);
  await mkdir(join(paths.conductorRoot, 'maka', 'sessions'), { recursive: true });
  createDb(join(paths.conductorRoot, 'conductor.db'), [`${tag} conductor`]);
  createDb(join(paths.conductorRoot, 'maka', 'runtime.sqlite'), [`${tag} history`]);
  await writeFile(join(paths.conductorRoot, 'maka', 'sessions', 'one.json'), `{"turn":"${tag}"}`);
  await mkdir(join(paths.handoffRoot, 'tsk_1'), { recursive: true });
  await writeFile(join(paths.handoffRoot, 'tsk_1', 'report.md'), `report ${tag}`);
}

/** Another process holding a database the way the server does: exclusively, until the test ends. */
async function holdExclusively(t: TestContext, path: string): Promise<() => void> {
  const child = spawn(
    process.execPath,
    [
      '--no-warnings',
      '--input-type=module',
      '-e',
      `import { DatabaseSync } from 'node:sqlite';
       const db = new DatabaseSync(process.argv[1]);
       db.exec('PRAGMA locking_mode = EXCLUSIVE');
       db.exec('BEGIN IMMEDIATE');
       db.exec('COMMIT');
       console.log('held');
       setInterval(() => undefined, 1000);`,
      path,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const release = (): void => {
    child.kill('SIGKILL');
  };
  t.after(release);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('the holder exited')));
    child.stdout.once('data', () => resolve());
  });
  return release;
}

const env = {
  ANTHROPIC_API_KEY: 'sk-ant-not-a-real-key-123456',
  INSTABOX_API_KEY: 'ibx-test-key-1',
};

test('a backup holds every database and file, each one consistent, and a manifest that verifies', async (t) => {
  const { dataDir, backupDir } = await dirs(t);
  await populate(dataDir);
  const layout = backupLayoutOf(dataDir);
  const done = await backupAll({ dataDir, backupDir, layout, env, now: () => T0 });
  assert.match(done.stamp, /^20261001T120000Z$/u);
  const manifest = await verifyBackup(done.path, layout);
  const names = manifest.files.map((file) => file.path);
  for (const expected of [
    'cloud.db',
    'invites.db',
    'supervisor.db',
    'gateway-spend.db',
    'duties.db',
    'runner-sessions.json',
    'coding-deliveries.json',
    'conductor/conductor.db',
    'conductor/maka/runtime.sqlite',
    'conductor/maka/sessions/one.json',
    'handoff/tsk_1/report.md',
  ]) {
    assert.ok(names.includes(expected), `${expected} is in the backup`);
  }
  assert.deepEqual(notesOf(join(done.path, 'conductor/maka/runtime.sqlite')), ['a history']);
  assert.deepEqual(
    names.filter((name) => /-(wal|shm)$/u.test(name)),
    [],
    'a database is one self-contained file',
  );
  assert.equal((await stat(done.path)).mode & 0o077, 0, 'only the server’s user can read it');
});

test('a database written to while it is copied comes out whole', async (t) => {
  const { dataDir, backupDir } = await dirs(t);
  const paths = dataPathsOf(dataDir);
  const live = new DatabaseSync(paths.gatewaySpendPath);
  live.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
  live.exec('CREATE TABLE pairs (id INTEGER PRIMARY KEY, a INTEGER NOT NULL, b INTEGER NOT NULL)');
  live.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)');
  const insert = live.prepare('INSERT INTO pairs (a, b) VALUES (?, ?)');
  const write = (n: number): void => {
    live.exec('BEGIN');
    insert.run(n, n * 2);
    insert.run(n + 1, (n + 1) * 2);
    live.exec('COMMIT');
  };
  for (let n = 0; n < 2000; n += 2) write(n);
  let writing = true;
  let written = 2000;
  const writer = (async () => {
    while (writing) {
      write(written);
      written += 2;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  })();
  const done = await backupAll({
    dataDir,
    backupDir,
    layout: backupLayoutOf(dataDir),
    env,
    now: () => T0,
  });
  writing = false;
  await writer;
  live.close();
  const copy = new DatabaseSync(join(done.path, 'gateway-spend.db'), { readOnly: true });
  const rows = copy.prepare('SELECT a, b FROM pairs').all() as Array<{ a: number; b: number }>;
  assert.equal(copy.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  copy.close();
  assert.ok(rows.length >= 2000);
  assert.equal(rows.length % 2, 0, 'a transaction is copied whole or not at all');
  assert.ok(rows.every((row) => row.b === row.a * 2));
});

test('restoring puts every file back, moves what was there aside and leaves no stale journal', async (t) => {
  const { dataDir, backupDir } = await dirs(t);
  await populate(dataDir, 'before');
  const layout = backupLayoutOf(dataDir);
  const done = await backupAll({ dataDir, backupDir, layout, env, now: () => T0 });

  const paths = dataPathsOf(dataDir);
  await rm(paths.handoffRoot, { recursive: true });
  createDb(paths.dbPath, ['after'], true);
  // A journal that belongs to the database about to be replaced must not survive it.
  await writeFile(`${paths.dbPath}-wal`, randomBytes(64));
  await writeFile(paths.runnerSessionsPath, '{"sessions":"after"}');

  const restored = await restoreBackup({
    dataDir,
    backupDir,
    stamp: done.stamp,
    layout,
    now: () => T0 + 1000,
  });
  assert.equal(restored.files, done.files);
  assert.deepEqual(notesOf(paths.dbPath), ['before in /cloud.db']);
  assert.equal(await readFile(paths.runnerSessionsPath, 'utf8'), '{"sessions":"before"}');
  assert.equal(
    await readFile(join(paths.handoffRoot, 'tsk_1', 'report.md'), 'utf8'),
    'report before',
  );
  assert.deepEqual(notesOf(join(paths.conductorRoot, 'maka', 'runtime.sqlite')), [
    'before history',
  ]);
  await assert.rejects(stat(`${paths.dbPath}-wal`), { code: 'ENOENT' });
  // Nothing is deleted: what was there is kept next to it.
  assert.deepEqual(notesOf(join(restored.previous, 'cloud.db')), ['before in /cloud.db', 'after']);
  assert.equal(
    await readFile(join(restored.previous, 'runner-sessions.json'), 'utf8'),
    '{"sessions":"after"}',
  );
  assert.deepEqual(
    (await readdir(dataDir)).filter((name) => name.startsWith('.restore-')),
    [],
    'the staging directory is gone',
  );
  // The restored database opens and accepts writes.
  const db = new DatabaseSync(paths.dbPath);
  db.prepare('INSERT INTO notes (text) VALUES (?)').run('new');
  db.close();
});

test('only the newest seven backups are kept, and only backups are ever removed', async (t) => {
  const { dataDir, backupDir } = await dirs(t);
  await populate(dataDir);
  const layout = backupLayoutOf(dataDir);
  await mkdir(join(backupDir, 'notes-from-the-operator'), { recursive: true });
  await writeFile(join(backupDir, 'notes-from-the-operator', 'keep.txt'), 'mine');
  await mkdir(join(backupDir, '20200101T000000Z'));
  await writeFile(join(backupDir, '20200101T000000Z', 'half-written'), 'not a backup');
  const stamps: string[] = [];
  const removed: string[] = [];
  for (let day = 0; day < 9; day += 1) {
    const done = await backupAll({ dataDir, backupDir, layout, env, now: () => T0 + day * DAY });
    stamps.push(done.stamp);
    removed.push(...done.removed);
  }
  assert.deepEqual(removed, stamps.slice(0, 2), 'the two oldest, one when each went over seven');
  const kept = (await listBackups(backupDir)).map((entry) => entry.stamp);
  assert.deepEqual(kept, stamps.slice(2).reverse(), 'the newest seven, newest first');
  assert.equal(
    await readFile(join(backupDir, 'notes-from-the-operator', 'keep.txt'), 'utf8'),
    'mine',
  );
  assert.ok((await stat(join(backupDir, '20200101T000000Z', 'half-written'))).isFile());
});

test('two backups in the same second get different names', async (t) => {
  const { dataDir, backupDir } = await dirs(t);
  await populate(dataDir);
  const layout = backupLayoutOf(dataDir);
  const a = await backupAll({ dataDir, backupDir, layout, env, now: () => T0 });
  const b = await backupAll({ dataDir, backupDir, layout, env, now: () => T0 });
  assert.notEqual(a.stamp, b.stamp);
  assert.equal((await listBackups(backupDir)).length, 2);
});

test('a damaged, padded, shortened or rewritten backup is refused and the live data is untouched', async (t) => {
  const { dataDir, backupDir } = await dirs(t);
  await populate(dataDir, 'live');
  const layout = backupLayoutOf(dataDir);
  const made = async (n: number) =>
    backupAll({ dataDir, backupDir, layout, env, now: () => T0 + n * DAY });
  const untouched = async (): Promise<void> => {
    assert.deepEqual(notesOf(dataPathsOf(dataDir).dbPath), ['live in /cloud.db']);
    assert.deepEqual(
      (await readdir(dataDir)).filter((name) => /^(\.restore-|pre-restore-)/u.test(name)),
      [],
    );
  };
  const refuses = async (stamp: string, pattern: RegExp): Promise<void> => {
    await assert.rejects(restoreBackup({ dataDir, backupDir, stamp, layout }), pattern);
    await untouched();
  };

  const flipped = await made(1);
  const bytes = await readFile(join(flipped.path, 'invites.db'));
  bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
  await writeFile(join(flipped.path, 'invites.db'), bytes);
  await refuses(flipped.stamp, /does not match its checksum/u);

  const extra = await made(2);
  await writeFile(join(extra.path, 'handoff-extra.txt'), 'planted');
  await refuses(extra.stamp, /does not list: handoff-extra\.txt/u);

  const missing = await made(3);
  await rm(join(missing.path, 'cloud.db'));
  await refuses(missing.stamp, /missing cloud\.db/u);

  for (const [n, path] of [
    [4, '../outside.txt'],
    [5, '/etc/passwd'],
    [6, 'not-ours.db'],
    [7, 'conductor/../cloud.db'],
  ] as const) {
    const forged = await made(n);
    const manifestPath = join(forged.path, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      files: Array<{ path: string }>;
    };
    manifest.files[0] = { ...manifest.files[0], path } as never;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await refuses(forged.stamp, /outside the backup|does not keep/u);
  }

  const garbled = await made(8);
  await writeFile(join(garbled.path, 'manifest.json'), '{"version":2}');
  await refuses(garbled.stamp, /malformed|readable/u);
  await refuses('../etc', /not a backup name/u);
});

test('a restore is refused while a server holds the databases, and nothing changes', async (t) => {
  const { dataDir, backupDir } = await dirs(t);
  await populate(dataDir, 'live');
  const layout = backupLayoutOf(dataDir);
  const done = await backupAll({ dataDir, backupDir, layout, env, now: () => T0 });
  await assertNoServer(dataDir, layout);

  // What the server does with its main database and the supervisor's, from another process.
  for (const rel of ['cloud.db', 'supervisor.db', 'duties.db']) {
    const release = await holdExclusively(t, join(dataDir, rel));
    await assert.rejects(
      restoreBackup({ dataDir, backupDir, stamp: done.stamp, layout }),
      new RegExp(`${rel.replace('.', '\\.')} is in use`, 'u'),
    );
    assert.deepEqual(
      (await readdir(dataDir)).filter((name) => /^(\.restore-|pre-restore-)/u.test(name)),
      [],
    );
    release();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  await restoreBackup({ dataDir, backupDir, stamp: done.stamp, layout });
});

test('a backup never holds a key: a secret in any file stops it, and nothing is left behind', async (t) => {
  const secrets: Array<[string, (dataDir: string) => Promise<void> | void]> = [
    [
      'an environment key in a handoff file',
      (dataDir) =>
        writeFile(
          join(dataPathsOf(dataDir).handoffRoot, 'tsk_1', 'leak.txt'),
          `key=${env.ANTHROPIC_API_KEY}`,
        ),
    ],
    [
      'an environment key inside a database value',
      (dataDir) =>
        createDb(join(dataPathsOf(dataDir).conductorRoot, 'leak.db'), [env.INSTABOX_API_KEY]),
    ],
    [
      'a private key',
      (dataDir) =>
        writeFile(
          join(dataPathsOf(dataDir).handoffRoot, 'tsk_1', 'id.pem'),
          '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
        ),
    ],
    [
      'a gateway token',
      (dataDir) =>
        writeFile(
          join(dataPathsOf(dataDir).handoffRoot, 'tsk_1', 'env.txt'),
          'token mkg_task_0123456789abcdef.0123456789abcdef',
        ),
    ],
  ];
  for (const [what, plant] of secrets) {
    const { dataDir, backupDir } = await dirs(t);
    await populate(dataDir);
    await plant(dataDir);
    const attempt = backupAll({
      dataDir,
      backupDir,
      layout: backupLayoutOf(dataDir),
      env,
      now: () => T0,
    });
    await assert.rejects(attempt, (error: unknown) => {
      assert.ok(error instanceof BackupError, what);
      assert.match(error.message, /would hold a secret/u, what);
      for (const value of Object.values(env)) assert.ok(!error.message.includes(value), what);
      return true;
    });
    assert.deepEqual(await readdir(backupDir), [], `${what}: no backup and no scratch directory`);
  }
});

test('push subscriptions are not kept: their secrets are gone from the file, not just from the table', async (t) => {
  const { dataDir, backupDir } = await dirs(t);
  await populate(dataDir);
  const paths = dataPathsOf(dataDir);
  const db = new DatabaseSync(paths.dbPath);
  db.exec(
    'CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, invite_id TEXT, p256dh TEXT, auth TEXT)',
  );
  const secret = 'device-auth-secret-0123456789';
  for (let n = 0; n < 50; n += 1) {
    db.prepare('INSERT INTO push_subscriptions VALUES (?, ?, ?, ?)').run(
      `https://push.example/${n}`,
      'inv_1',
      `${secret}-p256dh-${n}`,
      `${secret}-${n}`,
    );
  }
  db.close();
  const done = await backupAll({
    dataDir,
    backupDir,
    layout: backupLayoutOf(dataDir),
    env,
    now: () => T0,
  });
  const copyPath = join(done.path, 'cloud.db');
  const copy = new DatabaseSync(copyPath, { readOnly: true });
  assert.equal(copy.prepare('SELECT count(*) AS n FROM push_subscriptions').get()?.n, 0);
  copy.close();
  assert.ok(!(await readFile(copyPath)).includes(Buffer.from(secret)), 'not left in free pages');
  const live = new DatabaseSync(paths.dbPath, { readOnly: true });
  assert.equal(live.prepare('SELECT count(*) AS n FROM push_subscriptions').get()?.n, 50);
  live.close();
});

test('links are not followed, journals are not copied, and a failed copy leaves no backup', async (t) => {
  const { dataDir, backupDir } = await dirs(t);
  await populate(dataDir);
  const paths = dataPathsOf(dataDir);
  const outside = join(dataDir, '..', 'outside-secret.txt');
  await writeFile(outside, 'not part of the server');
  await symlink(outside, join(paths.handoffRoot, 'tsk_1', 'link.txt'));
  await symlink(join(dataDir, '..'), join(paths.handoffRoot, 'up'));
  const layout = backupLayoutOf(dataDir);
  const done = await backupAll({ dataDir, backupDir, layout, env, now: () => T0 });
  const names = (await verifyBackup(done.path, layout)).files.map((file) => file.path);
  assert.ok(!names.some((name) => name.includes('link.txt') || name.startsWith('handoff/up')));
  assert.ok(!names.some((name) => /-(wal|shm)$/u.test(name)));

  const failing = backupAll({
    dataDir,
    backupDir,
    layout,
    env,
    now: () => T0 + DAY,
    inProcess: {
      'cloud.db': () => Promise.reject(new Error('the server went away')),
    },
  });
  await assert.rejects(failing, /went away/u);
  assert.deepEqual(
    (await readdir(backupDir)).filter((name) => name.startsWith('.tmp-')),
    [],
  );
  assert.equal((await listBackups(backupDir)).length, 1);
});

test('a backup directory inside the data directory, or around it, is refused', async (t) => {
  const { dataDir } = await dirs(t);
  await populate(dataDir);
  const layout = backupLayoutOf(dataDir);
  for (const backupDir of [join(dataDir, 'backups'), dataDir, join(dataDir, '..')]) {
    await assert.rejects(
      backupAll({ dataDir, backupDir, layout, env }),
      /must not contain each other/u,
      backupDir,
    );
  }
});

test('from outside, a database a running server holds exclusively is refused with a pointer to the daily backup', async (t) => {
  const { dataDir, backupDir } = await dirs(t);
  await populate(dataDir);
  await holdExclusively(t, join(dataDir, 'cloud.db'));
  await assert.rejects(
    backupAll({ dataDir, backupDir, layout: backupLayoutOf(dataDir), env }),
    /held by a running server, which backs itself up/u,
  );
  assert.deepEqual(await readdir(backupDir), [], 'no scratch directory is left');
});
