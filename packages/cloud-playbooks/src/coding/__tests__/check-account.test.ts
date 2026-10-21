import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { collect, fixes, setup, terminal } from './harness.js';

test('the repository tests run as the agent account, and so does the stop that ends them', async (t) => {
  const h = await setup(t);
  h.claude.script = fixes;
  const spec = await h.spec('tsk_check_acct');
  const events = await collect(await h.runner.start(spec));
  assert.deepEqual(terminal(events), { type: 'finished' });
  const users = await h.sudoUsers();
  // Each check is one run as the account (the stop after it runs as root, which has no `-u`).
  assert.ok(users.length >= 2, `${users.length} runs as the agent`);
  assert.ok(users.every((user) => user === 'maka-agent'));
});

test('with no agent account no repository test command runs', async (t) => {
  const h = await setup(t, {}, { noAgentChannel: true });
  h.claude.script = fixes;
  const marker = join(h.root, 'test-ran');
  const spec = await h.spec('tsk_check_nochan', {
    testCommand: `touch ${marker}; bash tests/run.sh`,
  });
  const end = terminal(await collect(await h.runner.start(spec)));
  assert.equal(end?.type, 'failed');
  assert.match(end?.type === 'failed' ? end.reason : '', /agent account/u);
  assert.equal(existsSync(marker), false);
});
