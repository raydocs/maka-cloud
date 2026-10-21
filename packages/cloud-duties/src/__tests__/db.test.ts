import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { DutiesDatabaseVersionError, openDatabase } from '../db.js';

function withDir(work: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'duties-db-'));
  try {
    work(join(dir, 'duties.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const versionOf = (db: DatabaseSync) =>
  (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

test('a new database is made at the current version and opens again', () => {
  withDir((path) => {
    const first = openDatabase(path);
    assert.equal(versionOf(first), 2);
    first.prepare('INSERT INTO person_events (event_key, seen_at) VALUES (?, ?)').run('e', 1);
    first.close();
    const again = openDatabase(path);
    assert.equal(versionOf(again), 2);
    again.close();
  });
});

test('a database written by the older CI ordering is refused and left exactly as it was', () => {
  withDir((path) => {
    const first = openDatabase(path);
    // What the first release wrote: run numbers alone, chains without a newest failure.
    first.exec('DROP TABLE person_events');
    first.exec('ALTER TABLE chains DROP COLUMN last_failure_seq');
    first.exec("INSERT INTO ci_state (scope, last_success_seq) VALUES ('acme/widgets:1:main', 50)");
    first.exec('PRAGMA user_version = 1');
    first.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    first.close();
    const before = readFileSync(path);

    assert.throws(
      () => openDatabase(path),
      (error: unknown) =>
        error instanceof DutiesDatabaseVersionError &&
        error.version === 1 &&
        /different build/u.test(error.message),
    );
    assert.deepEqual(readFileSync(path), before, 'not one byte changed');
    const raw = new DatabaseSync(path);
    assert.equal(versionOf(raw), 1);
    raw.close();
  });
});

test('a database from a newer build is refused too', () => {
  withDir((path) => {
    const first = openDatabase(path);
    first.exec('PRAGMA user_version = 3');
    first.close();
    assert.throws(() => openDatabase(path), DutiesDatabaseVersionError);
  });
});
