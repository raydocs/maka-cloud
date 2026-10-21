import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Gateway, IssueInput } from '@maka-cloud/gateway';
import { gatewayModelAccess } from '../gateway.js';

/** A gateway that only records what it was asked to issue. */
function recording() {
  const issued: IssueInput[] = [];
  const gateway = {
    canSearch: false,
    issue(input: IssueInput) {
      issued.push(input);
      return {
        token: 'mkg_x',
        revoke: async () => undefined,
        spend: () => ({ spentUsd: 0 }),
        onSpend: () => () => undefined,
      };
    },
  } as unknown as Gateway;
  const access = gatewayModelAccess(gateway, 'http://gateway.test', () => ({
    inviteId: 'inv_000000000001',
  }));
  return { issued, access };
}

const ask = { taskId: 'tsk_a', runner: 'claude-agent-sdk', budgetUsd: 4, budgetRootId: 'tsk_root' };

test('a run with no turn limit is held to what its tree has left, in the tree’s pool', async () => {
  const { issued, access } = recording();
  await access.issue(ask);
  assert.deepEqual(issued[0]?.budget, { limitUsd: 4, poolId: 'tsk_root' });
});

test('a run whose turn limit is lower gets its own limit inside the pool of the whole tree budget', async () => {
  const { issued, access } = recording();
  await access.issue({ ...ask, turnBudgetUsd: 1.5 });
  assert.deepEqual(issued[0]?.budget, { limitUsd: 1.5, poolId: 'tsk_root', poolLimitUsd: 4 });
});

test('a turn limit above what the tree has left changes nothing, and one with no pool is the smaller limit', async () => {
  const { issued, access } = recording();
  await access.issue({ ...ask, turnBudgetUsd: 10 });
  assert.deepEqual(issued[0]?.budget, { limitUsd: 4, poolId: 'tsk_root' });
  await access.issue({
    taskId: 'tsk_b',
    runner: 'claude-agent-sdk',
    budgetUsd: 4,
    turnBudgetUsd: 1,
  });
  assert.deepEqual(issued[1]?.budget, { limitUsd: 1 });
});
