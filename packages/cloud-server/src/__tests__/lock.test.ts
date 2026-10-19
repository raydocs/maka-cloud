import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startCloudServer } from '../cloud-server.js';
import { DatabaseInUseError, openDatabase } from '../db.js';
import { startHarness } from './harness.js';

test('a second open of the same database in this process fails at once', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lock-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'db.sqlite');
  const first = openDatabase(path);
  t.after(() => first.close());
  assert.throws(() => openDatabase(path), DatabaseInUseError);
});

test('a second process fails at once while the first holds the database, and the first is unharmed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lock-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'db.sqlite');
  const first = openDatabase(path);
  first.exec(
    "INSERT INTO conversations (conversation_id, n, session_id, created_at) VALUES ('c', 1, 's', 1)",
  );
  const dbModule = fileURLToPath(new URL('../db.js', import.meta.url));
  const started = Date.now();
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { openDatabase } from ${JSON.stringify(dbModule)};
       try { openDatabase(${JSON.stringify(path)}); console.log('opened'); }
       catch (error) { console.log(error.name); }`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.stdout.trim(), 'DatabaseInUseError', child.stderr);
  assert.ok(Date.now() - started < 5000, 'the second process waited instead of failing');
  assert.equal(first.prepare('SELECT COUNT(*) AS n FROM conversations').get()?.n, 1);
  first.close();
  // Once the first closes, the file can be opened again.
  openDatabase(path).close();
});

test('a second server over the same database fails to start and the first keeps working', async (t) => {
  const h = await startHarness(t);
  await assert.rejects(startCloudServer(h.options), DatabaseInUseError);
  const res = await h.api('/v1/conversations');
  assert.equal(res.status, 200);
});

test('after the first server closes, a new one starts over the same database', async (t) => {
  const h = await startHarness(t);
  await h.restart();
  const res = await h.api('/v1/conversations');
  assert.equal(res.status, 200);
});
