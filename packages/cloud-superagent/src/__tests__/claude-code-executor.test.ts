import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ClaudeCodeExecutor,
  claudeStreamEvents,
  claudeStreamState,
} from '../claude-code-executor.js';
import {
  ExecutorCoder,
  FakeExecutor,
  STATUS_MARKER,
  driveTurn,
  eventsOf,
  type Executor,
  type ExecutorEvent,
  type ExecutorSession,
  type ExecutorTurn,
} from '../executor.js';
import {
  WRAP_UP_TEXT,
  assignmentBudget,
  checkBudget,
  estimateUsdMicros,
} from '../executor-budget.js';
import {
  BoxProcessRunner,
  ScriptedProcessRunner,
  executorEnv,
  redactSecrets,
} from '../executor-process.js';
import { BOX_REPO } from '../loop-box.js';
import { createCoderFromEnv, gatewayFromEnv } from '../loop-coder.js';
import { boxSecretsFromEnv } from '../real-loop.js';
import { FakeSandbox } from '../sandbox.js';
import { actMandate, type NormalizedEvent, type WorkerRecord } from '../types.js';

const KEY = 'sk-ant-test-0123456789abcdef';
const ENV = {
  PATH: '/usr/bin',
  HOME: '/home/x',
  ANTHROPIC_API_KEY: KEY,
  MAKA_GITHUB_TOKEN: 'ghp_should_not_pass_0123456789',
};

const init = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: 's',
  model: 'claude-haiku-5-5',
});
function assistant(id: string, text: string, usage = { input_tokens: 100, output_tokens: 20 }) {
  return JSON.stringify({
    type: 'assistant',
    message: { id, model: 'claude-haiku-5-5', content: [{ type: 'text', text }], usage },
  });
}
function result(text: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    total_cost_usd: 0.001,
    duration_ms: 1500,
    usage: { input_tokens: 100, output_tokens: 20 },
    ...extra,
  });
}

const event = { type: 'pr_opened', summary: 'fix', fields: [] } as unknown as NormalizedEvent;

function worker(budgets: Record<string, number> = {}, usage = {}): WorkerRecord {
  const mandate = actMandate(['acme/app']);
  mandate.budgets = budgets;
  return {
    workerId: 'w1',
    mandate,
    usage: { tokens: 0, usdMicros: 0, wallMs: 0, ...usage },
  } as unknown as WorkerRecord;
}

test('stream parser: init, usage once per message id, status line, errors, cost reconcile', () => {
  const state = claudeStreamState();
  assert.deepEqual(claudeStreamEvents(JSON.parse(init), state).events, [
    { type: 'progress', text: 'claude-code session started (claude-haiku-5-5)' },
  ]);
  const first = claudeStreamEvents(JSON.parse(assistant('m1', 'Reading add.js')), state);
  assert.equal(first.events.filter((row) => row.type === 'usage').length, 1);
  const repeat = claudeStreamEvents(JSON.parse(assistant('m1', 'second block')), state);
  assert.equal(repeat.events.filter((row) => row.type === 'usage').length, 0);
  assert.equal(state.usage.inputTokens, 100);
  assert.equal(state.usage.turns, 1);
  assert.equal(
    state.usage.usdMicros,
    estimateUsdMicros('claude-haiku-5-5', { inputTokens: 100, outputTokens: 20 }),
  );

  const done = claudeStreamEvents(
    JSON.parse(
      result(`ok\n${STATUS_MARKER} {"status":"needs-person","question":"Keep v1?","reason":"api"}`),
    ),
    state,
  );
  assert.equal(done.terminal?.type, 'needs-person');
  assert.equal(state.usage.usdMicros, 1000, 'total_cost_usd wins over the estimate');
  assert.equal(state.usage.wallMs, 1500);

  const failed = claudeStreamEvents(
    JSON.parse(result('ran out', { subtype: 'error_max_turns', is_error: true })),
    claudeStreamState(),
  );
  assert.equal(failed.terminal?.type, 'failed');

  const plain = claudeStreamEvents(JSON.parse(result('Fixed add.')), claudeStreamState());
  assert.deepEqual(plain.terminal, { type: 'ready', summary: 'Fixed add.' });
});

test('process env is an allowlist and secrets never reach argv or kept stderr', () => {
  const env = executorEnv(ENV, ['ANTHROPIC_API_KEY']);
  assert.equal(env.ANTHROPIC_API_KEY, KEY);
  assert.equal(env.MAKA_GITHUB_TOKEN, undefined);
  assert.equal(
    redactSecrets(`401 for ${KEY}`, env, ['ANTHROPIC_API_KEY']),
    '401 for [ANTHROPIC_API_KEY]',
  );
});

test('start runs claude -p on the built-in login with a fresh session id; send later resumes it', async () => {
  const runner = new ScriptedProcessRunner([
    () => ({ lines: [init, assistant('m1', 'editing'), result('done')] }),
    () => ({
      lines: [
        assistant('m2', 'fixing CI'),
        result(`${STATUS_MARKER} {"status":"ready","summary":"CI fixed"}`),
      ],
    }),
  ]);
  const executor = new ClaudeCodeExecutor({ env: ENV, runner, model: 'claude-haiku-5-5' });
  const turn = await executor.start({
    workerId: 'w1',
    ticket: 'fix add',
    mandate: actMandate(['acme/app']),
    workdir: '/tmp/wd',
    systemPrompt: 'SYSTEM',
  });
  const ran = await driveTurn(turn);
  assert.deepEqual(ran.terminal, { type: 'ready', summary: 'done' });
  assert.equal(ran.usage.usdMicros, 1000);
  const first = runner.spawned[0];
  assert.ok(first);
  assert.equal(first.command, 'claude');
  assert.equal(first.cwd, '/tmp/wd');
  assert.equal(first.args.includes('--bare'), false, 'built-in login: no --bare');
  assert.equal(first.env.ANTHROPIC_API_KEY, undefined, 'built-in login: no host key passed');
  assert.deepEqual(first.args.slice(0, 6), [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
  ]);
  assert.equal(first.args[first.args.indexOf('--session-id') + 1], turn.session.sessionId);
  assert.match(turn.session.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(first.args[first.args.indexOf('--append-system-prompt') + 1], 'SYSTEM');
  assert.equal(first.args[first.args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.equal(first.args.join(' ').includes(KEY), false);
  assert.equal(first.env.MAKA_GITHUB_TOKEN, undefined);
  assert.deepEqual(JSON.parse(first.stdin[0] as string).message.content[0].text, 'fix add');

  const next = await executor.send(turn.session, { kind: 'ci', text: 'CI failed: lint' });
  assert.equal(next.queued, undefined);
  const again = await driveTurn(next);
  assert.deepEqual(again.terminal, { type: 'ready', summary: 'CI fixed' });
  assert.ok(ran.usage.turns >= 1);
  const second = runner.spawned[1];
  assert.equal(second?.args[second.args.indexOf('--resume') + 1], turn.session.sessionId);
  assert.equal(second?.args.includes('--session-id'), false);
});

test('send during a running turn goes to its stdin and waits for the second result', async () => {
  let executor: ClaudeCodeExecutor | undefined;
  let session: ExecutorSession | undefined;
  const runner = new ScriptedProcessRunner([
    (stdin) =>
      stdin.length < 2
        ? { lines: [init, assistant('m1', 'working')] }
        : {
            lines: [
              init,
              assistant('m1', 'working'),
              result('first'),
              assistant('m2', 'wrapping'),
              result('wrapped'),
            ],
          },
  ]);
  executor = new ClaudeCodeExecutor({ env: ENV, runner });
  const turn = await executor.start({
    workerId: 'w1',
    ticket: 'go',
    mandate: actMandate(['acme/app']),
    workdir: '/tmp/wd',
    systemPrompt: 'S',
  });
  session = turn.session;
  const ran = await driveTurn(turn, async (row) => {
    if (row.type === 'progress' && row.text === 'working') {
      const queued = await executor?.send(session as ExecutorSession, {
        kind: 'wrap-up',
        text: WRAP_UP_TEXT,
      });
      assert.equal(queued?.queued, true);
    }
  });
  assert.deepEqual(ran.terminal, { type: 'ready', summary: 'wrapped' });
  assert.equal(runner.spawned.length, 1);
  assert.equal(runner.spawned[0]?.stdin.length, 2);
});

test('a process that exits without a result fails, with the key redacted from stderr', async () => {
  const runner = new ScriptedProcessRunner([
    () => ({ lines: [init], done: true, code: 1, stderr: `invalid x-api-key ${KEY}` }),
  ]);
  const executor = new ClaudeCodeExecutor({
    env: ENV,
    runner,
    gateway: { baseUrl: 'https://magpie.example/anthropic', token: KEY },
  });
  const events: ExecutorEvent[] = [];
  const ran = await driveTurn(
    await executor.start({
      workerId: 'w',
      ticket: 't',
      mandate: actMandate([]),
      workdir: '/tmp',
      systemPrompt: 'S',
    }),
    (row) => {
      events.push(row);
    },
  );
  const spawned = runner.spawned[0];
  // As tested on 2026-11-03: auth token, empty API key, no --bare, `auto/` model ids.
  assert.equal(spawned?.args.includes('--bare'), false);
  assert.equal(spawned?.env.ANTHROPIC_BASE_URL, 'https://magpie.example/anthropic');
  assert.equal(spawned?.env.ANTHROPIC_AUTH_TOKEN, KEY);
  assert.equal(spawned?.env.ANTHROPIC_API_KEY, '');
  assert.equal(spawned?.args[(spawned?.args.indexOf('--model') ?? 0) + 1], 'auto/claude-opus-5-5');
  assert.equal(spawned?.args.join(' ').includes(KEY), false);
  assert.equal(executor.route, 'magpie');
  assert.equal(ran.terminal.type, 'failed');
  if (ran.terminal.type !== 'failed') return;
  assert.match(ran.terminal.error, /claude exited 1 before a result/);
  assert.equal(ran.terminal.error.includes(KEY), false);
  assert.match(ran.terminal.error, /\[ANTHROPIC_AUTH_TOKEN\]/);
});

test('budget: remaining is Mandate minus earlier usage; worst dimension decides', () => {
  const budget = assignmentBudget(
    { ...actMandate([]), budgets: { tokens: 1000, usd: 1, wallMs: 60_000, turns: 10 } },
    { tokens: 400, usdMicros: 100_000, wallMs: 0 },
    4,
  );
  assert.deepEqual(budget, { tokens: 600, usdMicros: 900_000, wallMs: 60_000, turns: 6 });
  const usage = {
    inputTokens: 300,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    usdMicros: 0,
    turns: 1,
    wallMs: 0,
  };
  assert.equal(checkBudget(budget, usage, 0).level, 'ok');
  assert.deepEqual(checkBudget(budget, { ...usage, inputTokens: 500 }, 0), {
    level: 'wrap-up',
    reason: 'tokens 500/600',
  });
  assert.deepEqual(checkBudget(budget, { ...usage, turns: 6 }, 0), {
    level: 'stop',
    reason: 'turns 6/6',
  });
  assert.deepEqual(assignmentBudget(undefined, undefined), {});
});

test('ExecutorCoder: 80% sends one wrap-up into the running turn, 100% stops and asks a person', async () => {
  const usage = (n: number): ExecutorEvent => ({
    type: 'usage',
    usage: { inputTokens: n, turns: 1 },
  });
  const executor = new FakeExecutor({
    steps: [
      [usage(500), usage(350), usage(100), usage(100), { type: 'ready', summary: 'never reached' }],
    ],
  });
  const coder = new ExecutorCoder(executor);
  const result = await coder.apply({
    dir: '/tmp',
    brief: 'go',
    event,
    worker: worker({ tokens: 1000 }),
  });
  assert.equal(result.outcome?.type, 'needs-person');
  if (result.outcome?.type !== 'needs-person') return;
  assert.match(result.outcome.ask.question, /whole budget \(tokens 1050\/1000\)/);
  assert.match(result.outcome.ask.reason, /Stopped at 100%/);
  assert.deepEqual(
    executor.calls.map((call) => [call.op, call.inputKind ?? null, call.queued ?? false]),
    [
      ['start', null, false],
      ['send', 'wrap-up', true],
      ['stop', null, false],
    ],
  );
  assert.equal(result.usage?.tokens, 1050);
});

test('turn budget counts across turns of the same session', async () => {
  const usage: ExecutorEvent = { type: 'usage', usage: { outputTokens: 1, turns: 2 } };
  const executor = new FakeExecutor({
    steps: [
      [usage, { type: 'ready', summary: 'one' }],
      [usage, { type: 'ready', summary: 'two' }],
    ],
  });
  const coder = new ExecutorCoder(executor);
  const w = worker({ turns: 4 });
  assert.equal(
    (await coder.apply({ dir: '/tmp', brief: 'a', event, worker: w })).outcome,
    undefined,
  );
  const second = await coder.apply({ dir: '/tmp', brief: 'b', event, worker: w });
  assert.equal(second.outcome?.type, 'needs-person');
});

/** Prints one progress line, then stays silent until stopped. */
class SilentExecutor implements Executor {
  readonly kind = 'fake' as const;
  stops = 0;
  sends: string[] = [];
  private release: (() => void) | undefined;

  async start(input: {
    workerId: string;
    workdir: string;
    systemPrompt: string;
  }): Promise<ExecutorTurn> {
    const session: ExecutorSession = {
      sessionId: 's',
      kind: 'fake',
      workerId: input.workerId,
      workdir: input.workdir,
      systemPrompt: input.systemPrompt,
      startedAt: 0,
    };
    const gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
    async function* events(): AsyncIterable<ExecutorEvent> {
      yield { type: 'progress', text: 'thinking' };
      await gate;
    }
    return { session, events: events() };
  }
  async send(session: ExecutorSession, input: { text: string }): Promise<ExecutorTurn> {
    this.sends.push(input.text);
    return { session, events: eventsOf([]), queued: true };
  }
  async resume(session: ExecutorSession): Promise<ExecutorTurn> {
    return { session, events: eventsOf([]) };
  }
  async stop(): Promise<void> {
    this.stops += 1;
    this.release?.();
  }
}

test('a silent executor is wrapped up and then stopped by the wall-time budget', async () => {
  const executor = new SilentExecutor();
  const coder = new ExecutorCoder(executor);
  const result = await coder.apply({
    dir: '/tmp',
    brief: 'go',
    event,
    worker: worker({ wallMs: 60 }),
  });
  assert.deepEqual(executor.sends, [WRAP_UP_TEXT]);
  assert.equal(executor.stops, 1);
  assert.equal(result.outcome?.type, 'needs-person');
  if (result.outcome?.type === 'needs-person')
    assert.match(result.outcome.ask.question, /wall_ms 60\/60/);
});

test('MAKA_CLOUD_EXECUTOR picks Claude Code on the built-in login; magpie is opt-in', () => {
  assert.equal(createCoderFromEnv({}).kind, 'fake');
  assert.equal(createCoderFromEnv({ MAKA_CLOUD_EXECUTOR: 'fake' }).kind, 'fake');
  const picked = createCoderFromEnv({ MAKA_CLOUD_EXECUTOR: 'claude-code' });
  assert.equal(picked.kind, 'claude-code');
  assert.ok(picked.coder instanceof ExecutorCoder);
  assert.equal(picked.coder.wantsWorkdir, true);
  assert.throws(
    () => createCoderFromEnv({ MAKA_CLOUD_EXECUTOR: 'gemini' }),
    /not a known executor/,
  );
  assert.throws(
    () =>
      createCoderFromEnv({
        MAKA_CLOUD_EXECUTOR: 'claude-code',
        MAKA_CLOUD_EXECUTOR_GATEWAY: 'magpie',
      }),
    /needs MAKA_CLOUD_MAGPIE_URL and MAKA_CLOUD_MAGPIE_KEY/,
  );
  const magpie = { MAKA_CLOUD_MAGPIE_URL: 'https://magpie.example', MAKA_CLOUD_MAGPIE_KEY: KEY };
  assert.deepEqual(gatewayFromEnv({ MAKA_CLOUD_EXECUTOR_GATEWAY: 'magpie', ...magpie }), {
    gateway: { baseUrl: 'https://magpie.example', token: KEY },
    gatewayMode: 'always',
  });
  // A Magpie URL and key without a choice: check the login first, fall back to Magpie.
  assert.equal(gatewayFromEnv(magpie).gatewayMode, 'fallback');
  assert.equal(
    gatewayFromEnv({ MAKA_CLOUD_EXECUTOR_GATEWAY: 'builtin', ...magpie }).gateway,
    undefined,
  );
  assert.deepEqual(gatewayFromEnv({}), { gatewayMode: 'always' });
  assert.equal(createCoderFromEnv({ MAKA_CLOUD_EXECUTOR: 'codex' }).kind, 'codex');
  const boxed = createCoderFromEnv({ MAKA_CLOUD_EXECUTOR: 'claude-code' }, fetch, {
    sandbox: new FakeSandbox(),
  });
  assert.equal(boxed.coder.wantsWorkdir, false);
});

/**
 * A fake `claude` for FakeSandbox (real local shell): records argv, stdin and
 * the token variable it saw, edits add.js in its cwd, prints scripted lines.
 */
async function fakeClaude(lines: string[]): Promise<{ bin: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-claude-'));
  await writeFile(join(dir, 'out.txt'), `${lines.join('\n')}\n`);
  const bin = join(dir, 'claude');
  await writeFile(
    bin,
    [
      '#!/bin/sh',
      `n=$(ls ${dir} | grep -c '^stdin') `,
      `cat > ${dir}/stdin.$n`,
      `printf '%s\\n' "$@" > ${dir}/args.$n`,
      `printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN" > ${dir}/token.$n`,
      `pwd > ${dir}/cwd.$n`,
      "printf 'export const add = (a, b) => a + b;\\n' > add.js",
      `cat ${dir}/out.txt`,
      '',
    ].join('\n'),
  );
  await chmod(bin, 0o755);
  return { bin, dir };
}

async function boxWithRepo(sandbox: FakeSandbox, machineId: string): Promise<void> {
  const made = await sandbox.exec(machineId, {
    cmd: `mkdir -p ${BOX_REPO} && cd ${BOX_REPO} && git init -q && printf 'x' > add.js && git add -A && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm init`,
  });
  assert.equal(made.exitCode, 0, made.stderr);
}

test('in the box: claude runs detached on the checkout and is polled; mid-turn text opens the next turn', async () => {
  const fake = await fakeClaude([
    init,
    assistant('m1', 'editing'),
    result(`${STATUS_MARKER} {"status":"ready","summary":"fixed"}`),
  ]);
  const sandbox = new FakeSandbox();
  await boxWithRepo(sandbox, 'box-7');
  const runner = new BoxProcessRunner(sandbox, { pollMs: 20 });
  const executor = new ClaudeCodeExecutor({ env: ENV, runner, bin: fake.bin });
  const coder = new ExecutorCoder(executor, { box: { sandbox, workdir: BOX_REPO } });
  const boxed = { ...worker({ tokens: 10_000 }), sandboxRef: 'box-7' } as WorkerRecord;
  const first = await coder.apply({ brief: 'fix add', event, worker: boxed });
  assert.equal(first.summary, 'fixed');
  assert.deepEqual(first.changed, ['add.js']);
  assert.deepEqual(first.files, {}, 'edits stay in the box checkout');
  const args = (await readFile(join(fake.dir, 'args.0'), 'utf8')).split('\n');
  assert.deepEqual(args.slice(0, 6), [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
  ]);
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.match(await readFile(join(fake.dir, 'cwd.0'), 'utf8'), /maka-loop\/repo\n$/);
  const stdin = await readFile(join(fake.dir, 'stdin.0'), 'utf8');
  assert.equal(JSON.parse(stdin.trim()).message.content[0].text, 'fix add');
  assert.equal(
    sandbox.commands.some((row) => row.cmd.includes('/home/x')),
    false,
    'no host HOME goes into the box',
  );

  // A wrap-up sent once the box run started cannot reach its stdin; it opens the next turn.
  const live = await executor.start({
    workerId: 'w9',
    ticket: 'x',
    mandate: actMandate([]),
    workdir: BOX_REPO,
    systemPrompt: 'S',
    boxId: 'box-7',
  });
  let queued: ExecutorTurn | undefined;
  await driveTurn(live, async () => {
    queued ??= await executor.send(live.session, { kind: 'wrap-up', text: WRAP_UP_TEXT });
  });
  assert.equal(queued?.queued, true);
  await driveTurn(await executor.send(live.session, { kind: 'ci', text: 'CI failed' }));
  const resumedArgs = (await readFile(join(fake.dir, 'args.2'), 'utf8')).split('\n');
  assert.equal(resumedArgs[resumedArgs.indexOf('--resume') + 1], live.session.sessionId);
  const resumedStdin = await readFile(join(fake.dir, 'stdin.2'), 'utf8');
  assert.equal(
    JSON.parse(resumedStdin.trim()).message.content[0].text,
    `${WRAP_UP_TEXT}\n\nCI failed`,
  );
});

test('box auth comes from a box Secret variable; the host never sends a value', async () => {
  const fake = await fakeClaude([init, result('ok')]);
  const sandbox = new FakeSandbox();
  await boxWithRepo(sandbox, 'box-1');
  const before = process.env.CLAUDE_TOKEN_1;
  process.env.CLAUDE_TOKEN_1 = 'placeholder-from-box';
  try {
    const executor = new ClaudeCodeExecutor({
      env: ENV,
      bin: fake.bin,
      runner: new BoxProcessRunner(sandbox, { pollMs: 20 }),
      boxSecretEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'CLAUDE_TOKEN_1' },
    });
    const ran = await driveTurn(
      await executor.start({
        workerId: 'w',
        ticket: 't',
        mandate: actMandate([]),
        workdir: BOX_REPO,
        systemPrompt: 'S',
        boxId: 'box-1',
      }),
    );
    assert.equal(ran.terminal.type, 'ready');
    // The turn ends at the result line; the run directory still goes away.
    assert.ok(
      sandbox.commands.some((row) => /rm -rf \S*\.maka-exec\//.test(row.cmd)),
      'run directory removed after an early stop',
    );
    assert.equal(await readFile(join(fake.dir, 'token.0'), 'utf8'), 'placeholder-from-box');
    assert.equal(
      sandbox.commands.some((row) => row.cmd.includes('placeholder-from-box')),
      false,
    );
  } finally {
    if (before === undefined) delete process.env.CLAUDE_TOKEN_1;
    else process.env.CLAUDE_TOKEN_1 = before;
  }
  assert.throws(
    () =>
      new BoxProcessRunner(sandbox).spawn({
        command: 'claude',
        args: [],
        cwd: BOX_REPO,
        env: {},
        machineId: 'box-1',
        envFromBox: { 'X;rm -rf': 'Y' },
      }),
    /bad variable name/,
  );
  assert.deepEqual(boxSecretsFromEnv({ MAKA_CLOUD_BOX_SECRETS: ' CLAUDE_TOKEN_1, B ' }), {
    secrets: ['CLAUDE_TOKEN_1', 'B'],
  });
  assert.deepEqual(boxSecretsFromEnv({}), {});
});

test('a box run past its deadline is killed and reported as failed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slow-claude-'));
  const bin = join(dir, 'claude');
  await writeFile(bin, '#!/bin/sh\ncat > /dev/null\nsleep 5\n');
  await chmod(bin, 0o755);
  const sandbox = new FakeSandbox();
  await boxWithRepo(sandbox, 'box-2');
  const runner = new BoxProcessRunner(sandbox, { pollMs: 20, timeoutSeconds: 0.2 });
  const executor = new ClaudeCodeExecutor({ env: ENV, bin, runner });
  const ran = await driveTurn(
    await executor.start({
      workerId: 'w',
      ticket: 't',
      mandate: actMandate([]),
      workdir: BOX_REPO,
      systemPrompt: 'S',
      boxId: 'box-2',
    }),
  );
  assert.equal(ran.terminal.type, 'failed');
  if (ran.terminal.type === 'failed') assert.match(ran.terminal.error, /SIGTERM/);
  // Without GNU time, peak RSS is sampled from the session's processes at each poll.
  assert.ok((runner.peakRssKb.get('box-2') ?? 0) > 0, 'peak RSS sampled while running');
});

test('fallback: the login check runs once per box; Magpie only where the CLI is not signed in', async () => {
  const done = () => ({ lines: [init, result('ok')], done: true });
  const runner = new ScriptedProcessRunner([
    () => ({ lines: [], done: true, code: 1 }), // box-a: claude auth status → not signed in
    done,
    done,
    () => ({ lines: [], done: true, code: 0 }), // box-b: signed in
    done,
  ]);
  const executor = new ClaudeCodeExecutor({
    env: ENV,
    runner,
    gateway: { baseUrl: 'https://magpie.example', token: KEY },
    gatewayMode: 'fallback',
    boxSecretEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'CLAUDE_TOKEN_1' },
  });
  const start = (boxId: string) =>
    executor.start({
      workerId: boxId,
      ticket: 't',
      mandate: actMandate([]),
      workdir: BOX_REPO,
      systemPrompt: 'S',
      boxId,
    });
  const a1 = await start('box-a');
  await driveTurn(a1);
  await driveTurn(await start('box-a'));
  const b = await start('box-b');
  await driveTurn(b);
  const argv = runner.spawned.map((row) => row.args.slice(0, 2).join(' '));
  assert.deepEqual(argv, [
    'auth status',
    '-p --verbose',
    '-p --verbose',
    'auth status',
    '-p --verbose',
  ]);
  assert.equal(a1.session.route, 'magpie');
  assert.equal(runner.spawned[1]?.env.ANTHROPIC_AUTH_TOKEN, KEY);
  assert.equal(runner.spawned[1]?.envFromBox, undefined, 'no box Secret on the Magpie route');
  assert.equal(b.session.route, 'builtin');
  assert.equal(runner.spawned[4]?.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.deepEqual(runner.spawned[4]?.envFromBox, { CLAUDE_CODE_OAUTH_TOKEN: 'CLAUDE_TOKEN_1' });
});

test('box exec env goes over stdin, never in the exec request or a command line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'env-claude-'));
  const bin = join(dir, 'claude');
  await writeFile(
    bin,
    [
      '#!/bin/sh',
      'cat > /dev/null',
      `printf '%s|%s|%s' "$ANTHROPIC_AUTH_TOKEN" "$ANTHROPIC_BASE_URL" "\${ANTHROPIC_API_KEY-unset}" > ${dir}/seen`,
      `echo '${init}'`,
      `echo '${result('ok')}'`,
      '',
    ].join('\n'),
  );
  await chmod(bin, 0o755);
  const sandbox = new FakeSandbox();
  await boxWithRepo(sandbox, 'box-e');
  const requests: Array<{ cmd: string; env?: unknown; stdin?: string }> = [];
  const spy = Object.create(sandbox) as FakeSandbox;
  spy.exec = async (machineId, request) => {
    requests.push(request);
    return sandbox.exec(machineId, request);
  };
  const executor = new ClaudeCodeExecutor({
    env: ENV,
    bin,
    runner: new BoxProcessRunner(spy, { pollMs: 20 }),
    gateway: { baseUrl: 'https://magpie.example', token: KEY },
  });
  const ran = await driveTurn(
    await executor.start({
      workerId: 'w',
      ticket: 't',
      mandate: actMandate([]),
      workdir: BOX_REPO,
      systemPrompt: 'S',
      boxId: 'box-e',
    }),
  );
  assert.equal(ran.terminal.type, 'ready');
  assert.equal(await readFile(join(dir, 'seen'), 'utf8'), `${KEY}|https://magpie.example|`);
  assert.equal(
    requests.some((row) => row.env !== undefined),
    false,
    'Instabox drops exec env',
  );
  assert.equal(
    requests.some((row) => row.cmd.includes(KEY)),
    false,
  );
  assert.equal(
    requests.some((row) => row.stdin?.includes(KEY)),
    false,
    'stdin carries it encoded',
  );
});

test('a box run is found by an explicit marker inside an argument (Codex -o path)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slow-codex-'));
  const bin = join(dir, 'codex');
  await writeFile(bin, '#!/bin/sh\ncat > /dev/null\nsleep 5\n');
  await chmod(bin, 0o755);
  const sandbox = new FakeSandbox();
  await boxWithRepo(sandbox, 'box-m');
  const runner = new BoxProcessRunner(sandbox, { pollMs: 20, timeoutSeconds: 0.3 });
  const marker = 'maka-codex-0b9f3c1e-2d4a-4e8b-9c1d-123456789abc';
  const proc = runner.spawn({
    command: bin,
    args: ['exec', '-o', `/tmp/${marker}.txt`, '-'],
    marker,
    cwd: BOX_REPO,
    env: {},
    machineId: 'box-m',
  });
  proc.endInput();
  for await (const _line of proc.lines) {
    // no output
  }
  assert.equal((await proc.exited).signal, 'SIGTERM');
  assert.ok(sandbox.commands.some((row) => row.cmd.includes(`pkill -f -- ${marker}`)));
  assert.ok((runner.peakRssKb.get('box-m') ?? 0) > 0, 'sampled by the marker');
});

test('review fix: the gateway key is redacted from every event, not only no-result stderr', async () => {
  const runner = new ScriptedProcessRunner([
    () => ({
      lines: [init, assistant('m1', `using ${KEY}`), result(`done with ${KEY}`)],
      done: true,
    }),
    () => ({
      lines: [
        init,
        result(`bad key ${KEY}`, { subtype: 'error_during_execution', is_error: true }),
      ],
      done: true,
    }),
  ]);
  const executor = new ClaudeCodeExecutor({
    env: ENV,
    runner,
    gateway: { baseUrl: 'https://magpie.example', token: KEY },
  });
  const seen: ExecutorEvent[] = [];
  const first = await executor.start({
    workerId: 'w',
    ticket: 't',
    mandate: actMandate([]),
    workdir: '/tmp',
    systemPrompt: 'S',
  });
  const ok = await driveTurn(first, (row) => {
    seen.push(row);
  });
  const bad = await driveTurn(await executor.send(first.session, { kind: 'ci', text: 'x' }));
  const all = JSON.stringify([seen, ok.terminal, bad.terminal]);
  assert.equal(all.includes(KEY), false);
  assert.match(all, /\[ANTHROPIC_AUTH_TOKEN\]/);
});

test('review fix: box Secret values are filtered in the box, from stdout and stderr', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'leaky-claude-'));
  const bin = join(dir, 'claude');
  await writeFile(
    bin,
    [
      '#!/bin/sh',
      'cat > /dev/null',
      `echo '${init}'`,
      'printf \'{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"saw %s"}]}}\\n\' "$CLAUDE_CODE_OAUTH_TOKEN"',
      'echo "auth failed for $CLAUDE_CODE_OAUTH_TOKEN" >&2',
      'exit 3',
      '',
    ].join('\n'),
  );
  await chmod(bin, 0o755);
  const sandbox = new FakeSandbox();
  await boxWithRepo(sandbox, 'box-s');
  const before = process.env.CLAUDE_TOKEN_1;
  process.env.CLAUDE_TOKEN_1 = 'placeholder-from-box';
  try {
    const executor = new ClaudeCodeExecutor({
      env: ENV,
      bin,
      runner: new BoxProcessRunner(sandbox, { pollMs: 20 }),
      boxSecretEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'CLAUDE_TOKEN_1' },
    });
    const seen: ExecutorEvent[] = [];
    const ran = await driveTurn(
      await executor.start({
        workerId: 'w',
        ticket: 't',
        mandate: actMandate([]),
        workdir: BOX_REPO,
        systemPrompt: 'S',
        boxId: 'box-s',
      }),
      (row) => {
        seen.push(row);
      },
    );
    const all = JSON.stringify([seen, ran.terminal]);
    assert.equal(all.includes('placeholder-from-box'), false);
    assert.match(all, /saw \[CLAUDE_TOKEN_1\]/);
    assert.match(all, /auth failed for \[CLAUDE_TOKEN_1\]/);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_TOKEN_1;
    else process.env.CLAUDE_TOKEN_1 = before;
  }
});

test('review fix: a stop during setup never starts the CLI; a failed poll stops it', async () => {
  const sandbox = new FakeSandbox();
  await boxWithRepo(sandbox, 'box-k');
  const cmds: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = Object.create(sandbox) as FakeSandbox;
  slow.exec = async (machineId, request) => {
    cmds.push(request.cmd);
    if (request.cmd.includes('umask 077')) await gate;
    return sandbox.exec(machineId, request);
  };
  const id = '0b9f3c1e-2d4a-4e8b-9c1d-123456789abc';
  const spec = { command: 'sleep', args: ['5', id], cwd: BOX_REPO, env: {}, machineId: 'box-k' };
  const proc = new BoxProcessRunner(slow, { pollMs: 20 }).spawn(spec);
  proc.endInput();
  const reading = (async () => {
    for await (const _line of proc.lines) {
      // none
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 20));
  proc.kill();
  release();
  await reading;
  assert.equal(
    cmds.some((cmd) => cmd.includes('nohup')),
    false,
    'never started',
  );

  const flaky = Object.create(sandbox) as FakeSandbox;
  const sent: string[] = [];
  flaky.exec = async (machineId, request) => {
    sent.push(request.cmd);
    if (request.cmd.includes('--MAKA-OUT--')) throw new Error('exec 502');
    return sandbox.exec(machineId, request);
  };
  const lost = new BoxProcessRunner(flaky, { pollMs: 20 }).spawn(spec);
  lost.endInput();
  for await (const _line of lost.lines) {
    // none
  }
  assert.match((await lost.exited).stderr, /exec 502/);
  assert.ok(
    sent.some((cmd) => cmd.includes(`pkill -f -- ${id}`)),
    'the detached CLI is stopped',
  );
});

test('review fix: host CODEX_HOME never reaches the box; a stored Magpie route fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'home-codex-'));
  const bin = join(dir, 'codex');
  await writeFile(
    bin,
    `#!/bin/sh\ncat > /dev/null\nprintf '%s|%s' "$CODEX_HOME" "$MAKA_CLOUD_MAGPIE_KEY" > ${dir}/seen\n`,
  );
  await chmod(bin, 0o755);
  const sandbox = new FakeSandbox();
  await boxWithRepo(sandbox, 'box-h');
  const proc = new BoxProcessRunner(sandbox, { pollMs: 20 }).spawn({
    command: bin,
    args: [],
    cwd: BOX_REPO,
    env: { CODEX_HOME: '/Users/x/.codex', MAKA_CLOUD_MAGPIE_KEY: KEY },
    machineId: 'box-h',
  });
  proc.endInput();
  for await (const _line of proc.lines) {
    // none
  }
  assert.equal(await readFile(join(dir, 'seen'), 'utf8'), `|${KEY}`);

  const runner = new ScriptedProcessRunner([]);
  const executor = new ClaudeCodeExecutor({ env: ENV, runner });
  const stored = {
    sessionId: '0b9f3c1e-2d4a-4e8b-9c1d-123456789abc',
    kind: 'claude-code',
    workerId: 'w',
    workdir: '/tmp',
    systemPrompt: 'S',
    startedAt: 1,
    route: 'magpie',
  } as const;
  const ran = await driveTurn(await executor.resume({ ...stored }, 'note'));
  assert.equal(ran.terminal.type, 'failed');
  if (ran.terminal.type === 'failed') assert.match(ran.terminal.error, /Magpie route/);
  assert.equal(runner.spawned.length, 0, 'no fallback to the box login');
});

test('review round 2: the box filter ends on a value inside its own tag, and finds JSON-escaped and multi-line values', async () => {
  const sandbox = new FakeSandbox();
  await boxWithRepo(sandbox, 'box-j');
  const saved = { a: process.env.LOOPY_SECRET_A, b: process.env.ODD_SECRET_B };
  process.env.LOOPY_SECRET_A = 'LOOPY_SECRET_A';
  process.env.ODD_SECRET_B = 'pa"ss\\word\nline-two';
  try {
    const code = [
      'console.log(JSON.stringify({ a: process.env.A, b: process.env.B }));',
      'console.error("raw " + process.env.B);',
      'process.exit(4);',
    ].join(' ');
    const proc = new BoxProcessRunner(sandbox, { pollMs: 20 }).spawn({
      command: process.execPath,
      args: ['-e', code],
      cwd: BOX_REPO,
      env: {},
      envFromBox: { A: 'LOOPY_SECRET_A', B: 'ODD_SECRET_B' },
      machineId: 'box-j',
    });
    proc.endInput();
    const out: string[] = [];
    const reading = (async () => {
      for await (const line of proc.lines) out.push(line);
    })();
    await Promise.race([
      reading,
      new Promise((_, reject) => setTimeout(() => reject(new Error('filter hung')), 10_000)),
    ]);
    const exit = await proc.exited;
    assert.deepEqual(JSON.parse(out.join('')), { a: '[LOOPY_SECRET_A]', b: '[ODD_SECRET_B]' });
    assert.equal(exit.stderr.includes('line-two'), false);
    assert.match(exit.stderr, /raw \[ODD_SECRET_B\]/);
    assert.equal(exit.code, 4, 'the CLI exit code, not the filter one');
  } finally {
    for (const [name, value] of [
      ['LOOPY_SECRET_A', saved.a],
      ['ODD_SECRET_B', saved.b],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('review round 2: a stop during the start request still stops the CLI', async () => {
  const sandbox = new FakeSandbox();
  await boxWithRepo(sandbox, 'box-r');
  const id = '7c1e2a90-4b3d-4f6e-8a1b-0123456789ab';
  const sent: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = Object.create(sandbox) as FakeSandbox;
  slow.exec = async (machineId, request) => {
    sent.push(request.cmd);
    if (request.cmd.includes('nohup')) {
      await gate;
      const result = await sandbox.exec(machineId, request);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return result;
    }
    return sandbox.exec(machineId, request);
  };
  const proc = new BoxProcessRunner(slow, { pollMs: 20 }).spawn({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 20000)', id],
    cwd: BOX_REPO,
    env: {},
    machineId: 'box-r',
  });
  proc.endInput();
  const reading = (async () => {
    for await (const _line of proc.lines) {
      // none
    }
  })();
  while (!sent.some((cmd) => cmd.includes('nohup'))) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  proc.kill();
  release();
  await reading;
  const alive = spawnSync('pgrep', ['-f', id]);
  if (alive.status === 0) spawnSync('pkill', ['-f', id]);
  assert.notEqual(alive.status, 0, 'no CLI left running');
});
