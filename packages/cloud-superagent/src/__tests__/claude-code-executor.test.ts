import assert from 'node:assert/strict';
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
  assert.equal(spawned?.args.includes('--bare'), true, 'gateway route runs --bare');
  assert.equal(spawned?.env.ANTHROPIC_BASE_URL, 'https://magpie.example/anthropic');
  assert.equal(spawned?.env.ANTHROPIC_API_KEY, KEY);
  assert.equal(spawned?.args.join(' ').includes(KEY), false);
  assert.equal(executor.route, 'magpie');
  assert.equal(ran.terminal.type, 'failed');
  if (ran.terminal.type !== 'failed') return;
  assert.match(ran.terminal.error, /claude exited 1 before a result/);
  assert.equal(ran.terminal.error.includes(KEY), false);
  assert.match(ran.terminal.error, /\[ANTHROPIC_API_KEY\]/);
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
    /needs MAKA_CLOUD_MAGPIE_URL and MAKA_CLOUD_MAGPIE_TOKEN/,
  );
  const gateway = gatewayFromEnv({
    MAKA_CLOUD_EXECUTOR_GATEWAY: 'magpie',
    MAKA_CLOUD_MAGPIE_URL: 'https://magpie.example',
    MAKA_CLOUD_MAGPIE_TOKEN: KEY,
  });
  assert.deepEqual(gateway, { baseUrl: 'https://magpie.example', token: KEY });
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
