import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  type BuilderBoxes,
  repoDir,
  SetupFailedError,
  type SetupRecipe,
  SnapshotOwnerError,
  SetupSnapshots,
  setupHash,
  snapshotName,
} from '../snapshots.js';
import { FakeFleet } from './fake-fleet.js';

const A = 'inv_aaaaaaaaaaaa';
const B = 'inv_bbbbbbbbbbbb';
const REPO = 'https://github.com/example/app.git';
const SHA = 'a'.repeat(40);
const SCRIPT = '#!/bin/sh\nnpm ci\n';

const recipe = (overrides: Partial<SetupRecipe> = {}): SetupRecipe => ({
  tenantId: A,
  repoUrl: REPO,
  ref: SHA,
  setupScript: SCRIPT,
  prepare: ['echo install the pinned CLIs'],
  base: 't_node',
  ...overrides,
});

/** Builder boxes backed by machines the fleet already has; counts what was leased and given back. */
function builders(fleet: FakeFleet) {
  const log = { leased: [] as { tenantId: string; job: string }[], released: 0 };
  const boxes: BuilderBoxes = {
    async lease(input) {
      log.leased.push(input);
      const machine = fleet.seed({ name: `builder-${log.leased.length}` });
      return {
        machineId: machine.id,
        release: () => {
          log.released++;
        },
      };
    },
  };
  return { boxes, log };
}

function setup(overrides: { guard?: (machineId: string) => Promise<void>; keep?: number } = {}) {
  const fleet = new FakeFleet();
  const { boxes, log } = builders(fleet);
  const guarded: string[] = [];
  const warnings: string[] = [];
  const make = () =>
    new SetupSnapshots({
      api: fleet,
      boxes,
      guard:
        overrides.guard ??
        (async (machineId) => {
          guarded.push(machineId);
        }),
      ...(overrides.keep === undefined ? {} : { keep: overrides.keep }),
      onWarning: (message) => warnings.push(message),
    });
  return { fleet, log, guarded, warnings, snapshots: make(), make };
}

describe('setup hash and names', () => {
  it('the hash follows the script, the preparation, the base and the repository, not the commit', () => {
    const base = setupHash(recipe());
    assert.equal(base, setupHash(recipe({ ref: 'b'.repeat(40) })));
    assert.notEqual(base, setupHash(recipe({ setupScript: `${SCRIPT}# changed` })));
    assert.notEqual(base, setupHash(recipe({ setupScript: undefined })));
    assert.notEqual(base, setupHash(recipe({ prepare: ['echo other'] })));
    assert.notEqual(base, setupHash(recipe({ base: 't_other' })));
    assert.notEqual(base, setupHash(recipe({ repoUrl: 'https://github.com/example/other.git' })));
  });

  it('the name is valid for instabox and differs by invite, so an invite never meets another invite snapshot', () => {
    const hash = setupHash(recipe());
    const a = snapshotName(A, REPO, hash);
    assert.match(a, /^[a-z0-9][a-z0-9-]{0,62}$/);
    assert.notEqual(a, snapshotName(B, REPO, hash));
    assert.notEqual(a, snapshotName(A, 'https://github.com/example/other.git', hash));
  });
});

describe('SetupSnapshots', () => {
  it('guards the builder first, clones, prepares, runs the repository setup, saves a snapshot by name, and gives the box back', async () => {
    const t = setup();
    const result = await t.snapshots.ensure(recipe());
    const hash = setupHash(recipe());
    assert.equal(result.built, true);
    assert.equal(result.setupHash, hash);
    assert.equal(t.fleet.snapshots.get(result.snapshotId)?.name, snapshotName(A, REPO, hash));
    assert.deepEqual(t.log.leased, [{ tenantId: A, job: `setup-${hash.slice(0, 12)}` }]);
    assert.equal(t.log.released, 1);
    assert.equal(t.guarded.length, 1);

    const steps = t.fleet.execRequests;
    assert.equal(steps.length, 4, 'checkout, one prepare step, the setup, sync');
    assert.match(steps[0]?.cmd ?? '', /git clone/);
    assert.equal(steps[0]?.envs.MAKA_REPO_URL, REPO);
    assert.equal(steps[0]?.envs.MAKA_REF, SHA);
    assert.equal(steps[0]?.envs.MAKA_REPO_DIR, repoDir(REPO));
    assert.equal(
      steps[0]?.envs.MAKA_SETUP_SHA256,
      createHash('sha256').update(SCRIPT).digest('hex'),
    );
    assert.equal(steps[1]?.cmd, 'echo install the pinned CLIs');
    assert.match(steps[2]?.cmd ?? '', /\.agents\/setup/);
    assert.equal(steps[2]?.envs.MAKA_SETUP_HASH, hash);
    assert.equal(steps[3]?.cmd, 'sync');
    assert.equal(
      new Set(steps.map((s) => s.machineId)).size,
      1,
      'everything ran in the one builder box',
    );
  });

  it('runs nothing and saves nothing when the guard refuses the builder box, and still gives the box back', async () => {
    const t = setup({
      guard: async () => {
        throw new Error('egress guard refused');
      },
    });
    await assert.rejects(t.snapshots.ensure(recipe()), /egress guard refused/);
    assert.deepEqual(t.fleet.execRequests, []);
    assert.equal(t.fleet.snapshots.size, 0);
    assert.equal(t.log.released, 1);
  });

  it('a snapshot of the same setup is reused without leasing a box or running anything', async () => {
    const t = setup();
    const first = await t.snapshots.ensure(recipe());
    const again = await t.snapshots.ensure(recipe({ ref: 'c'.repeat(40) }));
    assert.equal(again.snapshotId, first.snapshotId);
    assert.equal(again.built, false);
    assert.equal(t.log.leased.length, 1);
  });

  it('builds again for a changed setup, and another invite builds its own', async () => {
    const t = setup();
    const first = await t.snapshots.ensure(recipe());
    const changed = await t.snapshots.ensure(recipe({ setupScript: `${SCRIPT}npm run build\n` }));
    const other = await t.snapshots.ensure(recipe({ tenantId: B }));
    assert.equal(new Set([first.snapshotId, changed.snapshotId, other.snapshotId]).size, 3);
    assert.equal(t.log.leased.length, 3);
    assert.deepEqual(
      t.log.leased.map((l) => l.tenantId),
      [A, A, B],
    );
  });

  it('invites whose ids share the first 8 hex digits of their digest still get their own snapshots', async () => {
    // Found by search: the old 32-bit prefix of sha256(invite) is the same for these two.
    const sha8 = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 8);
    const C = 'inv_00000000dc0a';
    const D = 'inv_000000021089';
    assert.equal(sha8(C), sha8(D), 'the premise: the short prefixes collide');
    const t = setup({ keep: 1 });
    const hash = setupHash(recipe());
    assert.notEqual(snapshotName(C, REPO, hash), snapshotName(D, REPO, hash));
    const first = await t.snapshots.ensure(recipe({ tenantId: C }));
    const second = await t.snapshots.ensure(recipe({ tenantId: D }));
    assert.notEqual(
      second.snapshotId,
      first.snapshotId,
      'D builds its own, it does not boot from C’s disk',
    );
    assert.equal(second.built, true);
    assert.equal(second.tenantId, D);
    // D's expiry never deletes C's snapshot, even with keep = 1 and the same repository.
    await t.snapshots.ensure(recipe({ tenantId: D, setupScript: `${SCRIPT}# v2\n` }));
    assert.ok(t.fleet.snapshots.has(first.snapshotId), 'C’s snapshot is untouched');
  });

  it('refuses a snapshot of this name whose description says it belongs to something else, and deletes nothing', async () => {
    const t = setup();
    const built = await t.snapshots.ensure(recipe());
    const stored = t.fleet.snapshots.get(built.snapshotId);
    assert.ok(stored);
    stored.description = 'maka-setup v1 invite=someone-else repo=x setup=y';
    await assert.rejects(t.snapshots.ensure(recipe()), SnapshotOwnerError);
    assert.ok(t.fleet.snapshots.has(built.snapshotId));
    assert.equal(t.fleet.callsTo('deleteSnapshot').length, 0);
    assert.equal(t.log.leased.length, 1, 'nothing was built over it');
  });

  it('two callers in one process for the same setup share one build', async () => {
    const t = setup();
    const [one, two] = await Promise.all([
      t.snapshots.ensure(recipe()),
      t.snapshots.ensure(recipe()),
    ]);
    assert.equal(one.snapshotId, two.snapshotId);
    assert.equal(t.log.leased.length, 1);
    assert.equal(t.fleet.snapshots.size, 1);
  });

  it('two builders in different processes end with one snapshot, and the loser uses the winner’s', async () => {
    const t = setup();
    const other = t.make();
    const slow = t.fleet.hold('createSnapshot');
    const first = t.snapshots.ensure(recipe());
    await slow.reached; // the first builder has finished its setup and is about to save
    const second = await other.ensure(recipe()); // saves at once
    slow.release();
    const loser = await first;
    assert.equal(loser.snapshotId, second.snapshotId);
    assert.equal(t.fleet.snapshots.size, 1);
    assert.equal(t.log.leased.length, 2, 'both built');
    assert.equal(t.log.released, 2, 'both gave their box back');
    assert.equal(loser.built, false, 'the loser did not make the snapshot it uses');
  });

  it('waits for a snapshot another builder is still uploading instead of building', async () => {
    const t = setup();
    const name = snapshotName(A, REPO, setupHash(recipe()));
    const source = t.fleet.seed({ name: 'someone' });
    await t.fleet.createSnapshot(source.id, { name });
    const result = await t.snapshots.ensure(recipe());
    assert.equal(result.built, false);
    assert.equal(t.fleet.snapshots.get(result.snapshotId)?.status, 'ready');
    assert.equal(t.log.leased.length, 0);
  });

  it('deletes a failed snapshot of the same name and builds again', async () => {
    const t = setup();
    const name = snapshotName(A, REPO, setupHash(recipe()));
    const source = t.fleet.seed({ name: 'someone' });
    const failed = await t.fleet.createSnapshot(source.id, { name });
    const entry = t.fleet.snapshots.get(failed.id);
    if (entry) entry.status = 'failed';
    const result = await t.snapshots.ensure(recipe());
    assert.equal(result.built, true);
    assert.equal(t.fleet.snapshots.has(failed.id), false);
  });

  describe('a failure in the box', () => {
    it('names the step and the end of the output, saves nothing, and gives the box back', async () => {
      const t = setup();
      t.fleet.execHandler = (_id, request) =>
        request.envs?.MAKA_SETUP_HASH !== undefined
          ? { exitCode: 2, stderr: 'npm ERR! missing script: build' }
          : {};
      await assert.rejects(t.snapshots.ensure(recipe()), (error: unknown) => {
        assert.ok(error instanceof SetupFailedError);
        assert.equal(error.step, '.agents/setup');
        assert.match(error.message, /exit 2.*missing script: build/s);
        return true;
      });
      assert.equal(t.fleet.snapshots.size, 0);
      assert.equal(t.log.released, 1);
    });

    it('reports a step that timed out', async () => {
      const t = setup();
      t.fleet.execHandler = (_id, request) =>
        request.envs?.MAKA_SETUP_HASH !== undefined ? { timedOut: true, exitCode: 124 } : {};
      await assert.rejects(t.snapshots.ensure(recipe()), /took longer than 1200 s/);
      assert.equal(t.fleet.snapshots.size, 0);
    });

    it('does not save a snapshot of a prepare step that failed, and does not run the setup after it', async () => {
      const t = setup();
      t.fleet.execHandler = (_id, request) =>
        request.cmd.startsWith('echo install') ? { exitCode: 1 } : {};
      await assert.rejects(t.snapshots.ensure(recipe()), /prepare step 1/);
      assert.ok(t.fleet.execRequests.every((r) => r.envs.MAKA_SETUP_HASH === undefined));
    });

    it('gives the box back when the box cannot be leased at all', async () => {
      const fleet = new FakeFleet();
      const snapshots = new SetupSnapshots({
        api: fleet,
        boxes: {
          lease: async () => {
            throw new Error('no box free');
          },
        },
        guard: async () => undefined,
      });
      await assert.rejects(snapshots.ensure(recipe()), /no box free/);
      assert.equal(fleet.snapshots.size, 0);
    });

    it('when saving fails for a reason other than the name being taken, says so and gives the box back', async () => {
      const t = setup();
      t.fleet.createSnapshot = async () => {
        throw new Error('instabox is down');
      };
      await assert.rejects(t.snapshots.ensure(recipe()), /instabox is down/);
      assert.equal(t.log.released, 1);
    });
  });

  it('keeps the newest two snapshots of a repository for an invite and touches no other', async () => {
    const t = setup({ keep: 2 });
    const stranger = t.fleet.seed({ name: 'x' });
    await t.fleet.createSnapshot(stranger.id, { name: 'not-ours-123' });
    const otherInvite = await t.snapshots.ensure(recipe({ tenantId: B }));
    const otherRepo = await t.snapshots.ensure(
      recipe({ repoUrl: 'https://github.com/example/other.git' }),
    );
    const ids: string[] = [];
    for (const step of ['one', 'two', 'three']) {
      ids.push(
        (await t.snapshots.ensure(recipe({ setupScript: `${SCRIPT}# ${step}\n` }))).snapshotId,
      );
    }
    const left = new Set([...t.fleet.snapshots.values()].map((s) => s.id));
    assert.equal(left.has(ids[0] as string), false, 'the oldest of the three is gone');
    assert.equal(left.has(ids[1] as string), true);
    assert.equal(left.has(ids[2] as string), true);
    assert.equal(left.has(otherInvite.snapshotId), true);
    assert.equal(left.has(otherRepo.snapshotId), true);
    assert.ok([...t.fleet.snapshots.values()].some((s) => s.name === 'not-ours-123'));
  });

  it('refuses a repository URL with credentials or without https, and a ref that is not a full sha', async () => {
    const t = setup();
    for (const repoUrl of [
      'http://github.com/example/app.git',
      'https://user:secret@github.com/example/app.git',
      'https://token@github.com/example/app.git',
      'git@github.com:example/app.git',
      'https://github.com/example/app.git --upload-pack=x',
    ]) {
      await assert.rejects(t.snapshots.ensure(recipe({ repoUrl })), /repository URL/);
    }
    await assert.rejects(t.snapshots.ensure(recipe({ ref: 'main' })), /full commit sha/);
    assert.equal(t.log.leased.length, 0);
  });
});
