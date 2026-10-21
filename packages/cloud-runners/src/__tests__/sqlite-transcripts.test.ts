import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  SqliteTranscriptStore,
  TranscriptDatabaseInUseError,
  TranscriptDatabaseVersionError,
} from '../sqlite-transcripts.js';
import type { TranscriptLine } from '../transcripts.js';
import { DatabaseSync } from 'node:sqlite';

const SESSION = '11111111-2222-4333-8444-555555555555';
const KEY = { projectKey: '-work-tsk-a-workspace', sessionId: SESSION };
const line = (n: number): TranscriptLine => ({
  json: JSON.stringify({ type: 'user', uuid: `u${n}`, n }),
  uuid: `u${n}`,
});

async function dir(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), 'transcripts-db-'));
  t.after(() => fs.rm(path, { recursive: true, force: true }));
  return path;
}

test('what was kept is there after the server restarts, and one server holds the file at a time', async (t) => {
  const path = join(await dir(t), 'transcripts.db');
  const first = SqliteTranscriptStore.open(path);
  await first.append('tsk_a', KEY, [line(1), line(2)]);
  assert.throws(() => SqliteTranscriptStore.open(path), TranscriptDatabaseInUseError);
  first.close();
  first.close();

  const second = SqliteTranscriptStore.open(path);
  t.after(() => second.close());
  assert.equal((await second.locate('tsk_a', SESSION))?.lines, 2);
  await second.append('tsk_a', KEY, [line(2), line(3)]);
  assert.deepEqual(
    (await second.read('tsk_a', SESSION)).lines.map((text) => JSON.parse(text).n),
    [1, 2, 3],
  );
});

test('a database of another schema version is refused and left alone', async (t) => {
  const path = join(await dir(t), 'transcripts.db');
  const other = new DatabaseSync(path);
  other.exec('PRAGMA user_version = 99');
  other.close();
  assert.throws(() => SqliteTranscriptStore.open(path), TranscriptDatabaseVersionError);
  const check = new DatabaseSync(path);
  assert.equal(
    (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    99,
  );
  check.close();
});

test('a backup is a whole, readable copy taken while the store is open', async (t) => {
  const base = await dir(t);
  const store = SqliteTranscriptStore.open(join(base, 'transcripts.db'));
  t.after(() => store.close());
  await store.append('tsk_a', KEY, [line(1), line(2), line(3)]);
  await store.backupTo(join(base, 'copy.db'));
  await store.append('tsk_a', KEY, [line(4)]);

  const copy = SqliteTranscriptStore.open(join(base, 'copy.db'));
  t.after(() => copy.close());
  assert.equal((await copy.locate('tsk_a', SESSION))?.lines, 3);
});

test('a task over its byte cap keeps nothing of the batch that broke it, and deleting a task removes every row of it', async (t) => {
  const base = await dir(t);
  const path = join(base, 'transcripts.db');
  const store = SqliteTranscriptStore.open(path, { maxTaskBytes: 250 });
  const pad = (n: number): TranscriptLine => ({
    json: JSON.stringify({ n, pad: 'z'.repeat(60) }),
    uuid: `p${n}`,
  });
  await store.append('tsk_a', KEY, [pad(1), pad(2)]);
  await assert.rejects(store.append('tsk_a', KEY, [pad(3), pad(4)]), /byte cap/);
  assert.equal((await store.locate('tsk_a', SESSION))?.lines, 2);
  // The refused lines are not stored, so the same batch cut down still goes in at the right place.
  await store.append('tsk_a', KEY, [pad(3)]);
  assert.deepEqual(
    (await store.read('tsk_a', SESSION)).lines.map((text) => JSON.parse(text).n),
    [1, 2, 3],
  );
  await store.deleteTask('tsk_a');
  store.close();

  const check = new DatabaseSync(path);
  for (const table of ['transcript_tasks', 'transcripts', 'transcript_lines']) {
    const row = check.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    assert.equal(row.count, 0, table);
  }
  check.close();
});
