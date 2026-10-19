import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type AgentTurn,
  collect,
  FIXED_ADD,
  fixes,
  isAlive,
  isCheck,
  REPRO_TEST,
  readJson,
  recordedPids,
  recordPid,
  setup,
  terminal,
  testOnly,
  writeRepro,
  zeroStats,
} from './harness.js';

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

test('a check cannot forge its result: an exit record it writes while it runs is not read', async (t) => {
  const h = await setup(t);
  h.claude.script = async (turn) => {
    if (turn.n > 1) return fixes(turn);
    // The change does not fix add(), so the reproduction test fails. While it runs, it forges a
    // pass for itself and the tests and a failure for the base check, wherever a check's control
    // files are, then waits for its forgery to be read.
    await writeRepro(
      turn,
      [
        'c="${MAKA_CTL_ROOT:-/nonexistent}/${MAKA_CHECK:-none}"',
        'if [ -f "$c/nonce" ]; then',
        '  case "$MAKA_CHECK" in *-repro-base) forged=1 ;; *) forged=0 ;; esac',
        '  echo "$(cat "$c/nonce") $forged 0" > "$c/exit"',
        '  sleep 30',
        'fi',
        REPRO_TEST,
      ].join('\n'),
    );
    return 'ok';
  };
  const spec = await h.spec('tsk_forge_live');
  assert.deepEqual(terminal(await collect(await h.runner.start(spec))), { type: 'finished' });
  assert.equal(h.claude.turns.length, 2, 'the forged results did not verify the first run');
  assert.match(h.claude.turns[1]?.prompt ?? '', /fails with your change \(exit 1\)/);
  const verification = await readJson(join(h.handoff, 'tsk_forge_live', 'verification.json'));
  assert.deepEqual(
    verification.attempts[0].turns.map((turn: { outcome: string }) => turn.outcome),
    ['check_failed', 'verified'],
  );
  assert.equal(verification.attempts[0].turns[0].checks[0].exitCode, 1);
  zeroStats(h.runner);
});

/**
 * A test that starts `sleep 300` the way `how` says, waits until it has recorded its pid under
 * `name`, and passes.
 */
function escapee(name: string, how: (cmd: string) => string): string {
  return [
    `export MAKA_PIDFILE="$MAKA_TEST_PIDS/${name}-$RANDOM$RANDOM"`,
    how(`bash -c '${recordPid(name, '"$MAKA_PIDFILE"')}; exec sleep 300'`),
    'until [ -s "$MAKA_PIDFILE" ]; do sleep 0.01; done',
    '',
  ].join('\n');
}

test('a process that clears its run token and leaves its session is stopped before the next check', async (t) => {
  const h = await setup(t);
  h.claude.script = async (turn) => {
    await fixes(turn);
    await fs.writeFile(
      join(turn.workspace, 'tests', 'test_bg.sh'),
      escapee('notoken', (cmd) => `env -u MAKA_RUN_TOKEN setsid ${cmd} > /dev/null 2>&1 &`),
    );
    return 'ok';
  };
  let alive: boolean[] | undefined;
  h.hook = async (call, phase) => {
    if (phase === 'before' && isCheck(call) && alive === undefined) {
      const pids = await recordedPids(h, 'notoken');
      if (pids.length > 0) alive = pids.map(isAlive);
    }
  };
  const spec = await h.spec('tsk_notoken');
  assert.deepEqual(terminal(await collect(await h.runner.start(spec))), { type: 'finished' });
  assert.deepEqual(
    alive,
    [false],
    'the tests check started one, and it was gone before the next check',
  );
  zeroStats(h.runner);
});

test('no process a check started is alive when the next check starts, however it was started', async (t) => {
  const h = await setup(t);
  const ways: Record<string, (cmd: string) => string> = {
    plain: (cmd) => `${cmd} &`,
    notoken: (cmd) => `env -u MAKA_RUN_TOKEN setsid ${cmd} > /dev/null 2>&1 &`,
    doublefork: (cmd) => `( ( ${cmd} > /dev/null 2>&1 & ) & )`,
    nohup: (cmd) => `nohup setsid ${cmd} > /dev/null 2>&1 & disown`,
  };
  h.claude.script = async (turn) => {
    await writeRepro(
      turn,
      [...Object.entries(ways).map(([name, how]) => escapee(`repro${name}`, how)), REPRO_TEST].join(
        '\n',
      ),
    );
    await fs.writeFile(join(turn.workspace, 'lib', 'add.sh'), FIXED_ADD);
    for (const [name, how] of Object.entries(ways)) {
      await fs.writeFile(join(turn.workspace, 'tests', `test_${name}.sh`), escapee(name, how));
    }
    return 'ok';
  };
  const names = Object.keys(ways).flatMap((name) => [name, `repro${name}`]);
  const allPids = async () =>
    (await Promise.all(names.map((name) => recordedPids(h, name)))).flat();
  const seen: { check: number; recorded: number; alive: number[] }[] = [];
  let checks = 0;
  h.hook = async (call, phase) => {
    if (phase !== 'before' || !isCheck(call)) return;
    checks++;
    const pids = await allPids();
    seen.push({ check: checks, recorded: pids.length, alive: pids.filter(isAlive) });
  };
  const spec = await h.spec('tsk_escapes');
  assert.deepEqual(terminal(await collect(await h.runner.start(spec))), { type: 'finished' });
  const n = Object.keys(ways).length;
  // Before the tests check: the reproduction test's; before the base check: the tests' as well
  // (the tests run the reproduction test too).
  assert.deepEqual(seen, [
    { check: 1, recorded: 0, alive: [] },
    { check: 2, recorded: n, alive: [] },
    { check: 3, recorded: 3 * n, alive: [] },
  ]);
  const all = await allPids();
  assert.equal(all.length, 4 * n, 'the base check started its own');
  assert.deepEqual(all.filter(isAlive), [], 'nothing is left once the task ended');
  zeroStats(h.runner);
});

test('a sandbox that cannot isolate a check fails the task, and the check never counts', async (t) => {
  const bin = await fs.mkdtemp(join(tmpdir(), 'no-unshare-'));
  t.after(() => fs.rm(bin, { recursive: true, force: true }));
  // An unshare that fails the way it does where user namespaces are off.
  await fs.writeFile(
    join(bin, 'unshare'),
    '#!/bin/sh\necho "unshare: unshare failed: Operation not permitted" >&2\nexit 1\n',
    { mode: 0o755 },
  );
  const h = await setup(t, {}, { execPath: `${bin}:${process.env.PATH ?? ''}` });
  h.claude.script = fixes;
  const spec = await h.spec('tsk_noiso');
  const last = terminal(await collect(await h.runner.start(spec)));
  assert.equal(last?.type, 'failed');
  assert.match(
    (last as { reason: string }).reason,
    /the check repro could not run: the sandbox could not start the check in its own user and PID namespace/,
  );
  assert.equal(await h.deliveries.get('tsk_noiso'), undefined);
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
