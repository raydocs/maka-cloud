import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexExecutor, codexStreamEvents } from '../codex-executor.js';
import {
  ExecutorCoder,
  MemoryExecutorSessionStore,
  STATUS_MARKER,
  driveTurn,
  type ExecutorSession,
} from '../executor.js';
import { estimateUsdMicros } from '../executor-budget.js';
import { ScriptedProcessRunner } from '../executor-process.js';
import { scratchFiles } from '../loop.js';
import { actMandate, type NormalizedEvent, type WorkerRecord } from '../types.js';
import { initLocalRepo } from '../workspace.js';

const KEY = 'magpie-key-0123456789abcdef';
const ENV = { PATH: '/usr/bin', HOME: '/home/x', MAKA_GITHUB_TOKEN: 'ghp_never_0123456789' };
const GATEWAY = { baseUrl: 'https://magpie.example/', token: KEY };
const THREAD = '01a1a10c-1851-7c53-8e5c-5bb9497bf2e5';

// Lines as `codex exec --json` 0.166 prints them (checked against a live Magpie run).
const started = JSON.stringify({ type: 'thread.started', thread_id: THREAD });
const turnStarted = JSON.stringify({ type: 'turn.started' });
const command = JSON.stringify({
  type: 'item.started',
  item: { id: 'item_1', type: 'command_execution', command: 'node add.test.js' },
});
function message(text: string) {
  return JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_2', type: 'agent_message', text },
  });
}
const completed = JSON.stringify({
  type: 'turn.completed',
  usage: {
    input_tokens: 15_123,
    cached_input_tokens: 3_328,
    cache_write_input_tokens: 0,
    output_tokens: 5,
    reasoning_output_tokens: 0,
  },
});
const failed = JSON.stringify({
  type: 'turn.failed',
  error: { message: 'unexpected status 429 Too Many Requests' },
});

function start(executor: CodexExecutor, boxId?: string) {
  return executor.start({
    workerId: 'w',
    ticket: 'fix add',
    mandate: actMandate([]),
    workdir: '/repo',
    systemPrompt: 'SYSTEM',
    ...(boxId ? { boxId } : {}),
  });
}

test('stream: thread id kept, usage split into cached and fresh input, status line decides', () => {
  const session = { sessionId: 's', model: 'codex/gpt-6-luna', route: 'magpie' } as ExecutorSession;
  const state = { model: session.model, lastText: '', turnStarted: 0 };
  let clock = 1_000;
  const now = () => clock;
  codexStreamEvents(JSON.parse(started), state, session, now);
  assert.equal(session.vendorSessionId, THREAD);
  codexStreamEvents(JSON.parse(turnStarted), state, session, now);
  assert.deepEqual(codexStreamEvents(JSON.parse(command), state, session, now).events, [
    { type: 'progress', text: '$ node add.test.js' },
  ]);
  codexStreamEvents(
    JSON.parse(message(`fixed\n${STATUS_MARKER} {"status":"ready","summary":"add fixed"}`)),
    state,
    session,
    now,
  );
  clock = 3_500;
  const end = codexStreamEvents(JSON.parse(completed), state, session, now);
  assert.deepEqual(end.events, [
    {
      type: 'usage',
      usage: {
        inputTokens: 11_795,
        cacheReadTokens: 3_328,
        cacheWriteTokens: 0,
        outputTokens: 5,
        turns: 1,
        wallMs: 2_500,
        usdMicros: estimateUsdMicros('codex/gpt-6-luna', {
          inputTokens: 11_795,
          cacheReadTokens: 3_328,
          outputTokens: 5,
        }),
      },
      route: 'magpie',
    },
  ]);
  assert.deepEqual(end.terminal, { type: 'ready', summary: 'add fixed' });
  const bad = codexStreamEvents(JSON.parse(failed), state, session, now).terminal;
  assert.deepEqual(bad, {
    type: 'failed',
    error: 'unexpected status 429 Too Many Requests',
    retryable: true,
  });
});

test('Magpie route: provider flags and key env, never the key in argv; resume uses the thread id', async () => {
  const runner = new ScriptedProcessRunner([
    () => ({ lines: [started, turnStarted, message('done'), completed], done: true }),
    () => ({ lines: [started, turnStarted, message('again'), completed], done: true }),
  ]);
  const executor = new CodexExecutor({ env: ENV, runner, gateway: GATEWAY });
  const first = await start(executor);
  const ran = await driveTurn(first);
  assert.equal(ran.terminal.type, 'ready');
  assert.equal(first.session.vendorSessionId, THREAD);
  assert.equal(first.session.model, 'codex/gpt-6-luna');
  const spawn0 = runner.spawned[0];
  assert.ok(spawn0);
  assert.deepEqual(spawn0.args.slice(0, 5), [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-s',
    'workspace-write',
  ]);
  assert.ok(spawn0.args.includes('model_providers.magpie.base_url="https://magpie.example/v1"'));
  assert.ok(spawn0.args.includes('model_providers.magpie.env_key="MAKA_CLOUD_MAGPIE_KEY"'));
  assert.ok(spawn0.args.includes('model_providers.magpie.wire_api="responses"'));
  assert.ok(
    spawn0.args.includes(`/tmp/maka-codex-${first.session.sessionId}.txt`),
    'own id in argv',
  );
  assert.equal(spawn0.marker, `maka-codex-${first.session.sessionId}`, 'box stop and RSS find it');
  assert.equal(spawn0.args.at(-1), '-', 'prompt on stdin');
  assert.equal(spawn0.args.join(' ').includes(KEY), false);
  assert.equal(spawn0.env.MAKA_CLOUD_MAGPIE_KEY, KEY);
  assert.equal(spawn0.env.MAKA_GITHUB_TOKEN, undefined);
  assert.equal(spawn0.stdin.join(''), 'SYSTEM\n\nfix add', 'Mandate prefix opens the thread');

  await driveTurn(await executor.send(first.session, { kind: 'ci', text: 'CI failed' }));
  const resumed = runner.spawned[1];
  assert.ok(resumed);
  assert.deepEqual(resumed.args.slice(0, 3), ['exec', 'resume', '--json']);
  assert.ok(resumed.args.includes('sandbox_mode="workspace-write"'), 'resume has no -s');
  assert.deepEqual(resumed.args.slice(-2), [THREAD, '-']);
  assert.equal(resumed.stdin.join(''), 'CI failed');
});

test('a send during a running turn waits for the next turn; resume without a thread id fails', async () => {
  const runner = new ScriptedProcessRunner([
    () => ({ lines: [started, turnStarted] }),
    () => ({ lines: [started, message('ok'), completed], done: true }),
  ]);
  const executor = new CodexExecutor({ env: ENV, runner, sandbox: 'bypass' });
  const live = await start(executor, 'box-1');
  const queued = await executor.send(live.session, { kind: 'wrap-up', text: 'wrap up' });
  assert.equal(queued.queued, true);
  assert.ok(runner.spawned[0]?.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(runner.spawned[0]?.machineId, 'box-1');
  await executor.stop(live.session);
  const stopped = await driveTurn(live);
  assert.equal(stopped.terminal.type, 'failed');
  await driveTurn(await executor.send(live.session, { kind: 'ci', text: 'CI failed' }));
  assert.equal(runner.spawned[1]?.stdin.join(''), 'wrap up\n\nCI failed');

  const orphan = await new CodexExecutor({ env: ENV, runner }).resume(
    { ...live.session, vendorSessionId: undefined } as ExecutorSession,
    'note',
  );
  const lost = await driveTurn(orphan);
  assert.equal(lost.terminal.type, 'failed');
  if (lost.terminal.type === 'failed') assert.match(lost.terminal.error, /no thread id/);
});

test('fallback: `codex login status` per box; Magpie only where Codex is not signed in', async () => {
  const done = () => ({ lines: [started, message('ok'), completed], done: true });
  const runner = new ScriptedProcessRunner([
    () => ({ lines: ['Not logged in'], done: true, code: 1 }),
    done,
    () => ({ lines: ['Logged in using ChatGPT'], done: true, code: 0 }),
    done,
  ]);
  const executor = new CodexExecutor({
    env: ENV,
    runner,
    gateway: GATEWAY,
    gatewayMode: 'fallback',
    model: 'gpt-6.1-sol',
  });
  const a = await start(executor, 'box-a');
  await driveTurn(a);
  const b = await start(executor, 'box-b');
  await driveTurn(b);
  assert.deepEqual(runner.spawned[0]?.args, ['login', 'status']);
  assert.equal(a.session.route, 'magpie');
  assert.equal(a.session.model, 'codex/gpt-6-luna');
  assert.equal(runner.spawned[1]?.env.MAKA_CLOUD_MAGPIE_KEY, KEY);
  assert.equal(b.session.route, 'builtin');
  assert.equal(b.session.model, 'gpt-6.1-sol');
  assert.equal(runner.spawned[3]?.env.MAKA_CLOUD_MAGPIE_KEY, undefined);
  assert.equal(
    runner.spawned[3]?.args.some((arg) => arg.includes('magpie')),
    false,
  );
});

test('review fix: the thread id is stored as soon as it arrives; a session without one starts over', async () => {
  const dir = await initLocalRepo(scratchFiles());
  const sessions = new MemoryExecutorSessionStore();
  const runner = new ScriptedProcessRunner([
    () => ({ lines: [started, turnStarted, command, message('ok'), completed], done: true }),
    () => ({ lines: [started, message('ok'), completed], done: true }),
  ]);
  let storedMidTurn: string | undefined;
  const coder = new ExecutorCoder(new CodexExecutor({ env: ENV, runner }), {
    sessions,
    onEvent: async (event) => {
      if (event.type === 'progress' && event.text.startsWith('$ ')) {
        storedMidTurn = (await sessions.get('w1', 't'))?.vendorSessionId;
      }
    },
  });
  const worker = {
    workerId: 'w1',
    tenantId: 't',
    mandate: actMandate([]),
  } as unknown as WorkerRecord;
  const event = { type: 'pr_opened', fields: [] } as unknown as NormalizedEvent;
  await coder.apply({ dir, brief: 'fix', event, worker });
  assert.equal(storedMidTurn, THREAD, 'persisted before the turn ended');

  // A record from a crash before thread.started cannot resume: start a new thread.
  const stored = await sessions.get('w1', 't');
  await sessions.put({ ...(stored as ExecutorSession), vendorSessionId: undefined });
  await new ExecutorCoder(new CodexExecutor({ env: ENV, runner }), { sessions }).apply({
    dir,
    brief: 'CI failed',
    event: { type: 'ci_failed', fields: [] } as unknown as NormalizedEvent,
    worker,
  });
  assert.equal(runner.spawned[1]?.args[1], '--json', 'exec, not exec resume');
});

test('review fix: a stored Codex Magpie session fails closed when Magpie is not configured', async () => {
  const runner = new ScriptedProcessRunner([]);
  const ran = await driveTurn(
    await new CodexExecutor({ env: ENV, runner }).resume(
      {
        sessionId: 's',
        kind: 'codex',
        workerId: 'w',
        workdir: '/repo',
        systemPrompt: 'S',
        startedAt: 1,
        route: 'magpie',
        vendorSessionId: THREAD,
      },
      'note',
    ),
  );
  assert.equal(ran.terminal.type, 'failed');
  assert.equal(runner.spawned.length, 0);
});

test('review round 2: thread.started alone stores the thread id', async () => {
  const dir = await initLocalRepo(scratchFiles());
  const sessions = new MemoryExecutorSessionStore();
  const runner = new ScriptedProcessRunner([
    () => ({ lines: [started, turnStarted, message('ok'), completed], done: true }),
  ]);
  let stored: string | undefined;
  const coder = new ExecutorCoder(new CodexExecutor({ env: ENV, runner }), {
    sessions,
    onEvent: async (event) => {
      if (event.type === 'progress' && event.text === 'codex thread started') {
        stored = (await sessions.get('w1', 't'))?.vendorSessionId;
      }
    },
  });
  const worker = {
    workerId: 'w1',
    tenantId: 't',
    mandate: actMandate([]),
  } as unknown as WorkerRecord;
  await coder.apply({
    dir,
    brief: 'fix',
    event: { type: 'pr_opened', fields: [] } as unknown as NormalizedEvent,
    worker,
  });
  assert.equal(stored, THREAD);
});
