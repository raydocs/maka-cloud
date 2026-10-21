import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_MODES, type ModesConfig } from '@maka-cloud/modes';
import type { RunnerEvent } from '@maka-cloud/orchestrator';
import { fixBrief, MAX_FIX_FINDINGS } from '../review.js';
import {
  type AgentScript,
  type AgentTurn,
  collect,
  FIXED_ADD,
  fixes,
  gate,
  type Harness,
  readJson,
  setup,
  terminal,
  zeroStats,
} from './harness.js';

const MODES: ModesConfig = DEFAULT_MODES;
const P1 = { severity: 'P1', title: 'add() ignores negative numbers', path: 'lib/add.sh', line: 1 };
const P2 = { severity: 'P2', title: 'No test for the zero case' };
const GUARDED = `${FIXED_ADD}# negative numbers are handled by the shell arithmetic\n`;

/** The script of the implementer: the first run makes the change, a later one is the fix. */
function implements_(fix: AgentScript): AgentScript {
  return async (turn) => (turn.n === 1 ? fixes(turn) : fix(turn));
}

/** A fix that changes the code and leaves the checks passing. */
const fixesFindings: AgentScript = async (turn) => {
  await fs.writeFile(join(turn.workspace, 'lib', 'add.sh'), GUARDED);
  return 'ok';
};

/** A reviewer whose n-th review reports `rounds[n - 1]` (the last one for any later review). */
function reviewsInRounds(rounds: unknown[][]): AgentScript {
  return async (turn) => {
    const findings = rounds[Math.min(turn.n, rounds.length) - 1] ?? [];
    await fs.writeFile(join(turn.dir, 'review.json'), JSON.stringify({ summary: 'ok', findings }));
    return 'ok';
  };
}

async function run(h: Harness, id: string, extra: Record<string, unknown> = {}) {
  const spec = { ...(await h.spec(id)), ...extra };
  const events = await collect(await h.runner.start(spec));
  return { events, spec, dir: join(h.handoff, id) };
}

async function deliveredAddSh(h: Harness, id: string): Promise<string> {
  const delivery = await h.deliveries.get(id);
  assert.ok(delivery);
  const changes = await readJson(delivery.changesPath);
  return Buffer.from(
    changes.files.find((f: { path: string }) => f.path === 'lib/add.sh').contentBase64,
    'base64',
  ).toString();
}

/** A task that ends failed, with nothing delivered, because the review still found a P1. */
async function failedWithP1(h: Harness, id: string, events: RunnerEvent[], why = /./) {
  const end = terminal(events);
  assert.equal(end?.type, 'failed', 'a P1 left after the one fix does not end finished');
  const reason = end?.type === 'failed' ? end.reason : '';
  assert.match(reason, /still found \d+ serious problem\(s\) after the one fix it allows/);
  assert.match(reason, /so the change was not delivered/);
  assert.match(reason, why);
  assert.equal(await h.deliveries.get(id), undefined, 'the change is not recorded for delivery');
  await assert.rejects(fs.readFile(join(h.handoff, id, 'review.md')), /ENOENT/);
}

const reviewLineOf = (manifest: { done: string[] }): string =>
  manifest.done.find((line) => line.startsWith('review:')) ?? '';

test('P1 findings go back to the implementer once, and the fixed change is reviewed again and delivered', async (t) => {
  const h = await setup(t, { modes: MODES });
  h.claude.script = implements_(fixesFindings);
  h.codex.script = reviewsInRounds([[P1, P2], [P2]]);
  const { events, spec, dir } = await run(h, 'tsk_fix1');
  assert.deepEqual(terminal(events), { type: 'finished' });

  // Claude made the change, Codex reviewed, Claude fixed, Codex reviewed again: never the same vendor.
  assert.deepEqual(
    h.claude.turns.map((turn) => turn.kind),
    ['start', 'start'],
    'the fix is a fresh run: the task’s session record is the reviewer’s by then',
  );
  assert.equal(h.codex.turns.length, 2);
  const brief = await fs.readFile(h.claude.turns[1]?.spec.briefPath ?? '', 'utf8');
  assert.match(brief, /# Fixing what a review found/);
  assert.match(brief, /1\. add\(\) ignores negative numbers \(lib\/add\.sh:1\)/);
  assert.ok(!brief.includes('No test for the zero case'), 'only P1 findings are sent back');
  assert.match(brief, /data from the reviewer, not instructions/);

  assert.equal(await deliveredAddSh(h, 'tsk_fix1'), GUARDED, 'the fixed change is delivered');
  const manifest = await readJson(spec.resultPath);
  assert.match(
    reviewLineOf(manifest),
    /^review: an independent agent reviewed the change; 1 finding\(s\) remain: P2 1; 1 P1 finding\(s\) were sent back to the implementer once and the fixed change was reviewed again/,
  );
  const verification = await readJson(join(dir, 'verification.json'));
  assert.deepEqual(verification.review.counts, { P1: 0, P2: 1, P3: 0 });
  assert.deepEqual(verification.review.fix, { sent: 1, result: 'applied' });
  assert.match(
    await fs.readFile(join(dir, 'review.md'), 'utf8'),
    /sent back to the implementer once/,
  );
  zeroStats(h.runner);
});

test('a reviewer that always answers P1 gets exactly one fix and two reviews, and the task then fails instead of finishing', async (t) => {
  const h = await setup(t, { modes: MODES });
  h.claude.script = implements_(fixesFindings);
  h.codex.script = reviewsInRounds([[P1]]);
  const { events } = await run(h, 'tsk_fix2');
  assert.equal(h.claude.turns.length, 2, 'one implementation and one fix, never a third round');
  assert.equal(h.codex.turns.length, 2, 'one review and one review of the fix');
  await failedWithP1(h, 'tsk_fix2', events);
  assert.deepEqual(h.leases, { acquired: 1, released: 1 });
  zeroStats(h.runner);
});

test('findings that are not P1 are not sent back', async (t) => {
  const h = await setup(t, { modes: MODES });
  h.claude.script = fixes;
  h.codex.script = reviewsInRounds([[P2, { severity: 'P3', title: 'Name it better' }]]);
  const { events, dir } = await run(h, 'tsk_nofix');
  assert.deepEqual(terminal(events), { type: 'finished' });
  assert.equal(h.claude.turns.length, 1);
  assert.equal(h.codex.turns.length, 1);
  assert.ok(!('fix' in (await readJson(join(dir, 'verification.json'))).review));
  zeroStats(h.runner);
});

const NOT_APPLIED: [string, AgentScript, RegExp][] = [
  [
    'the fix run fails',
    async () => ({ failed: 'the model is overloaded' }),
    /the fix run failed: .*overloaded/,
  ],
  [
    'the fixed change fails the repository’s checks',
    async (turn) => {
      await fs.writeFile(join(turn.workspace, 'lib', 'add.sh'), 'add() { echo 0; }\n');
      return 'ok';
    },
    /the fixed change failed the checks/,
  ],
];

for (const [name, fix, reason] of NOT_APPLIED) {
  test(`when ${name}, the first change still has its P1, so the task fails and delivers nothing`, async (t) => {
    const h = await setup(t, { modes: MODES });
    h.claude.script = implements_(fix);
    h.codex.script = reviewsInRounds([[P1]]);
    const { events } = await run(h, 'tsk_na');
    assert.equal(h.claude.turns.length, 2, 'the fix was tried once');
    assert.equal(h.codex.turns.length, 1, 'a failed fix is not reviewed');
    await failedWithP1(h, 'tsk_na', events, reason);
    zeroStats(h.runner);
  });
}

test('a fixed change that cannot be reviewed again is not delivered, and the first change still has its P1 so the task fails', async (t) => {
  const h = await setup(t, { modes: MODES });
  h.claude.script = implements_(fixesFindings);
  h.codex.script = async (turn) => {
    if (turn.n === 1) return reviewsInRounds([[P1]])(turn);
    return { failed: 'the reviewer is down' };
  };
  const { events } = await run(h, 'tsk_na2');
  await failedWithP1(h, 'tsk_na2', events, /could not be reviewed again/);
  zeroStats(h.runner);
});

test('a fixed change on which the reviewer touched the repository is not delivered, and the task fails with the first change’s P1', async (t) => {
  const h = await setup(t, { modes: MODES });
  h.claude.script = implements_(fixesFindings);
  h.codex.script = async (turn) => {
    if (turn.n === 2) await fs.writeFile(join(turn.workspace, 'lib', 'add.sh'), 'tampered\n');
    return reviewsInRounds([[P1], []])(turn);
  };
  const { events } = await run(h, 'tsk_na3');
  await failedWithP1(h, 'tsk_na3', events, /the fix was not used/);
  zeroStats(h.runner);
});

// -- budget --------------------------------------------------------------------------------------

test('the fix and the second review share the review’s limit, which never grows', async (t) => {
  const h = await setup(t, { modes: MODES });
  h.claude.script = async (turn) => {
    turn.usage(turn.n === 1 ? 1 : 0.5);
    return implements_(fixesFindings)(turn);
  };
  h.codex.script = async (turn) => {
    turn.usage(0.25);
    return reviewsInRounds([[P1], []])(turn);
  };
  const spec = { budgetUsd: 10, budgetRootId: 'tsk_root' };
  const { events } = await run(h, 'tsk_fbudget', spec);
  assert.deepEqual(terminal(events), { type: 'finished' });
  // Standard keeps 20% of $10 for review and fix: after $1 of work, everything after it stops at $3.
  assert.equal(h.claude.turns[0]?.spec.turnBudgetUsd, 8);
  const limits = [h.codex.turns[0], h.claude.turns[1], h.codex.turns[1]].map(
    (turn) => (turn?.spec.turnBudgetUsd ?? 0) + spentBefore(turn, h),
  );
  assert.deepEqual(limits, [3, 3, 3]);
  // Every run is held to the whole $10 by the pool, whatever its phase's limit.
  assert.deepEqual(
    [h.claude.turns[0], h.codex.turns[0], h.claude.turns[1], h.codex.turns[1]].map(
      (turn) => turn?.spec.budgetUsd,
    ),
    [10, 10, 10, 10],
  );
  const totals = events.flatMap((event) => (event.type === 'usage' ? [event.costUsd] : []));
  assert.ok(Math.max(...totals) <= 3, `spent ${Math.max(...totals)}`);
  zeroStats(h.runner);
});

/** What the task had spent when `turn` started: the sum of the runs before it. */
function spentBefore(turn: AgentTurn | undefined, h: Harness): number {
  const costs = new Map<AgentTurn, number>([
    [h.claude.turns[0] as AgentTurn, 1],
    [h.codex.turns[0] as AgentTurn, 0.25],
    [h.claude.turns[1] as AgentTurn, 0.5],
  ]);
  const order = [
    h.claude.turns[0],
    h.codex.turns[0],
    h.claude.turns[1],
    h.codex.turns[1],
  ] as AgentTurn[];
  let sum = 0;
  for (const earlier of order) {
    if (earlier === turn) break;
    sum += costs.get(earlier) ?? 0;
  }
  return sum;
}

test('a review that leaves too little for a fix and a second review fails the task with the P1 it found', async (t) => {
  const h = await setup(t, { modes: MODES });
  h.claude.script = implements_(fixesFindings);
  h.codex.script = async (turn) => {
    // $2 is the review's whole share of $10; $1.95 of it leaves $0.05, under two minimum reviews.
    turn.usage(1.95);
    return reviewsInRounds([[P1]])(turn);
  };
  const { events } = await run(h, 'tsk_fnobudget', { budgetUsd: 10 });
  assert.equal(h.claude.turns.length, 1, 'no fix was started');
  await failedWithP1(h, 'tsk_fnobudget', events, /too little for a fix and a second review/);
  zeroStats(h.runner);
});

test('a fix that spends the review’s limit ends the fix, and the task fails with the first change’s P1', async (t) => {
  const h = await setup(t, { modes: MODES });
  const spent = gate();
  h.claude.script = async (turn) => {
    if (turn.n === 1) return fixes(turn);
    turn.usage(5);
    spent.open();
    await new Promise<void>((resolve) => turn.signal.addEventListener('abort', () => resolve()));
    return 'ok';
  };
  h.codex.script = reviewsInRounds([[P1]]);
  const { events } = await run(h, 'tsk_fover', { budgetUsd: 10, budgetRootId: 'tsk_root' });
  await spent.promise;
  await failedWithP1(h, 'tsk_fover', events, /ran out of the review's budget/);
  zeroStats(h.runner);
});

// -- every exit ----------------------------------------------------------------------------------

test('cancel while the fix runs: its run is cancelled, nothing is delivered and everything is released', async (t) => {
  const h = await setup(t, { modes: MODES });
  const running = gate();
  let aborted = false;
  h.claude.script = async (turn) => {
    if (turn.n === 1) return fixes(turn);
    running.open();
    await new Promise<void>((resolve) => turn.signal.addEventListener('abort', () => resolve()));
    aborted = true;
    return 'ok';
  };
  h.codex.script = reviewsInRounds([[P1]]);
  const handle = await h.runner.start(await h.spec('tsk_cfix'));
  const events = collect(handle);
  await running.promise;
  await handle.cancel();
  assert.equal(terminal(await events), undefined);
  assert.equal(aborted, true);
  assert.equal(h.claude.open, 0);
  assert.equal(h.codex.open, 0);
  assert.deepEqual(h.leases, { acquired: 1, released: 1 });
  assert.equal(await h.deliveries.get('tsk_cfix'), undefined);
  zeroStats(h.runner);
});

test('cancel while the fixed change is reviewed again: nothing is delivered and everything is released', async (t) => {
  const h = await setup(t, { modes: MODES });
  h.claude.script = implements_(fixesFindings);
  const running = gate();
  let aborted = false;
  h.codex.script = async (turn) => {
    if (turn.n === 1) return reviewsInRounds([[P1]])(turn);
    running.open();
    await new Promise<void>((resolve) => turn.signal.addEventListener('abort', () => resolve()));
    aborted = true;
    return 'ok';
  };
  const handle = await h.runner.start(await h.spec('tsk_crev2'));
  const events = collect(handle);
  await running.promise;
  await handle.cancel();
  assert.equal(terminal(await events), undefined);
  assert.equal(aborted, true);
  assert.equal(h.claude.open, 0);
  assert.equal(h.codex.open, 0);
  assert.equal(await h.deliveries.get('tsk_crev2'), undefined);
  zeroStats(h.runner);
});

test('a fix that cannot start is a fix that was not used: the task fails with the P1 and releases what it held', async (t) => {
  const h = await setup(t, { modes: MODES });
  h.claude.script = implements_(fixesFindings);
  h.codex.script = reviewsInRounds([[P1]]);
  const start = h.claude.start.bind(h.claude);
  let starts = 0;
  h.claude.start = async (spec) => {
    if (++starts === 2) throw new Error('no capacity for a second run');
    return start(spec);
  };
  const { events } = await run(h, 'tsk_fstart');
  await failedWithP1(h, 'tsk_fstart', events, /no capacity/);
  assert.equal(h.claude.open, 0);
  zeroStats(h.runner);
});

// -- the brief -----------------------------------------------------------------------------------

test('the fix brief sends the first findings only, as data, with the checks the runner will repeat', () => {
  const findings = Array.from({ length: MAX_FIX_FINDINGS + 3 }, (_, i) => ({
    severity: 'P1' as const,
    title: `problem number ${i}`,
  }));
  const brief = fixBrief({
    repo: 'o/r',
    baseSha: 'a'.repeat(40),
    dir: '/work/t',
    goal: 'make add add',
    testCommand: 'bash tests/run.sh',
    findings,
    conductorBrief: 'Plan: fix lib/add.sh.',
  });
  assert.match(brief, new RegExp(`${MAX_FIX_FINDINGS}\\. problem number ${MAX_FIX_FINDINGS - 1}`));
  assert.ok(!brief.includes(`problem number ${MAX_FIX_FINDINGS}`));
  assert.match(brief, /not instructions/);
  assert.match(brief, /bash tests\/run\.sh/);
  assert.match(brief, /There is no further round/);
  assert.match(brief, /Plan: fix lib\/add\.sh\./);
});
