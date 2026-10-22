import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type Conductor, ConductorState } from '@maka-cloud/conductor';
import type { Supervisor } from '@maka-cloud/supervisor';
import { inboxService } from '../inbox/service.js';

function fakeSupervisor() {
  const calls: unknown[][] = [];
  const supervisor = {
    setOwnerMute: (...args: unknown[]) => (calls.push(['mute', ...args]), { mutedKinds: [] }),
    getOwnerSettings: (...args: unknown[]) => (calls.push(['get', ...args]), {}),
    setOwnerSettings: (...args: unknown[]) => (calls.push(['set', ...args]), {}),
    digest: async (...args: unknown[]) => (calls.push(['digest', ...args]), {}),
  } as unknown as Supervisor;
  return { service: inboxService(supervisor), calls };
}

test('the inbox service passes the owner to every call and refuses what is the operator’s to set', async () => {
  const { service, calls } = fakeSupervisor();
  assert.deepEqual(service.setMute('inv_a', 'nonsense', true), { ok: false });
  assert.equal(service.setMute('inv_a', 'finished', true).ok, true);
  service.settings('inv_a');
  await service.digest('inv_a');
  assert.equal(service.updateSettings('inv_a', { quietHours: null }).ok, true);
  for (const patch of [
    { stallAfterMinutes: 1 },
    { maxInterruptsPerHour: 1000 },
    { digestAt: null },
    { verifierDailyCapUsd: 999 },
    { timeZone: 'Not/AZone' },
  ]) {
    assert.deepEqual(service.updateSettings('inv_a', patch), { ok: false }, JSON.stringify(patch));
  }
  assert.deepEqual(
    calls.map((call) => [call[0], call[1]]),
    [
      ['mute', 'inv_a'],
      ['get', 'inv_a'],
      ['digest', 'inv_a'],
      ['set', 'inv_a'],
    ],
  );
});

test('the approvals an owner kept are listed and revoked per owner, with their uses', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'grants-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new ConductorState(join(dir, 'conductor.db'), () => 5_000);
  t.after(() => state.db.close());
  const grant = (id: string, owner: string, repository: string, scope: string) =>
    state.db
      .prepare(
        `INSERT INTO grants (grant_id, owner, tool, repository, fixed, scope, conversation_id, run_id, question_id, created_at, expires_at)
         VALUES (?, ?, 'open_pull_request', ?, '{}', ?, 'cnv', NULL, ?, 1000, 100000)`,
      )
      .run(id, owner, repository, scope, `q_${id}`);
  grant('g1', 'inv_a', 'acme/widgets', 'repository');
  grant('g2', 'inv_a', 'acme/gadgets', 'repository');
  grant('g3', 'inv_b', 'acme/widgets', 'repository');
  state.db
    .prepare(
      "INSERT INTO grant_uses (grant_id, run_id, conversation_id, args, at) VALUES ('g1', 'r', 'cnv', '{}', 4000)",
    )
    .run();
  const { grants } = inboxService({} as Supervisor, { state } as unknown as Conductor);
  assert.ok(grants);

  const mine = grants.list('inv_a');
  assert.deepEqual(mine.map((entry) => [entry.grantId, entry.uses, entry.lastUsedAt]).sort(), [
    ['g1', 1, 4000],
    ['g2', 0, null],
  ]);
  // What is listed names no owner and no call arguments.
  for (const entry of mine)
    assert.deepEqual(Object.keys(entry).sort(), [
      'createdAt',
      'expiresAt',
      'grantId',
      'lastUsedAt',
      'repository',
      'scope',
      'tool',
      'uses',
    ]);
  assert.deepEqual(
    grants.list('inv_b').map((entry) => entry.grantId),
    ['g3'],
  );

  assert.equal(grants.revoke('inv_b', 'g1'), false);
  assert.equal(grants.revokeAll('inv_b', { repository: 'acme/gadgets' }), 0);
  assert.equal(grants.revokeAll('inv_a', { repository: 'acme/gadgets' }), 1);
  assert.equal(grants.revoke('inv_a', 'g1'), true);
  assert.deepEqual(grants.list('inv_a'), []);
  assert.deepEqual(
    grants.list('inv_b').map((entry) => entry.grantId),
    ['g3'],
  );

  // Without a conductor there is nothing to list.
  assert.equal(inboxService({} as Supervisor).grants, undefined);
});
