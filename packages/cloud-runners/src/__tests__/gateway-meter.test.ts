import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunnerEvent } from '@maka-cloud/orchestrator';
import { InstaboxClient } from '@maka-cloud/instabox';
import { createCloudRunners, FixedMachineProvider } from '../index.js';
import type { ModelAccessProvider } from '../types.js';
import { collect, deferred, reader, settles, setup, terminal } from './harness.js';

const TOKEN = 'mkg_test_task_token_abcdefghijkl';

/** A stand-in for the model gateway's access: the test decides what it settled and when. */
function gatewayAccess(options: { searchUrl?: string } = {}) {
  type State = { spentUsd: number; exhausted: boolean };
  const listeners = new Set<(state: State) => void>();
  const issued: unknown[] = [];
  const counts = { revoked: 0, unsubscribed: 0 };
  let spent = 0;
  /** What the revoke does before it resolves, as the gateway's does while requests settle. */
  const hooks: { onRevoke?: () => Promise<void> } = {};
  const provider: ModelAccessProvider = {
    async issue(input) {
      issued.push(input);
      return {
        apiKey: TOKEN,
        baseUrl: 'https://gateway.test/openai/v1',
        ...(options.searchUrl ? { searchUrl: options.searchUrl } : {}),
        revoke: async () => {
          counts.revoked++;
          await hooks.onRevoke?.();
        },
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
    hooks,
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
  assert.doesNotMatch(call.env, /MAKA_SEARCH_/u, 'no search without a search URL');
});

test('an access with web search gives the run its URL, called with the task token', async (t) => {
  const access = gatewayAccess({ searchUrl: 'https://gateway.test/search' });
  const h = await setup({ cloud: { modelAccess: access.provider } });
  t.after(() => h.cleanup());
  await h.setMode('spend');
  const handle = await h.runners.codex.start(
    await h.spec('tsk_gateway_search', { runner: 'codex', budgetUsd: 5 }),
  );
  assert.equal(terminal(await reader(handle).rest())?.type, 'finished');
  const call = await h.cliCall('codex', 1);
  assert.match(call.env, /MAKA_SEARCH_URL=https:\/\/gateway\.test\/search/u);
  assert.match(call.env, new RegExp(`MAKA_SEARCH_TOKEN=${TOKEN}`, 'u'));
});

test('what settles while the access is revoked is reported before the run ends', async (t) => {
  const access = gatewayAccess();
  const h = await setup({ cloud: { modelAccess: access.provider } });
  t.after(() => h.cleanup());
  await h.setMode('spend');
  const revoking = deferred();
  const inFlight = deferred();
  access.hooks.onRevoke = async () => {
    revoking.resolve();
    // A request still streaming when the CLI exited settles during the revoke.
    await inFlight.promise;
    access.settle({ spentUsd: 0.3, exhausted: false });
  };
  const handle = await h.runners.claude.start(await h.spec('tsk_settle_end', { budgetUsd: 5 }));
  const events = reader(handle);
  await events.until((event) => event.type === 'progress');
  access.settle({ spentUsd: 0.05, exhausted: false });
  await revoking.promise;
  inFlight.resolve();
  const all = await events.rest();
  assert.deepEqual(
    all.filter((event) => event.type === 'usage' || event.type === 'finished'),
    [{ type: 'usage', costUsd: 0.05 }, { type: 'usage', costUsd: 0.3 }, { type: 'finished' }],
    'the final spend comes before the end',
  );
  assert.equal(access.counts.unsubscribed, 1);
  assert.equal(access.listening(), false);
});

test('a cancelled run still reports what settled while its access was revoked', async (t) => {
  const access = gatewayAccess();
  const h = await setup({ cloud: { modelAccess: access.provider } });
  t.after(() => h.cleanup());
  await h.setMode('hang');
  access.hooks.onRevoke = async () => access.settle({ spentUsd: 0.4, exhausted: false });
  const handle = await h.runners.codex.start(
    await h.spec('tsk_settle_cancel', { runner: 'codex', budgetUsd: 5 }),
  );
  const events = reader(handle);
  await events.until((event) => event.type === 'progress' && event.note.includes('working on it'));
  access.settle({ spentUsd: 0.1, exhausted: false });
  await events.until((event) => event.type === 'usage');
  await handle.cancel();
  const all = await events.rest();
  assert.equal(terminal(all), undefined, 'a cancelled run reports no end of its own');
  assert.deepEqual(costs(all), [0.1, 0.4]);
  assert.equal(access.counts.revoked, 1);
  assert.equal(access.counts.unsubscribed, 1);
});

test('a cancel while the end’s revoke is settling waits for it: the final cost is not dropped', async (t) => {
  const access = gatewayAccess();
  const released = deferred();
  const h = await setup({
    cloud: {
      modelAccess: access.provider,
      // Tells the test when the cancel's cleanup has given the sandbox back.
      sandboxes: {
        acquire: async () => ({ machineId: h.fake.machineId, release: () => released.resolve() }),
        knownMachines: () => [h.fake.machineId],
      },
    },
  });
  t.after(() => h.cleanup());
  await h.setMode('spend');
  const revoking = deferred();
  const inFlight = deferred();
  access.hooks.onRevoke = async () => {
    revoking.resolve();
    await inFlight.promise;
    access.settle({ spentUsd: 0.4, exhausted: false });
  };
  const handle = await h.runners.claude.start(await h.spec('tsk_end_cancel', { budgetUsd: 5 }));
  const events = reader(handle);
  await revoking.promise;
  // The run's own end is revoking; a cancel arrives and asks for the same release.
  const cancelled = handle.cancel();
  await released.promise;
  // What is left of the cancel's cleanup runs in this turn of the event loop.
  await new Promise((resolve) => setImmediate(resolve));
  inFlight.resolve();
  await cancelled;
  const all = await events.rest();
  assert.deepEqual(costs(all).at(-1), 0.4, 'the cost settled during the revoke is reported');
  assert.equal(access.counts.revoked, 1);
  assert.equal(access.counts.unsubscribed, 1);
});

test('a revoke past the cleanup time limit is still waited for before the stream closes', async (t) => {
  const access = gatewayAccess();
  const timedOut = deferred();
  const h = await setup({
    cloud: {
      modelAccess: access.provider,
      cleanupTimeoutMs: 1,
      onCleanupError: ({ step }) => {
        if (step === 'revoke model access') timedOut.resolve();
      },
    },
  });
  t.after(() => h.cleanup());
  await h.setMode('spend');
  access.hooks.onRevoke = async () => {
    // Settles only once its step has given up on it, and the run has moved on if it does not wait.
    await timedOut.promise;
    await new Promise((resolve) => setImmediate(resolve));
    access.settle({ spentUsd: 0.4, exhausted: false });
  };
  const handle = await h.runners.claude.start(await h.spec('tsk_end_slow', { budgetUsd: 5 }));
  const all = await reader(handle).rest();
  assert.deepEqual(
    all.filter((event) => event.type === 'usage' || event.type === 'finished').slice(-2),
    [{ type: 'usage', costUsd: 0.4 }, { type: 'finished' }],
    'the final spend comes before the end',
  );
  assert.equal(access.counts.unsubscribed, 1);
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
