import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MIGRATIONS } from '../db.js';
import { INVITE_MIGRATIONS, InviteStore } from '../invites.js';
import { recordingHandler } from './conductor.js';
import { eventually, openStream, postJson, startHarness } from './harness.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
const run = promisify(execFile);

test('conversations from before owners existed are seen by no invite until the command line gives them to one', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'migration-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A database as schema 4 left it, with one conversation, its feed row and a message.
  const old = new DatabaseSync(join(dir, 'server.sqlite'));
  for (const step of MIGRATIONS.slice(0, 4)) old.exec(step);
  old.exec('PRAGMA user_version = 4');
  old.exec(`
    INSERT INTO conversations (conversation_id, n, title, session_id, created_at)
      VALUES ('cnv_old', 1, 'From before', 'ses_old', 1);
    INSERT INTO feed (kind, conversation_id, ref, at) VALUES ('conversation.created', 'cnv_old', 'cnv_old', 1);
    INSERT INTO messages (n, message_id, conversation_id, role, text, client_message_id, at)
      VALUES (1, 'msg_old', 'cnv_old', 'user', 'old', NULL, 1);
    INSERT INTO feed (kind, conversation_id, ref, at) VALUES ('message.posted', 'cnv_old', 'msg_old', 1);
  `);
  old.close();

  const h = await startHarness(t, { dir });
  assert.deepEqual(await (await h.api('/v1/conversations')).json(), { conversations: [] });
  assert.equal((await h.api('/v1/conversations/cnv_old/tasks')).status, 404);
  const stream = await openStream(t, h);
  // A conversation of the harness invite, written after the old rows, marks the end of the history.
  await postJson(h, '/v1/conversations', {});
  await stream.until(1, 'the marker');
  assert.deepEqual(
    stream.events.map((event) => event.data.conversationId === 'cnv_old'),
    [false],
  );
  stream.close();

  // The command line refuses while the server holds the database, then adopts once it is stopped.
  await assert.rejects(
    run(process.execPath, [
      CLI,
      'conversation',
      'adopt',
      '--db',
      h.options.dbPath,
      '--invites',
      h.options.invitesPath,
      h.inviteId,
    ]),
  );
  await h.server.close();
  const adopted = await run(process.execPath, [
    CLI,
    'conversation',
    'adopt',
    '--db',
    h.options.dbPath,
    '--invites',
    h.options.invitesPath,
    h.inviteId,
  ]);
  assert.match(adopted.stdout, /adopted: 1/u);
  const { handler, messages } = recordingHandler();
  await h.restart({ handler });
  const listed = (await (await h.api('/v1/conversations')).json()) as {
    conversations: Array<{ conversationId: string }>;
  };
  assert.deepEqual(
    listed.conversations.map((conversation) => conversation.conversationId),
    ['cnv_old', listed.conversations[1]?.conversationId],
  );
  // A message from before v5 has no delivery row, so it is not replayed after the upgrade.
  await postJson(h, '/v1/conversations/cnv_old/messages', { text: 'marker' });
  await eventually(() => messages.length > 0, 'the marker');
  assert.deepEqual(
    messages.map((message) => message.text),
    ['marker'],
  );
});

test('adopt refuses an invite that is not active', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'adopt-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const invites = new InviteStore(join(dir, 'invites.sqlite'));
  const gone = invites.create('gone');
  invites.revoke(gone.inviteId);
  invites.close();
  await assert.rejects(
    run(process.execPath, [
      CLI,
      'conversation',
      'adopt',
      '--db',
      join(dir, 'server.sqlite'),
      '--invites',
      join(dir, 'invites.sqlite'),
      gone.inviteId,
    ]),
    /No active invite/u,
  );
});

test('an invites file from before it had a version is upgraded in place and its tokens still work', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'invites-migration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'invites.sqlite');
  // Today's file: the table, created with IF NOT EXISTS, and user_version 0.
  const raw = new DatabaseSync(path);
  raw.exec(`CREATE TABLE IF NOT EXISTS invites (
      invite_id TEXT PRIMARY KEY,
      token_sha256 BLOB NOT NULL,
      label TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    )`);
  raw.close();
  const first = new InviteStore(path);
  const created = first.create('kept');
  first.close();
  // Back to version 0, as a file written before versions existed (and before the limit columns).
  const reset = new DatabaseSync(path);
  reset.exec('ALTER TABLE invites DROP COLUMN daily_limit_usd');
  reset.exec('ALTER TABLE invites DROP COLUMN monthly_limit_usd');
  reset.exec('ALTER TABLE invites DROP COLUMN language');
  reset.exec('PRAGMA user_version = 0');
  reset.close();

  const store = new InviteStore(path);
  try {
    assert.equal(store.resolve(created.token)?.inviteId, created.inviteId);
  } finally {
    store.close();
  }
  const check = new DatabaseSync(path);
  try {
    assert.equal(
      (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      INVITE_MIGRATIONS.length,
    );
  } finally {
    check.close();
  }
});

test('an invites file of a newer version is refused, not opened', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'invites-newer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'invites.sqlite');
  const raw = new DatabaseSync(path);
  raw.exec(`PRAGMA user_version = ${INVITE_MIGRATIONS.length + 1}`);
  raw.close();
  assert.throws(() => new InviteStore(path), /Unsupported invites schema version/u);
});
