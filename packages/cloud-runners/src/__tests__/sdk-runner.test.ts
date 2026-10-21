import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { StepLog, StepIntentResult } from '@maka-cloud/orchestrator';
import { loadAgentSdk } from '../sdk-turn.js';
import { SDK_CLI } from './fake-sdk-cli.js';
import { sdkSetup } from './sdk-harness.js';
import {
  API_KEY,
  collect,
  deferred,
  exists,
  type Harness,
  MCP_TOKEN,
  notes,
  reader,
  setup,
  settles,
  terminal,
  until,
} from './harness.js';

const fakeFile = (h: Harness, name: string) => join(h.home, 'fake-cli', name);

async function lines(path: string): Promise<string[]> {
  return (await fs.readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean);
}

function assertClean(h: Harness): void {
  assert.equal(h.runners.fleet.openRuns, 0, 'run still open');
  assert.equal(h.runners.fleet.poller.watchCount(), 0, 'poll watch left behind');
  assert.equal(h.runners.fleet.leaseRenewals, 0, 'lease renewal timer still running');
  assert.equal(h.fake.leases.size, 0, 'activity lease left behind');
}

interface Recorder extends StepLog {
  calls: string[];
  /** Answers `intent` for a step id; the default records it. */
  answer: Map<string, () => Promise<StepIntentResult>>;
}

function recorder(): Recorder {
  const calls: string[] = [];
  const answer = new Map<string, () => Promise<StepIntentResult>>();
  return {
    calls,
    answer,
    async intent(step) {
      calls.push(`intent ${step.stepId} ${step.replay} ${step.kind} ${JSON.stringify(step.label)}`);
      return (await answer.get(step.stepId)?.()) ?? { status: 'recorded' };
    },
    async outcome(stepId, result) {
      calls.push(`outcome ${stepId} ${result.status}${result.output ? ` ${result.output}` : ''}`);
      return 'recorded';
    },
  };
}

async function tools(h: Harness, list: unknown[]): Promise<void> {
  await h.setMode('tools');
  await fs.writeFile(fakeFile(h, 'tools.json'), JSON.stringify(list));
}

test('the SDK runs the sandbox CLI with the flags of the CLI path, an explicit environment, and the task finishes', async (t) => {
  const h = await sdkSetup(t);
  process.env.MAKA_TEST_HOST_SECRET = 'host-secret-xyz';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-host-token';
  t.after(() => {
    delete process.env.MAKA_TEST_HOST_SECRET;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });
  const spec = await h.spec('tsk_sdk_ok', {
    mcp: { url: 'http://127.0.0.1:4100/mcp', token: MCP_TOKEN },
    model: 'claude-test-model',
    effort: 'high',
  });
  const events = await collect(await h.runners.claude.start(spec));

  assert.equal(terminal(events)?.type, 'finished');
  assert.deepEqual(
    JSON.parse(await fs.readFile(spec.resultPath, 'utf8')).summary,
    'fake run complete',
  );
  assert.ok(notes(events).includes('working on it'));

  const { argv, env } = await h.cliCall('claude', 1);
  assert.ok(!argv.includes('-p'), 'the prompt is a message, not an argument');
  assert.ok(argv.includes('--verbose'));
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(argv[argv.indexOf('--input-format') + 1], 'stream-json');
  assert.ok(argv.includes('--model=claude-test-model'));
  assert.ok(argv.includes('--effort=high'));
  assert.ok(argv.includes('--permission-mode=bypassPermissions'));
  assert.ok(argv.includes('--setting-sources=project,local'));
  assert.ok(argv.includes('--strict-mcp-config'));
  const mcp = JSON.parse(argv[argv.indexOf('--mcp-config') + 1] ?? '{}');
  assert.equal(mcp.mcpServers.maka.url, 'http://orchestrator.internal:4100/mcp');
  assert.equal(mcp.mcpServers.maka.headers.Authorization, 'Bearer ${MAKA_MCP_TOKEN}');
  assert.ok(!argv.some((arg) => arg.includes(MCP_TOKEN)), 'the token is read from the environment');
  assert.ok(!argv.includes('--resume') && !argv.some((arg) => arg.startsWith('--resume=')));

  // Its environment is the run's own, plus the SDK's markers; nothing of the host's.
  assert.ok(env.includes(`ANTHROPIC_API_KEY=${API_KEY}`));
  assert.ok(env.includes(`MAKA_MCP_TOKEN=${MCP_TOKEN}`));
  assert.match(env, /CLAUDE_AGENT_SDK_VERSION=\d+\.\d+\.\d+/);
  assert.ok(!env.includes('host-secret-xyz'), 'a variable of the host reached the sandbox');
  assert.ok(!env.includes('oauth-host-token'), 'a login of the host reached the sandbox');

  // The first message and the SDK's setup went in through the input file, on the sandbox.
  const input = await fs.readFile(join(h.root, 'tsk_sdk_ok', 'chan', 't1.in'), 'utf8');
  assert.match(input, /"subtype":"initialize"/);
  assert.match(input, /Brief for tsk_sdk_ok|result\.json/);
  assert.ok(
    await exists(join(h.root, 'tsk_sdk_ok', 'chan', 't1.in.eof')),
    'the end of the input was sent',
  );
  assert.equal((await h.sessions.get('tsk_sdk_ok'))?.sessionId, 'sess-1');
  assert.equal(h.fake.requestsTo('GET', /\/files$/).length, 0);
  assertClean(h);
  assert.deepEqual(h.revoked, ['tsk_sdk_ok']);
});

test('on the host the SDK talks to nothing but the sandbox API', async (t) => {
  const h = await sdkSetup(t);
  const { Socket } = await import('node:net');
  const connect = Socket.prototype.connect;
  const targets: string[] = [];
  Socket.prototype.connect = function (this: unknown, ...args: unknown[]) {
    const first = args[0] as { host?: string; path?: string } | number | string | undefined;
    targets.push(
      typeof first === 'object' ? (first.host ?? first.path ?? '') : String(first ?? ''),
    );
    return (connect as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof Socket.prototype.connect;
  t.after(async () => {
    Socket.prototype.connect = connect;
  });
  const spec = await h.spec('tsk_sdk_net', {
    mcp: { url: 'http://127.0.0.1:4100/mcp', token: MCP_TOKEN },
  });
  assert.equal(terminal(await collect(await h.runners.claude.start(spec)))?.type, 'finished');
  assert.ok(targets.length > 0, 'the probe saw the calls to the sandbox API');
  for (const target of targets) {
    assert.match(target, /^(127\.0\.0\.1|localhost|::1|)$/u, `the host connected to ${target}`);
  }
});

test('before a tool runs its intent is on record, and after it the outcome is', async (t) => {
  const h = await sdkSetup(t);
  const steps = recorder();
  const gate = deferred();
  steps.answer.set('toolu_1', async () => {
    await gate.promise;
    return { status: 'recorded' };
  });
  await tools(h, [
    { id: 'toolu_1', name: 'Bash', input: { command: 'git push origin main' } },
    { id: 'toolu_2', name: 'Read', input: { file_path: '/work/a.txt' } },
    { id: 'toolu_3', name: 'Bash', input: { command: 'ls' }, fail: true },
  ]);
  const handle = await h.runners.claude.start(await h.spec('tsk_sdk_steps', { steps }));
  const done = collect(handle);

  // The CLI asked for the first step and waits for the answer: the tool has not run.
  await until(() => steps.calls.length >= 1);
  assert.match(
    steps.calls[0] ?? '',
    /^intent toolu_1 never tool:Bash "Bash: git push origin main"$/,
  );
  // Time enough for the CLI to have been answered and to have run the tool, counted in polls of
  // the sandbox rather than in milliseconds: if the hook did not wait for the intent, it would be
  // answered within a few of them.
  const polls = h.runners.fleet.poller.pollCount;
  await until(() => h.runners.fleet.poller.pollCount >= polls + 25);
  assert.equal(
    await exists(fakeFile(h, 'ran.log')),
    false,
    'the tool ran before its intent was recorded',
  );
  assert.equal(steps.calls.length, 1, 'the CLI went on to its next step');
  gate.resolve();

  assert.equal(terminal(await done)?.type, 'finished');
  assert.deepEqual(steps.calls, [
    'intent toolu_1 never tool:Bash "Bash: git push origin main"',
    'outcome toolu_1 done',
    'intent toolu_2 safe tool:Read "Read: /work/a.txt"',
    'outcome toolu_2 done',
    'intent toolu_3 safe tool:Bash "Bash: ls"',
    'outcome toolu_3 failed boom',
  ]);
  assert.deepEqual(await lines(fakeFile(h, 'ran.log')), ['toolu_1', 'toolu_2', 'toolu_3']);
  assertClean(h);
});

test('a step the log refuses does not run, and the task goes on', async (t) => {
  const h = await sdkSetup(t);
  const steps = recorder();
  steps.answer.set('toolu_1', async () => ({ status: 'refused', reason: 'the task is ending' }));
  steps.answer.set('toolu_2', async () => ({ status: 'interrupted' }));
  await tools(h, [
    { id: 'toolu_1', name: 'Bash', input: { command: 'make deploy' } },
    { id: 'toolu_2', name: 'Bash', input: { command: 'git push' } },
    { id: 'toolu_3', name: 'Read', input: { file_path: '/a' } },
  ]);
  const events = await collect(
    await h.runners.claude.start(await h.spec('tsk_sdk_refused', { steps })),
  );

  assert.equal(terminal(events)?.type, 'finished');
  assert.deepEqual(await lines(fakeFile(h, 'ran.log')), ['toolu_3']);
  const answers = (await lines(fakeFile(h, 'hooks.log'))).map((line) => JSON.parse(line));
  const first = answers.find((entry) => entry.id === 'toolu_1' && entry.event === 'PreToolUse');
  assert.equal(first.answer.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(first.answer.hookSpecificOutput.permissionDecisionReason, /the task is ending/);
  const second = answers.find((entry) => entry.id === 'toolu_2' && entry.event === 'PreToolUse');
  assert.match(second.answer.hookSpecificOutput.permissionDecisionReason, /cut off by a restart/);
  // A step that did not start has no outcome.
  assert.ok(
    !steps.calls.some(
      (call) => call.startsWith('outcome toolu_1') || call.startsWith('outcome toolu_2'),
    ),
  );
});

test('a step log that fails stops every step, repeatable or not', async (t) => {
  const h = await sdkSetup(t);
  const steps = recorder();
  steps.answer.set('toolu_1', async () => {
    throw new Error('database is locked');
  });
  steps.answer.set('toolu_2', async () => {
    throw new Error('database is locked');
  });
  await tools(h, [
    { id: 'toolu_1', name: 'Bash', input: { command: 'gh pr create' } },
    { id: 'toolu_2', name: 'Grep', input: { pattern: 'x' } },
  ]);
  const events = await collect(
    await h.runners.claude.start(await h.spec('tsk_sdk_logdown', { steps })),
  );

  assert.equal(terminal(events)?.type, 'finished');
  assert.deepEqual(await lines(fakeFile(h, 'ran.log')), []);
  assert.ok(
    notes(events).some((note) => /a step could not be recorded: database is locked/.test(note)),
  );
});

test('a step the log already holds as finished or running is not run again', async (t) => {
  const h = await sdkSetup(t);
  const steps = recorder();
  steps.answer.set('toolu_1', async () => ({ status: 'completed', ok: true, output: 'pr opened' }));
  steps.answer.set('toolu_2', async () => ({ status: 'running' }));
  await tools(h, [
    { id: 'toolu_1', name: 'Bash', input: { command: 'gh pr create' } },
    { id: 'toolu_2', name: 'Bash', input: { command: 'git push origin pr' } },
    { id: 'toolu_3', name: 'Grep', input: { pattern: 'x' } },
  ]);
  const events = await collect(
    await h.runners.claude.start(await h.spec('tsk_sdk_memo', { steps })),
  );

  assert.equal(terminal(events)?.type, 'finished');
  assert.deepEqual(await lines(fakeFile(h, 'ran.log')), ['toolu_3']);
});

test('without an agent channel the SDK path refuses to run, and the CLI is never started', async (t) => {
  const h = await setup({ cloud: { agentSdk: await loadAgentSdk() } });
  t.after(() => h.cleanup());
  await fs.writeFile(join(h.home, '.maka-cli', 'bin', 'claude'), SDK_CLI, { mode: 0o755 });
  await tools(h, [{ id: 'toolu_1', name: 'Bash', input: { command: 'gh pr create' } }]);
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_sdk_nochan')));

  const end = terminal(events);
  assert.equal(end?.type, 'failed');
  assert.match(end?.type === 'failed' ? end.reason : '', /needs an agent channel/u);
  assert.deepEqual(await lines(fakeFile(h, 'ran.log')), []);
});

test('a box that does not keep the channel private is refused before the CLI starts', async (t) => {
  const h = await sdkSetup(t);
  h.runners.fleet.ensureAgentIsolation = async () => {
    throw new Error(
      'the sandbox does not keep the agent channel private: the agent account can write the channel',
    );
  };
  await tools(h, [{ id: 'toolu_1', name: 'Bash', input: { command: 'gh pr create' } }]);
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_sdk_open')));

  const end = terminal(events);
  assert.equal(end?.type, 'failed');
  assert.match(end?.type === 'failed' ? end.reason : '', /can write the channel/u);
  assert.deepEqual(await lines(fakeFile(h, 'ran.log')), []);
});

test('a secret in a tool call is not written to the step log', async (t) => {
  const h = await sdkSetup(t);
  const steps = recorder();
  await tools(h, [
    {
      id: 'toolu_1',
      name: 'Bash',
      input: { command: `curl -H "x-api-key: ${API_KEY}" https://example.test` },
    },
  ]);
  const events = await collect(
    await h.runners.claude.start(await h.spec('tsk_sdk_secret', { steps })),
  );

  assert.equal(terminal(events)?.type, 'finished');
  assert.ok(steps.calls.length > 0);
  assert.ok(!steps.calls.join('\n').includes(API_KEY), 'the model key reached the step log');
  assert.match(steps.calls[0] ?? '', /\[redacted\]/);
});

test('without step logging the SDK runs no hooks', async (t) => {
  const h = await sdkSetup(t);
  await tools(h, [{ id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]);
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_sdk_nosteps')));
  assert.equal(terminal(events)?.type, 'finished');
  assert.equal(await exists(fakeFile(h, 'hooks.log')), false);
  assert.deepEqual(await lines(fakeFile(h, 'ran.log')), ['toolu_1']);
});

test('output lines that are not messages are ignored, and an error result is the task’s failure with the CLI’s words', async (t) => {
  const h = await sdkSetup(t);
  await h.setMode('noise');
  const ok = await collect(await h.runners.claude.start(await h.spec('tsk_sdk_noise')));
  assert.equal(terminal(ok)?.type, 'finished');

  await h.setMode('fail');
  const failed = terminal(
    await collect(await h.runners.claude.start(await h.spec('tsk_sdk_fail'))),
  );
  assert.equal(failed?.type, 'failed');
  assert.match(
    failed?.type === 'failed' ? failed.reason : '',
    /claude exited with code 1: model said no/,
  );

  await h.setMode('exit3');
  const exit3 = terminal(
    await collect(await h.runners.claude.start(await h.spec('tsk_sdk_exit3'))),
  );
  assert.match(exit3?.type === 'failed' ? exit3.reason : '', /claude exited with code 3/);
  assertClean(h);
});

test('spend is reported from the messages, as on the CLI path', async (t) => {
  const h = await sdkSetup(t);
  await h.setMode('spend');
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_sdk_spend')));
  assert.equal(terminal(events)?.type, 'finished');
  const spend = events.flatMap((event) => (event.type === 'usage' ? [event.costUsd] : []));
  assert.equal(spend.at(-1), 0.5, 'the CLI’s own total replaces the estimate');
});

test('a run over its budget is stopped, and its process with it', async (t) => {
  const h = await sdkSetup(t);
  await h.setMode('spendhang');
  const handle = await h.runners.claude.start(await h.spec('tsk_sdk_budget', { budgetUsd: 0.01 }));
  const failed = terminal(await collect(handle));
  assert.equal(failed?.type, 'failed');
  assert.match(failed?.type === 'failed' ? failed.reason : '', /budget of \$0\.01 reached/);
  await handle.cancel();
  assertClean(h);
  assert.deepEqual(await h.runners.fleet.machine(h.fake.machineId).liveTaskDirs(), []);
});

test('cancel stops the CLI on the sandbox and releases everything', async (t) => {
  const h = await sdkSetup(t);
  await h.setMode('hang');
  const handle = await h.runners.claude.start(await h.spec('tsk_sdk_cancel'));
  const events = reader(handle);
  await events.until((event) => event.type === 'progress' && event.note === 'working on it');

  assert.notEqual(await settles(handle.cancel()), 'stuck');
  assert.notEqual(await settles(collect(handle)), 'stuck');
  assert.deepEqual(await h.runners.fleet.machine(h.fake.machineId).liveTaskDirs(), []);
  assertClean(h);
});

test('after a restart the SDK continues the recorded session with the recovery note as its message', async (t) => {
  const h = await sdkSetup(t);
  assert.equal(
    terminal(await collect(await h.runners.claude.start(await h.spec('tsk_sdk_recover'))))?.type,
    'finished',
  );

  const spec = await h.spec('tsk_sdk_recover');
  const handle = await h.runners.claude.recover({
    ...spec,
    recovery: { epoch: 2, resumes: 1, note: 'NOTE: the server restarted' },
  });
  assert.equal(terminal(await collect(handle))?.type, 'finished');

  const { argv } = await h.cliCall('claude', 2);
  assert.ok(argv.includes('--resume=sess-1'));
  const prompts = await lines(fakeFile(h, 'prompts.log'));
  assert.match(prompts.at(-1) ?? '', /NOTE: the server restarted/);
  // Its input is a file of its own: the first run's was not touched.
  assert.ok(await exists(join(h.root, 'tsk_sdk_recover', 'chan', 't2.in')));
  assertClean(h);
});

test('the real SDK loads and exposes query', async () => {
  const sdk = await loadAgentSdk();
  assert.equal(typeof sdk.query, 'function');
});
