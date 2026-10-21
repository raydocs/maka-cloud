import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { EGRESS_BLOCKED_V4, EGRESS_CHAIN, InstaboxApiError } from '@maka-cloud/instabox';
import { collect, setup, terminal } from './harness.js';

const MUTATING = /(^| )(-N|-F|-A|-I|-D|-X) /u;
const mutations = (calls: string[]) => calls.filter((call) => MUTATING.test(call));

test('the box is closed and read back before the CLI starts', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_eg_ok')));
  assert.equal(terminal(events)?.type, 'finished');
  const rules = h.fake.firewall.rules('iptables', EGRESS_CHAIN).join('\n');
  for (const net of EGRESS_BLOCKED_V4) assert.match(rules, new RegExp(`-d ${net} -j REJECT`, 'u'));
  assert.equal(await h.cliCalls('claude'), 1);
});

test('a box that cannot be closed is refused: the CLI never starts', async (t) => {
  const h = await setup({ fake: { env: { SHIM_FAIL: '169\\.254\\.0\\.0/16' } } });
  t.after(() => h.cleanup());
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_eg_fail')));
  const end = terminal(events);
  assert.equal(end?.type, 'failed');
  assert.match(end?.type === 'failed' ? end.reason : '', /egress guard/u);
  assert.equal(await h.cliCalls('claude'), 0);
});

test('a box whose rules do not read back is refused', async (t) => {
  const h = await setup({ fake: { env: { SHIM_LIE: '1' } } });
  t.after(() => h.cleanup());
  const end = terminal(await collect(await h.runners.claude.start(await h.spec('tsk_eg_lie'))));
  assert.equal(end?.type, 'failed');
  assert.equal(await h.cliCalls('claude'), 0);
});

test('the CLI install is refused too, before any package script runs', async (t) => {
  const h = await setup({
    installClis: false,
    fake: { env: { SHIM_FAIL: '127\\.0\\.0\\.0/8' } },
    cloud: { installCommands: { 'claude-agent-sdk': 'touch "$HOME/install-ran"' } },
  });
  t.after(() => h.cleanup());
  const end = terminal(await collect(await h.runners.claude.start(await h.spec('tsk_eg_inst'))));
  assert.equal(end?.type, 'failed');
  assert.equal(existsSync(`${h.home}/install-ran`), false, 'the install command did not run');
});

test('every launch checks again, and rules that are already right are left alone', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const first = await collect(await h.runners.claude.start(await h.spec('tsk_eg_a')));
  assert.equal(terminal(first)?.type, 'finished');
  const afterFirst = h.fake.firewall.calls().length;
  const mutated = mutations(h.fake.firewall.calls()).length;
  assert.ok(mutated > 0);

  const second = await collect(await h.runners.claude.start(await h.spec('tsk_eg_b')));
  assert.equal(terminal(second)?.type, 'finished');
  assert.ok(h.fake.firewall.calls().length > afterFirst, 'the second launch read the rules back');
  assert.equal(mutations(h.fake.firewall.calls()).length, mutated, 'and changed nothing');
});

test('rules that were lost (a restored or resumed box) are put back before the next launch', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await collect(await h.runners.claude.start(await h.spec('tsk_eg_lost_a')));
  h.fake.firewall.reset();
  assert.equal(h.fake.firewall.rules('iptables', EGRESS_CHAIN).length, 0);
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_eg_lost_b')));
  assert.equal(terminal(events)?.type, 'finished');
  assert.ok(h.fake.firewall.rules('iptables', EGRESS_CHAIN).length > 0);
});

test('a box that is asleep is woken and checked again, and a failing guard refuses it', async (t) => {
  let calls = 0;
  const h = await setup({
    cloud: {
      egressGuard: async () => {
        calls += 1;
        if (calls === 1) {
          throw new InstaboxApiError(409, {
            code: 'machine_not_running',
            message: 'asleep',
            retryable: false,
          });
        }
      },
    },
  });
  t.after(() => h.cleanup());
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_eg_wake')));
  assert.equal(terminal(events)?.type, 'finished');
  assert.equal(calls, 2, 'checked again after waking');

  const refused = await setup({
    cloud: {
      egressGuard: async () => {
        throw new Error('no firewall here');
      },
    },
  });
  t.after(() => refused.cleanup());
  const end = terminal(
    await collect(await refused.runners.claude.start(await refused.spec('tsk_eg_no'))),
  );
  assert.equal(end?.type, 'failed');
  assert.equal(await refused.cliCalls('claude'), 0);
});
