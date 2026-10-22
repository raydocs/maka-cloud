import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { AccountStore, SESSION_IDLE_MS } from '../accounts.js';
import { InviteStore } from '../invites.js';
import { eventually, newConversation, openStream, postJson, startHarness } from './harness.js';

async function stores(t: TestContext, clock: { now: number } = { now: 1_000 }) {
  const dir = await mkdtemp(join(tmpdir(), 'accounts-'));
  const path = join(dir, 'invites.db');
  const invites = new InviteStore(path, () => clock.now);
  const accounts = new AccountStore(path, () => clock.now);
  t.after(async () => {
    accounts.close();
    invites.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { path, invites, accounts, clock };
}

test('a session token acts as the invite of its account, and only its hash is stored', async (t) => {
  const { path, invites, accounts } = await stores(t);
  const invite = invites.create('beta');
  const accountId = accounts.createAccount(invite.inviteId);
  assert.ok(accountId);
  const session = accounts.issueSession(accountId, 'Ada’s phone');
  assert.ok(session);
  assert.match(session.token, /^mks_ses_[0-9a-f]{12}\./);
  assert.deepEqual(accounts.resolve(session.token), {
    inviteId: invite.inviteId,
    sessionId: session.sessionId,
  });
  const raw = new DatabaseSync(path);
  t.after(() => raw.close());
  const row = raw.prepare('SELECT * FROM sessions').get() as Record<string, unknown>;
  assert.ok(row.token_sha256 instanceof Uint8Array);
  assert.equal(
    JSON.stringify(Object.values(row).map((v) => (typeof v === 'string' ? v : ''))).includes(
      session.token.slice(session.token.indexOf('.') + 1),
    ),
    false,
    'the secret is not stored',
  );
});

test('an invite has one account, and a revoked or unknown invite has none', async (t) => {
  const { invites, accounts } = await stores(t);
  const invite = invites.create('beta');
  assert.ok(accounts.createAccount(invite.inviteId));
  assert.equal(accounts.createAccount(invite.inviteId), undefined, 'a second account');
  assert.equal(accounts.createAccount('inv_000000000000'), undefined);
  const gone = invites.create('gone');
  invites.revoke(gone.inviteId);
  assert.equal(accounts.createAccount(gone.inviteId), undefined);
});

test('revoking the invite ends every session of its account and stops new ones', async (t) => {
  const { invites, accounts } = await stores(t);
  const invite = invites.create('beta');
  const accountId = accounts.createAccount(invite.inviteId) ?? assert.fail('no account');
  const phone = accounts.issueSession(accountId, 'phone') ?? assert.fail('no session');
  const laptop = accounts.issueSession(accountId, 'laptop') ?? assert.fail('no session');
  invites.revoke(invite.inviteId);
  for (const session of [phone, laptop]) {
    assert.equal(accounts.resolve(session.token), undefined);
    assert.equal(accounts.active(session.sessionId), false);
  }
  assert.equal(accounts.issueSession(accountId, 'tablet'), undefined);
});

test('one device can be signed out, and only by its own account', async (t) => {
  const { invites, accounts } = await stores(t);
  const ada = accounts.createAccount(invites.create('ada').inviteId) ?? assert.fail('no account');
  const bob = accounts.createAccount(invites.create('bob').inviteId) ?? assert.fail('no account');
  const phone = accounts.issueSession(ada, 'phone') ?? assert.fail('no session');
  const laptop = accounts.issueSession(ada, 'laptop') ?? assert.fail('no session');
  const seen: string[] = [];
  accounts.onRevoke((id) => seen.push(id));
  assert.equal(accounts.revokeSession(bob, phone.sessionId), false, 'another account');
  assert.ok(accounts.resolve(phone.token));
  assert.equal(accounts.revokeSession(ada, phone.sessionId), true);
  assert.equal(accounts.revokeSession(ada, phone.sessionId), false, 'already revoked');
  assert.equal(accounts.resolve(phone.token), undefined);
  assert.ok(accounts.resolve(laptop.token), 'the other device stays signed in');
  assert.deepEqual(seen, [phone.sessionId]);
  assert.deepEqual(
    accounts.sessions(ada).map((s) => s.deviceLabel),
    ['laptop'],
  );
});

test('a token that is malformed, has the wrong secret, or is an invite token resolves to nothing', async (t) => {
  const { invites, accounts } = await stores(t);
  const invite = invites.create('beta');
  const accountId = accounts.createAccount(invite.inviteId) ?? assert.fail('no account');
  const session = accounts.issueSession(accountId, 'phone') ?? assert.fail('no session');
  const id = session.sessionId;
  for (const token of [
    '',
    'mks_',
    `mks_${id}`,
    `mks_${id}.`,
    `mks_${id}.wrong`,
    `mks_${id}.${session.token.slice(session.token.indexOf('.') + 1)}x`,
    session.token.replace('mks_', 'mki_'),
    invite.token,
    'mks_ses_000000000000.abc',
  ]) {
    assert.equal(accounts.resolve(token), undefined, token);
  }
});

test('a device idle for too long signs in again, and use keeps it from going idle', async (t) => {
  const { invites, accounts, clock } = await stores(t);
  const accountId =
    accounts.createAccount(invites.create('beta').inviteId) ?? assert.fail('no account');
  const session = accounts.issueSession(accountId, 'phone') ?? assert.fail('no session');
  clock.now += SESSION_IDLE_MS - 1_000;
  assert.ok(accounts.resolve(session.token), 'seen just before it went idle');
  clock.now += SESSION_IDLE_MS - 1_000;
  assert.ok(accounts.resolve(session.token), 'that use renewed it');
  clock.now += SESSION_IDLE_MS + 1_000;
  assert.equal(accounts.resolve(session.token), undefined);
  assert.equal(accounts.active(session.sessionId), false);
});

test('a device name cannot carry control characters or be empty', async (t) => {
  const { invites, accounts } = await stores(t);
  const accountId =
    accounts.createAccount(invites.create('beta').inviteId) ?? assert.fail('no account');
  assert.equal(accounts.issueSession(accountId, ' Ada\u0007‮ phone ')?.deviceLabel, 'Ada phone');
  assert.equal(accounts.issueSession(accountId, '\u0000  ')?.deviceLabel, 'Unnamed device');
  assert.equal(accounts.issueSession(accountId, 'x'.repeat(500))?.deviceLabel.length, 80);
});

async function signedIn(t: TestContext) {
  const h = await startHarness(t);
  const { accounts, invites } = h.server;
  const accountId = accounts.createAccount(h.inviteId) ?? assert.fail('no account');
  const session = accounts.issueSession(accountId, 'phone') ?? assert.fail('no session');
  return { h, accounts, invites, accountId, session };
}

test('a session token works on the API as its invite, and the invite token still does', async (t) => {
  const { h, session } = await signedIn(t);
  const conversationId = await newConversation(h);
  const post = (token: string) =>
    postJson(h, `/v1/conversations/${conversationId}/messages`, { text: 'hi' }, token);
  assert.equal((await post(session.token)).status, 202);
  assert.equal((await post(h.token)).status, 202);
});

test('another invite’s data is a 404 for a session, same as for the invite itself', async (t) => {
  const { h, invites, accounts, session } = await signedIn(t);
  const other = invites.create('other');
  const otherAccount = accounts.createAccount(other.inviteId) ?? assert.fail('no account');
  const otherSession = accounts.issueSession(otherAccount, 'phone') ?? assert.fail('no session');
  const conversationId = await newConversation(h);
  const path = `/v1/conversations/${conversationId}/messages`;
  assert.equal((await postJson(h, path, { text: 'x' }, otherSession.token)).status, 404);
  assert.equal((await postJson(h, path, { text: 'x' }, other.token)).status, 404);
  assert.equal((await postJson(h, path, { text: 'x' }, session.token)).status, 202);
});

test('a revoked session, a session of a revoked invite and a made-up one get 401', async (t) => {
  const { h, accounts, invites, accountId, session } = await signedIn(t);
  const second = accounts.issueSession(accountId, 'tablet') ?? assert.fail('no session');
  const conversationId = await newConversation(h);
  const post = (token: string) =>
    postJson(h, `/v1/conversations/${conversationId}/messages`, { text: 'hi' }, token);
  assert.equal(accounts.revokeSession(accountId, session.sessionId), true);
  assert.equal((await post(session.token)).status, 401);
  assert.equal((await post('mks_ses_000000000000.nope')).status, 401);
  assert.equal((await post(second.token)).status, 202);
  invites.revoke(h.inviteId);
  assert.equal((await post(second.token)).status, 401);
});

test('signing out a device ends its open stream and no other', async (t) => {
  const { h, accounts, accountId, session } = await signedIn(t);
  const other = accounts.issueSession(accountId, 'tablet') ?? assert.fail('no session');
  const mine = await openStream(t, h, '', {}, session.token);
  const theirs = await openStream(t, h, '', {}, other.token);
  const viaInvite = await openStream(t, h);
  assert.equal(mine.status, 200);
  await eventually(() => h.server.openStreams() === 3, 'three streams open');
  accounts.revokeSession(accountId, session.sessionId);
  await mine.closed;
  await eventually(() => h.server.openStreams() === 2, 'one stream closed');
  assert.equal(theirs.status, 200);
  assert.equal(viaInvite.status, 200);
});

test('revoking the invite ends the streams of its devices', async (t) => {
  const { h, invites, session } = await signedIn(t);
  const stream = await openStream(t, h, '', {}, session.token);
  assert.equal(stream.status, 200);
  invites.revoke(h.inviteId);
  await stream.closed;
  await eventually(() => h.server.openStreams() === 0, 'streams closed');
});
