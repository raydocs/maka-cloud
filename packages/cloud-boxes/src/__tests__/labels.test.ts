import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boxLabels, boxName, checkBox, LABEL } from '../labels.js';

const limits = { maxPerInvite: 3 };
const machine = (name: string, metadata: Record<string, string>) => ({
  id: 'm_1',
  name,
  state: 'running' as const,
  metadata,
});

describe('box names and labels', () => {
  it('names are stable, differ by invite and slot, and are valid instabox names for any tenant id', () => {
    assert.equal(boxName('inv_aaaaaaaaaaaa', 0), boxName('inv_aaaaaaaaaaaa', 0));
    assert.notEqual(boxName('inv_aaaaaaaaaaaa', 0), boxName('inv_aaaaaaaaaaaa', 1));
    assert.notEqual(boxName('inv_aaaaaaaaaaaa', 0), boxName('inv_bbbbbbbbbbbb', 0));
    for (const tenant of ['default', 'inv_ABC/../x', 'ü'.repeat(300)]) {
      assert.match(boxName(tenant, 2), /^[a-z0-9][a-z0-9-]{0,62}$/);
    }
  });

  it('accepts a box only when pool label, invite, slot and name all agree', () => {
    const good = machine(boxName('t', 1), boxLabels('t', 1));
    assert.deepEqual(checkBox(good, limits, { tenantId: 't', slot: 1 }), {
      ok: true,
      tenantId: 't',
      slot: 1,
    });
    const refused = (m: ReturnType<typeof machine>, expect = {}) =>
      assert.equal(checkBox(m, limits, expect).ok, false);
    refused(machine(boxName('t', 1), { ...boxLabels('t', 1), [LABEL.pool]: '0' }));
    refused(machine(boxName('t', 1), { ...boxLabels('t', 1), [LABEL.slot]: '01x' }));
    refused(machine(boxName('t', 3), boxLabels('t', 3)));
    refused(machine(boxName('t', 1), boxLabels('t', 2)));
    refused(machine('mk-other-1', boxLabels('t', 1)));
    refused(good, { tenantId: 'someone-else' });
    refused(good, { slot: 0 });
  });

  it('reads the task and setup labels', () => {
    const m = machine(boxName('t', 0), {
      ...boxLabels('t', 0, { setup: 'abc' }),
      [LABEL.task]: 'task_1',
    });
    assert.deepEqual(checkBox(m, limits), {
      ok: true,
      tenantId: 't',
      slot: 0,
      taskId: 'task_1',
      setup: 'abc',
    });
  });
});
