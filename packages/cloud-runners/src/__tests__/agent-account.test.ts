import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collect, setup, terminal } from './harness.js';

const reasonOf = (events: Parameters<typeof terminal>[0]): string => {
  const end = terminal(events);
  assert.equal(end?.type, 'failed');
  return end?.type === 'failed' ? end.reason : '';
};

test('a Codex run is started as the agent account, never as the sandbox user', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const spec = await h.spec('tsk_codex_acct', { runner: 'codex' });
  const end = terminal(await collect(await h.runners.codex.start(spec)));
  assert.equal(end?.type, 'finished');
  assert.equal(await h.cliCalls('codex'), 1);
  assert.deepEqual(await h.sudoUsers(), ['maka-agent']);
});

test('without an agent account Codex runs nothing, as the SDK path does not', async (t) => {
  const h = await setup({ noAgentChannel: true });
  t.after(() => h.cleanup());
  const spec = await h.spec('tsk_codex_nochan', { runner: 'codex' });
  const reason = reasonOf(await collect(await h.runners.codex.start(spec)));
  assert.match(reason, /needs an agent channel/u);
  assert.equal(await h.cliCalls('codex'), 0);
});

test('a box that fails the isolation check is refused before Codex starts', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  h.runners.fleet.ensureAgentIsolation = async () => {
    throw new Error('the sandbox does not keep the agent channel private: the agent can use sudo');
  };
  const spec = await h.spec('tsk_codex_open', { runner: 'codex' });
  const reason = reasonOf(await collect(await h.runners.codex.start(spec)));
  assert.match(reason, /can use sudo/u);
  assert.equal(await h.cliCalls('codex'), 0);
});

test('a resumed Codex turn runs as the agent account too', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('noresult');
  const spec = await h.spec('tsk_codex_repair', { runner: 'codex' });
  await collect(await h.runners.codex.start(spec));
  // The first turn wrote no result; the repair turn is a second CLI call.
  assert.equal(await h.cliCalls('codex'), 2);
  assert.deepEqual(await h.sudoUsers(), ['maka-agent', 'maka-agent']);
});
