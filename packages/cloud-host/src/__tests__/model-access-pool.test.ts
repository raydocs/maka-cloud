import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Gateway, IssueInput } from '@maka-cloud/gateway';
import { gatewayModelAccess } from '../gateway.js';

/** Only what `gatewayModelAccess` calls: it records what each grant was issued with. */
function recording() {
  const issued: IssueInput[] = [];
  const gateway = {
    canSearch: false,
    issue(input: IssueInput) {
      issued.push(input);
      return {
        token: 'mkg_test_token',
        revoke: () => undefined,
        spend: () => ({ spentUsd: 0 }),
        onSpend: () => () => undefined,
      };
    },
    revokeForTask: () => undefined,
  } as unknown as Gateway;
  const access = gatewayModelAccess(gateway, 'https://gateway.test', () => ({
    inviteId: 'inv_pool',
  }));
  return { access, issued };
}

test('a phase’s grant is limited to the phase and pooled with the whole budget of its tree', async () => {
  const { access, issued } = recording();
  await access.issue({
    taskId: 'tsk_a',
    runner: 'claude-agent-sdk',
    budgetUsd: 8,
    budgetRootId: 'tsk_root',
    poolUsd: 10,
  });
  await access.issue({
    taskId: 'tsk_a',
    runner: 'codex',
    budgetUsd: 2,
    budgetRootId: 'tsk_root',
    poolUsd: 10,
  });
  assert.deepEqual(
    issued.map((input) => input.budget),
    [
      { limitUsd: 8, poolId: 'tsk_root', poolLimitUsd: 10 },
      { limitUsd: 2, poolId: 'tsk_root', poolLimitUsd: 10 },
    ],
  );
});

test('without a pool limit the pool is still the first grant’s own limit, and without a tree there is no pool', async () => {
  const { access, issued } = recording();
  await access.issue({
    taskId: 'tsk_b',
    runner: 'codex',
    budgetUsd: 3,
    budgetRootId: 'tsk_root',
  });
  await access.issue({ taskId: 'tsk_c', runner: 'codex', budgetUsd: 3 });
  // A pool limit with no tree to pool in is not passed on (the gateway would refuse it).
  await access.issue({ taskId: 'tsk_d', runner: 'codex', budgetUsd: 3, poolUsd: 10 });
  assert.deepEqual(
    issued.map((input) => input.budget),
    [{ limitUsd: 3, poolId: 'tsk_root' }, { limitUsd: 3 }, { limitUsd: 3 }],
  );
});
