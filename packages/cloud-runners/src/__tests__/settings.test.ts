import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collect, setup, terminal } from './harness.js';
import { claudeAdapter, codexAdapter, runSettingsProblem } from '../vendors.js';

test("a run's model and effort reach the Claude CLI, and beat the fleet default", async (t) => {
  const h = await setup({ cloud: { models: { 'claude-agent-sdk': 'fleet-model' } } });
  t.after(() => h.cleanup());
  const own = await h.spec('tsk_set_claude', { model: 'run-model-1', effort: 'high' });
  assert.equal(terminal(await collect(await h.runners.claude.start(own)))?.type, 'finished');
  const { argv } = await h.cliCall('claude', 1);
  assert.equal(argv[argv.indexOf('--model') + 1], 'run-model-1');
  assert.equal(argv[argv.indexOf('--effort') + 1], 'high');

  // A run that names nothing gets the fleet's model and no effort flag.
  const plain = await h.spec('tsk_set_claude2');
  assert.equal(terminal(await collect(await h.runners.claude.start(plain)))?.type, 'finished');
  const second = await h.cliCall('claude', 2);
  assert.equal(second.argv[second.argv.indexOf('--model') + 1], 'fleet-model');
  assert.ok(!second.argv.includes('--effort'));
});

test("a run's model and effort reach the Codex CLI as config overrides", async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const spec = await h.spec('tsk_set_codex', {
    runner: 'codex',
    model: 'gpt-run',
    effort: 'xhigh',
  });
  assert.equal(terminal(await collect(await h.runners.codex.start(spec)))?.type, 'finished');
  const { argv } = await h.cliCall('codex', 1);
  const configs = argv.flatMap((arg, i) => (argv[i - 1] === '-c' ? [arg] : []));
  assert.ok(configs.includes('model="gpt-run"'));
  assert.ok(configs.includes('model_reasoning_effort="xhigh"'));
});

test('a model or effort that is not plain fails the run before a key, a sandbox or a CLI is touched', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const bad = [
    { model: 'x; rm -rf /' },
    { model: '$(touch /tmp/x)' },
    { model: '--flag' },
    { model: '' },
    { effort: 'maximum' },
    { effort: 'high; id' },
    { effort: '' },
  ];
  for (const [i, settings] of bad.entries()) {
    const spec = await h.spec(`tsk_set_bad${i}`, settings);
    const events = await collect(await h.runners.claude.start(spec));
    const end = terminal(events);
    assert.equal(end?.type, 'failed', JSON.stringify(settings));
  }
  assert.equal(await h.cliCalls('claude'), 0);
  assert.deepEqual(h.revoked, [], 'no model access was issued for a run that was refused');
  assert.equal(await h.sessions.get('tsk_set_bad0'), undefined);
  assert.equal(h.fake.leases.size, 0);
});

test('the settings check accepts exactly the plain model ids and the four levels', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh']) {
    assert.equal(runSettingsProblem({ effort }), undefined);
  }
  assert.equal(runSettingsProblem({ model: 'claude-opus-5-5' }), undefined);
  assert.equal(runSettingsProblem({ model: 'gpt-x.1:mini' }), undefined);
  assert.equal(runSettingsProblem({}), undefined);
  assert.match(runSettingsProblem({ effort: 'max' }) ?? '', /effort/);
  assert.match(runSettingsProblem({ model: 'a b' }) ?? '', /model/);
});

test('both adapters pass the settings as they are and leave them out when absent', () => {
  assert.ok(!claudeAdapter.argv({ prompt: 'x' }).includes('--effort'));
  assert.ok(
    !codexAdapter.argv({ prompt: 'x' }).some((word) => word.includes('model_reasoning_effort')),
  );
  assert.deepEqual(claudeAdapter.argv({ prompt: 'x', effort: 'low' }).slice(-2), [
    '--effort',
    'low',
  ]);
  assert.ok(
    codexAdapter.argv({ prompt: 'x', effort: 'low' }).includes('model_reasoning_effort="low"'),
  );
});
