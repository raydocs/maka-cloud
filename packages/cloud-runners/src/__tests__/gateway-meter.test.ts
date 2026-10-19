import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunnerEvent } from '@maka-cloud/orchestrator';
import { InstaboxClient } from '@maka-cloud/instabox';
import { createCloudRunners, FixedMachineProvider } from '../index.js';
import type { ModelAccessProvider } from '../types.js';
import { collect, reader, settles, setup, terminal } from './harness.js';

const TOKEN = 'mkg_test_task_token_abcdefghijkl';

/** A stand-in for the model gateway's access: the test decides what it settled and when. */
function gatewayAccess() {
  type State = { spentUsd: number; exhausted: boolean };
  const listeners = new Set<(state: State) => void>();
  const issued: unknown[] = [];
  const counts = { revoked: 0, unsubscribed: 0 };
  let spent = 0;
  const provider: ModelAccessProvider = {
    async issue(input) {
      issued.push(input);
      return {
        apiKey: TOKEN,
        baseUrl: 'https://gateway.test/openai/v1',
        revoke: () => void counts.revoked++,
        meter: {
          spentUsd: () => spent,
          subscribe: (listener) => {
            listeners.add(listener);
            return () => {
              counts.unsubscribed++;
              listeners.delete(listener);
            };
          },
        },
      };
    },
  };
  return {
    provider,
    issued,
    counts,
    listening: () => listeners.size > 0,
    settle(state: State) {
      spent = state.spentUsd;
      for (const listener of [...listeners]) listener(state);
    },
  };
}

function costs(events: RunnerEvent[]): number[] {
  return events.flatMap((event) => (event.type === 'usage' ? [event.costUsd] : []));
}

test('a Codex run is metered per request and stopped inside its turn when the gateway refuses for budget', async (t) => {
  const access = gatewayAccess();
  const h = await setup({ cloud: { modelAccess: access.provider } });
  t.after(() => h.cleanup());
  // The CLI works and never reaches turn.completed, the only place Codex prints its usage.
  await h.setMode('hang');
  const spec = await h.spec('tsk_gateway_cap', {
    runner: 'codex',
    budgetUsd: 0.25,
    budgetRootId: 'tsk_root',
  });
  const handle = await h.runners.codex.start(spec);
  const events = reader(handle);
  await events.until((event) => event.type === 'progress' && event.note.includes('working on it'));
  assert.deepEqual(access.issued, [
    { taskId: 'tsk_gateway_cap', runner: 'codex', budgetUsd: 0.25, budgetRootId: 'tsk_root' },
  ]);

  access.settle({ spentUsd: 0.12, exhausted: false });
  const usage = await events.until((event) => event.type === 'usage');
  assert.deepEqual(
    usage,
    { type: 'usage', costUsd: 0.12 },
    'spend arrives as each request settles',
  );

  access.settle({ spentUsd: 0.2, exhausted: true });
  const rest = await settles(events.rest());
  assert.notEqual(rest, 'stuck', 'the refusal stops the run without waiting for the turn to end');
  const end = terminal(events.seen);
  assert.equal(end?.type, 'failed');
  assert.match(
    end?.type === 'failed' ? end.reason : '',
    /budget of \$0\.25 reached \(\$0\.20 spent\)/u,
  );
  assert.deepEqual(costs(events.seen), [0.12, 0.2]);
  assert.equal(h.runners.fleet.openRuns, 0, 'the CLI was stopped and the run cleaned up');
  assert.equal(access.counts.revoked, 1);
  assert.equal(access.counts.unsubscribed, 1);
});

test('with a metered access the CLI’s own usage lines do not count', async (t) => {
  const access = gatewayAccess();
  const h = await setup({ cloud: { modelAccess: access.provider } });
  t.after(() => h.cleanup());
  await h.setMode('spend');
  const handle = await h.runners.claude.start(await h.spec('tsk_gateway_spend', { budgetUsd: 5 }));
  const events = reader(handle);
  await events.until((event) => event.type === 'progress');
  access.settle({ spentUsd: 0.05, exhausted: false });
  const all = await events.rest();
  assert.equal(terminal(all)?.type, 'finished');
  // The fake CLI prints $0.20, $0.40 and a $0.50 total; the gateway settled $0.05.
  assert.deepEqual(costs(all), [0.05]);
  const call = await h.cliCall('claude', 1);
  assert.match(
    call.env,
    new RegExp(`ANTHROPIC_API_KEY=${TOKEN}`, 'u'),
    'the sandbox gets the task token',
  );
});

test('a fleet built without a model access gives no run a key', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const bare = createCloudRunners({
    client: new InstaboxClient({
      apiKey: h.fake.apiKey,
      baseUrl: h.fake.url,
      sleep: async () => {},
      random: () => 0,
    }),
    sandboxes: new FixedMachineProvider(h.fake.machineId),
    workRoot: h.root,
    logRoot: h.logRoot,
  });
  const saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY };
  process.env.ANTHROPIC_API_KEY = 'sk-ambient-master-key';
  t.after(() => {
    if (saved.a === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.a;
  });
  const events = await collect(await bare.claude.start(await h.spec('tsk_no_access')));
  const end = terminal(events);
  assert.equal(end?.type, 'failed');
  assert.match(end?.type === 'failed' ? end.reason : '', /No model gateway is configured/u);
  assert.equal(await h.cliCalls('claude'), 0, 'no CLI started');
});
