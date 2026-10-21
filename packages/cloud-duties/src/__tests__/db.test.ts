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
    assert.equal(versionOf(first), 4);
    first.prepare('INSERT INTO person_events (event_key, seen_at) VALUES (?, ?)').run('e', 1);
    first.close();
    const again = openDatabase(path);
    assert.equal(versionOf(again), 4);
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
    first.exec('PRAGMA user_version = 5');
    first.close();
    assert.throws(() => openDatabase(path), DutiesDatabaseVersionError);
  });
});

test('a version 2 database gets the cards added and keeps everything else', () => {
  withDir((path) => {
    const first = openDatabase(path);
    first.exec('DROP TABLE cards');
    first.exec('DROP TABLE card_kinds');
    first.prepare('INSERT INTO person_events (event_key, seen_at) VALUES (?, ?)').run('kept', 7);
    first.exec('PRAGMA user_version = 2');
    first.close();

    const again = openDatabase(path);
    assert.equal(versionOf(again), 4);
    assert.deepEqual(
      again
        .prepare('SELECT event_key, seen_at FROM person_events')
        .all()
        .map((r) => ({ ...r })),
      [{ event_key: 'kept', seen_at: 7 }],
    );
    assert.equal((again.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n, 0);
    assert.equal(
      (again.prepare('SELECT COUNT(*) AS n FROM card_kinds').get() as { n: number }).n,
      0,
    );
    again.close();
  });
});

test('a version 3 database gets the settlement columns and keeps its cards', () => {
  withDir((path) => {
    const first = openDatabase(path);
    // What version 3 wrote: cards without the estimate basis or the settlement columns.
    first.exec('DROP TABLE cards');
    first.exec(`CREATE TABLE cards (
      card_id TEXT PRIMARY KEY, owner TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL,
      subject_key TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, brief TEXT NOT NULL,
      estimate_micro INTEGER NOT NULL, precondition TEXT NOT NULL, external INTEGER NOT NULL,
      state TEXT NOT NULL, day TEXT NOT NULL, replaces TEXT, created_at INTEGER NOT NULL,
      decided_at INTEGER, conversation_id TEXT)`);
    first
      .prepare(
        "INSERT INTO cards VALUES ('card_old', 'o', 'p', 'fix_main_ci', 'main', 't', 'd', 'b', 3000000, 'h', 0, 'open', '2026-10-20', NULL, 1, NULL, NULL)",
      )
      .run();
    first.exec('PRAGMA user_version = 3');
    first.close();

    const again = openDatabase(path);
    assert.equal(versionOf(again), 4);
    assert.deepEqual(
      { ...(again.prepare('SELECT * FROM cards').get() as Record<string, unknown>) },
      {
        card_id: 'card_old',
        owner: 'o',
        project_id: 'p',
        kind: 'fix_main_ci',
        subject_key: 'main',
        title: 't',
        detail: 'd',
        brief: 'b',
        estimate_micro: 3000000,
        precondition: 'h',
        external: 0,
        state: 'open',
        day: '2026-10-20',
        replaces: null,
        created_at: 1,
        decided_at: null,
        conversation_id: null,
        typical: 0,
        spent_micro: null,
        outcome: null,
        settled_at: null,
      },
    );
    again.close();
  });
});
