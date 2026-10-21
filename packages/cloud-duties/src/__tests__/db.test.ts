import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../db.js';

test('a database made before chains remembered their newest failure opens, upgrades and keeps its rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'duties-db-'));
  const path = join(dir, 'duties.db');
  try {
    const first = openDatabase(path);
    first.exec(
      `INSERT INTO projects (project_id, owner, repo, installation_id, default_branch, self_logins,
         created_at) VALUES ('p1', 'inv_00000000000a', 'acme/widgets', 1, 'main', '[]', 1)`,
    );
    // Put it back to what the first release wrote.
    first.exec('DROP TABLE person_events');
    first.exec('ALTER TABLE chains DROP COLUMN last_failure_seq');
    first.exec(
      `INSERT INTO chains (chain_key, project_id, depth, started_at) VALUES ('k', 'p1', 2, 5)`,
    );
    first.exec('PRAGMA user_version = 1');
    first.close();

    const db = openDatabase(path);
    const chain = db.prepare('SELECT depth, last_failure_seq FROM chains').get() as {
      depth: number;
      last_failure_seq: number;
    };
    assert.deepEqual({ ...chain }, { depth: 2, last_failure_seq: 0 });
    db.prepare('INSERT INTO person_events (event_key, seen_at) VALUES (?, ?)').run('e', 1);
    const version = db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    assert.equal(version.user_version, 2);
    db.close();
    openDatabase(path).close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
