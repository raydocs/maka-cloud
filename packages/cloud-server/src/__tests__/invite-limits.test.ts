import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { INVITE_MIGRATIONS, InviteStore } from '../invites.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

async function invitesFile(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'invite-limits-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'invites.db');
}

function cli(path: string, ...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args, '--invites', path], { encoding: 'utf8' });
}

test('an invite has no limits until they are set, and a cap left out keeps its value', async (t) => {
  const store = new InviteStore(await invitesFile(t));
  t.after(() => store.close());
  const { inviteId } = store.create('beta');
  assert.deepEqual(store.limits(inviteId), { dailyUsd: null, monthlyUsd: null });
  assert.equal(store.setLimits(inviteId, { dailyUsd: 2 }), true);
  assert.equal(store.setLimits(inviteId, { monthlyUsd: 20 }), true);
  assert.deepEqual(store.limits(inviteId), { dailyUsd: 2, monthlyUsd: 20 });
  assert.equal(store.setLimits(inviteId, { dailyUsd: 0 }), true, '0 lets the invite spend nothing');
  assert.deepEqual(store.limits(inviteId), { dailyUsd: 0, monthlyUsd: 20 });
});

test('limits of an unknown or revoked invite are not readable or settable', async (t) => {
  const store = new InviteStore(await invitesFile(t));
  t.after(() => store.close());
  const { inviteId } = store.create('gone');
  store.setLimits(inviteId, { dailyUsd: 5 });
  store.revoke(inviteId);
  assert.equal(store.limits(inviteId), undefined);
  assert.equal(store.setLimits(inviteId, { dailyUsd: 9 }), false);
  assert.equal(store.limits('inv_000000000000'), undefined);
  assert.equal(store.setLimits('inv_000000000000', { dailyUsd: 9 }), false);
});

test('a cap that is not a number of dollars is refused and changes nothing', async (t) => {
  const store = new InviteStore(await invitesFile(t));
  t.after(() => store.close());
  const { inviteId } = store.create('beta');
  store.setLimits(inviteId, { dailyUsd: 3 });
  for (const usd of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    assert.throws(() => store.setLimits(inviteId, { dailyUsd: usd }), RangeError);
    assert.throws(() => store.setLimits(inviteId, { monthlyUsd: usd }), RangeError);
  }
  assert.deepEqual(store.limits(inviteId), { dailyUsd: 3, monthlyUsd: null });
});

test('a change from another connection is read at once by a store that is already open', async (t) => {
  const path = await invitesFile(t);
  const server = new InviteStore(path);
  t.after(() => server.close());
  const { inviteId } = server.create('beta');
  assert.deepEqual(server.limits(inviteId), { dailyUsd: null, monthlyUsd: null });
  const set = cli(path, 'invite', 'limits', inviteId, '--daily', '1.5', '--monthly', '12');
  assert.equal(set.status, 0, set.stderr);
  assert.deepEqual(server.limits(inviteId), { dailyUsd: 1.5, monthlyUsd: 12 });
});

test('an invites file from before limits existed is upgraded in place and keeps its invites', async (t) => {
  const path = await invitesFile(t);
  // The file as version 1 left it: the table without the limit columns.
  const raw = new DatabaseSync(path);
  raw.exec(INVITE_MIGRATIONS[0] ?? '');
  raw.exec('PRAGMA user_version = 1');
  raw.exec(`INSERT INTO invites (invite_id, token_sha256, label, created_at)
    VALUES ('inv_old000000000', x'00', 'before', 1)`);
  raw.close();

  const store = new InviteStore(path);
  t.after(() => store.close());
  assert.equal(store.active('inv_old000000000'), true);
  assert.deepEqual(store.limits('inv_old000000000'), { dailyUsd: null, monthlyUsd: null });
  assert.equal(store.setLimits('inv_old000000000', { dailyUsd: 4 }), true);
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

test('the command line sets, shows and lists limits, and refuses what it cannot apply', async (t) => {
  const path = await invitesFile(t);
  const created = cli(path, 'invite', 'create', '--label', 'beta');
  const inviteId = /inviteId:\s+(\S+)/u.exec(created.stdout)?.[1] ?? '';
  assert.match(inviteId, /^inv_/u);

  assert.match(
    cli(path, 'invite', 'limits', inviteId).stdout,
    /daily:\s+default\nmonthly:\s+default/u,
  );
  const set = cli(path, 'invite', 'limits', inviteId, '--daily', '3', '--monthly', '30');
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /daily:\s+\$3\nmonthly:\s+\$30/u);
  assert.match(
    cli(path, 'invite', 'list').stdout,
    new RegExp(`${inviteId}\\tactive\\tbeta\\tdaily=\\$3\\tmonthly=\\$30`, 'u'),
  );

  for (const bad of ['-1', 'abc', '1e3', '', '1,5']) {
    const refused = cli(path, 'invite', 'limits', inviteId, '--daily', bad);
    assert.equal(refused.status, 2, `--daily ${bad}`);
  }
  assert.match(cli(path, 'invite', 'limits', inviteId).stdout, /daily:\s+\$3/u, 'nothing changed');
  assert.equal(cli(path, 'invite', 'limits', 'inv_000000000000', '--daily', '1').status, 1);
  assert.equal(cli(path, 'invite', 'limits', 'inv_000000000000').status, 1);

  cli(path, 'invite', 'revoke', inviteId);
  assert.equal(cli(path, 'invite', 'limits', inviteId, '--daily', '9').status, 1);
  assert.equal(cli(path, 'invite', 'limits').status, 2);
});
