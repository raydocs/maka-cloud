import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CHECK_START_SCRIPT } from '../scripts.js';
import {
  type AgentTurn,
  collect,
  FIXED_ADD,
  fixes,
  isAlive,
  readJson,
  setup,
  terminal,
  testOnly,
  writeRepro,
  zeroStats,
} from './harness.js';

async function pidsOf(dir: string, prefix: string): Promise<number[]> {
  const names = (await fs.readdir(dir)).filter((name) => name.startsWith(prefix));
  return Promise.all(
    names.map(async (name) => Number((await fs.readFile(join(dir, name), 'utf8')).trim())),
  );
}

test('check results the agent wrote ahead of time are ignored: every check really runs', async (t) => {
  const h = await setup(t);
  h.claude.script = async (turn) => {
    if (turn.n > 1) return fixes(turn);
    // The reproduction test fails with this change, and the agent forges passing results.
    await testOnly(turn);
    const forged: [string, number][] = [
      ['check-1-repro', 0],
      ['check-2-tests', 0],
      ['check-3-repro-base', 1],
    ];
    for (const [name, code] of forged) {
      await fs.writeFile(join(turn.dir, `${name}.started`), '');
      await fs.writeFile(join(turn.dir, `${name}.exit`), `${code}\n`);
    }
    return 'ok';
  };
  const spec = await h.spec('tsk_forged');
  assert.deepEqual(terminal(await collect(await h.runner.start(spec))), { type: 'finished' });
  assert.equal(h.claude.turns.length, 2, 'the forged results did not verify the first run');
  assert.match(h.claude.turns[1]?.prompt ?? '', /fails with your change \(exit 1\)/);
  const verification = await readJson(join(h.handoff, 'tsk_forged', 'verification.json'));
  assert.deepEqual(
    verification.attempts[0].turns.map((turn: { outcome: string }) => turn.outcome),
    ['check_failed', 'verified'],
  );
  zeroStats(h.runner);
});

test('a check launch refuses state it did not create, and a retried launch starts nothing new', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'check-launch-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(join(dir, 'workspace'));
  const launch = (nonce: string) =>
    execFileSync('bash', ['-c', CHECK_START_SCRIPT], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        MAKA_DIR: dir,
        MAKA_CTL_ROOT: join(dir, 'control'),
        MAKA_CHECK: 'check-1-abc-repro',
        MAKA_NONCE: nonce,
        MAKA_CWD: join(dir, 'workspace'),
        MAKA_CMD: 'echo ran >> ../runs',
        MAKA_TIMEOUT: '10',
        MAKA_RUN_TOKEN: 'tok',
      },
    }).trim();
  assert.equal(launch('n1'), 'STARTED');
  assert.equal(launch('n1'), 'ALREADY');
  assert.equal(launch('n2'), 'EXISTS');
  // A pid file the launch did not write is refused too.
  await fs.writeFile(join(dir, 'check-2-abc-tests.pid'), '1\n');
  const other = execFileSync('bash', ['-c', CHECK_START_SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      MAKA_DIR: dir,
      MAKA_CTL_ROOT: join(dir, 'control'),
      MAKA_CHECK: 'check-2-abc-tests',
      MAKA_NONCE: 'n3',
      MAKA_CWD: join(dir, 'workspace'),
      MAKA_CMD: 'true',
      MAKA_TIMEOUT: '10',
      MAKA_RUN_TOKEN: 'tok',
    },
  }).trim();
  assert.equal(other, 'EXISTS');
});

/** A reproduction test that passes when add() is fixed and does `onBase` otherwise. */
async function reproThatOnBase(turn: AgentTurn, onBase: string): Promise<void> {
  await writeRepro(turn, `source lib/add.sh\n[ "$(add 2 3)" = 5 ] && exit 0\n${onBase}\n`);
  await fs.writeFile(join(turn.workspace, 'lib', 'add.sh'), FIXED_ADD);
}

for (const [label, onBase, why] of [
  ['times out', 'while :; do sleep 0.05; done', /timed out/],
  ['is killed by a signal', 'kill -9 $$', /killed by signal 9/],
  ['cannot run its command', 'no-such-command-here', /could not run \(exit 127\)/],
] as const) {
  test(`a reproduction test that ${label} on the base commit does not prove the failure`, async (t) => {
    const h = await setup(t, { limits: { checkTimeoutMs: 1_000 } });
    h.claude.script = async (turn) =>
      turn.n === 1 ? (await reproThatOnBase(turn, onBase), 'ok') : fixes(turn);
    const spec = await h.spec('tsk_base');
    assert.deepEqual(terminal(await collect(await h.runner.start(spec))), { type: 'finished' });
    assert.equal(h.claude.turns.length, 2, 'the first run was not taken as verified');
    assert.match(h.claude.turns[1]?.prompt ?? '', why);
    const verification = await readJson(join(h.handoff, 'tsk_base', 'verification.json'));
    assert.deepEqual(
      verification.attempts[0].turns.map((turn: { outcome: string }) => turn.outcome),
      ['check_failed', 'verified'],
    );
    zeroStats(h.runner);
  });
}

test('a process a passing check leaves behind is stopped when that check ends', async (t) => {
  const h = await setup(t);
  h.claude.script = async (turn) => {
    await fixes(turn);
    // One of the repository's tests passes and leaves a process running.
    await fs.writeFile(
      join(turn.workspace, 'tests', 'test_bg.sh'),
      'sleep 300 &\necho $! > "$MAKA_TEST_PIDS/bg-$RANDOM"\n',
    );
    return 'ok';
  };
  let before: number[] | undefined;
  h.hook = async (call, phase) => {
    if (
      phase === 'before' &&
      call.script === CHECK_START_SCRIPT &&
      call.envs.MAKA_CHECK?.endsWith('repro-base')
    ) {
      before = await pidsOf(h.pids, 'bg-');
    }
  };
  const spec = await h.spec('tsk_bg');
  assert.deepEqual(terminal(await collect(await h.runner.start(spec))), { type: 'finished' });
  assert.equal(before?.length, 1, 'the tests check left one process');
  assert.equal(isAlive(before?.[0] ?? 0), false, 'it was stopped before the next check');
  zeroStats(h.runner);
});

test('a repair run gets the same brief as the first run', async (t) => {
  const h = await setup(t);
  h.claude.script = async (turn) => (turn.n === 1 ? testOnly(turn) : fixes(turn));
  const spec = await h.spec('tsk_rebrief');
  assert.deepEqual(terminal(await collect(await h.runner.start(spec))), { type: 'finished' });
  const [first, second] = h.claude.turns;
  assert.equal(second?.kind, 'resume');
  assert.equal(
    await fs.readFile(second?.spec.briefPath ?? '', 'utf8'),
    await fs.readFile(first?.spec.briefPath ?? '', 'utf8'),
  );
});
