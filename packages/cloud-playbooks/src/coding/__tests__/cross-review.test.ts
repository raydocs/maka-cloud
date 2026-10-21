import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_MODES, type ModesConfig } from '@maka-cloud/modes';
import { pullRequestBody } from '../pull-request.js';
import { READ_SMALL_SCRIPT } from '../scripts.js';
import {
  type AgentScript,
  collect,
  FIXED_ADD,
  fixes,
  gate,
  type Harness,
  readJson,
  setup,
  terminal,
  testOnly,
  zeroStats,
} from './harness.js';

const MODES: ModesConfig = DEFAULT_MODES;

const FINDINGS = [
  { severity: 'P2', title: 'No test for the zero case', path: 'lib/add.sh', line: 1 },
  { severity: 'P3', title: 'Name the function better' },
];

/** A reviewer that writes `review.json` with these findings. */
function reviews(findings: unknown[] = FINDINGS, summary = 'Looks right.'): AgentScript {
  return async (turn) => {
    await fs.writeFile(join(turn.dir, 'review.json'), JSON.stringify({ summary, findings }));
    return 'ok';
  };
}

async function finished(h: Harness, id: string, extra: Record<string, unknown> = {}) {
  const spec = {
    ...(await h.spec(id, extra.block as Record<string, unknown> | undefined)),
    ...(extra.spec as object),
  };
  const events = await collect(await h.runner.start(spec));
  return { events, spec, dir: join(h.handoff, id) };
}

test('the other vendor reviews a change, and the review is part of what is delivered', async (t) => {
  const h = await setup(t, { modes: MODES });
  h.claude.script = fixes;
  h.codex.script = reviews();
  const { events, spec, dir } = await finished(h, 'tsk_rev1');
  assert.deepEqual(terminal(events), { type: 'finished' });

  // Claude implemented, so Codex reviewed: never the same vendor.
  assert.equal(h.claude.turns.length, 1);
  assert.equal(h.codex.turns.length, 1);
  assert.equal(h.codex.turns[0]?.kind, 'start');
  assert.equal(h.codex.turns[0]?.spec.runner, 'codex');
  // Each role runs with the model and effort its mode gives it.
  assert.deepEqual(
    [h.claude.turns[0]?.spec.model, h.claude.turns[0]?.spec.effort],
    ['claude-sonnet-5-5', 'high'],
  );
  assert.deepEqual(
    [h.codex.turns[0]?.spec.model, h.codex.turns[0]?.spec.effort],
    [undefined, 'medium'],
  );

  const brief = await fs.readFile(h.codex.turns[0]?.spec.briefPath ?? '', 'utf8');
  assert.match(brief, /# Review of a change/);
  assert.match(brief, /add\(\) subtracts; make it add\./);
  assert.match(brief, /Plan: write a failing test/);
  assert.match(brief, /Read only\./);

  const manifest = await readJson(spec.resultPath);
  const lines: string[] = manifest.done.filter((line: string) => line.startsWith('review:'));
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /2 finding\(s\) remain: P2 1, P3 1 \(see review\.md\)/);
  assert.ok(manifest.artifacts.includes('review.md'));
  assert.match(
    await fs.readFile(join(dir, 'review.md'), 'utf8'),
    /## P2 \(1\)\n\n- No test for the zero case \(lib\/add\.sh:1\)/,
  );
  const verification = await readJson(join(dir, 'verification.json'));
  assert.equal(verification.review.status, 'reviewed');
  assert.equal(verification.review.mode, 'standard');
  assert.equal(verification.review.modesVersion, 1);
  assert.deepEqual(verification.review.counts, { P1: 0, P2: 1, P3: 1 });
  // The record holds the hash of review.md, not the findings: the supervisor ties the two together.
  assert.equal(
    verification.review.reviewSha256,
    createHash('sha256')
      .update(await fs.readFile(join(dir, 'review.md')))
      .digest('hex'),
  );
  assert.ok(!('findings' in verification.review));
  // The delivered change is the implementer's, untouched by the review.
  const delivery = await h.deliveries.get('tsk_rev1');
  assert.ok(delivery);
  const changes = await readJson(delivery.changesPath);
  assert.equal(
    Buffer.from(
      changes.files.find((f: { path: string }) => f.path === 'lib/add.sh').contentBase64,
      'base64',
    ).toString(),
    FIXED_ADD,
  );
  assert.match(
    pullRequestBody(verification),
    /\*\*Reviewed by a second agent: 2 finding\(s\) remain \(P2 1, P3 1\)\. They are on the task page\.\*\*/,
  );
  zeroStats(h.runner);
});

test('when Codex implements, Claude reviews, with the reviewing vendor’s model and effort', async (t) => {
  const h = await setup(t, { modes: MODES });
  h.codex.script = fixes;
  h.claude.script = reviews([]);
  const { events, spec } = await finished(h, 'tsk_rev2', { block: { runner: 'codex' } });
  assert.deepEqual(terminal(events), { type: 'finished' });
  assert.equal(h.codex.turns.length, 1);
  assert.equal(h.claude.turns.length, 1);
  assert.equal(h.claude.turns[0]?.spec.runner, 'claude-agent-sdk');
  assert.deepEqual(
    [h.claude.turns[0]?.spec.model, h.claude.turns[0]?.spec.effort],
    ['claude-opus-5-5', 'medium'],
  );
  const manifest = await readJson(spec.resultPath);
  assert.ok(
    manifest.done.includes(
      'review: an independent agent reviewed the change and reported no findings (see review.md)',
    ),
  );
  zeroStats(h.runner);
});

test('after a handover the vendor that made the change is the one the other vendor reviews', async (t) => {
  const h = await setup(t, { modes: MODES });
  h.claude.script = async (turn) => (turn.n <= 2 ? testOnly(turn) : reviews([])(turn));
  h.codex.script = fixes;
  const { events } = await finished(h, 'tsk_rev3');
  assert.deepEqual(terminal(events), { type: 'finished' });
  // Claude failed twice, Codex made the change, so Claude is the reviewer (its third run).
  assert.equal(h.codex.turns.length, 1);
  assert.equal(h.claude.turns.length, 3);
  assert.equal(h.claude.turns[2]?.kind, 'start');
  assert.match(
    await fs.readFile(h.claude.turns[2]?.spec.briefPath ?? '', 'utf8'),
    /# Review of a change/,
  );
  zeroStats(h.runner);
});

test('the mode in the brief picks the roles, and an unknown mode is refused', async (t) => {
  const h = await setup(t, { modes: MODES });
  h.claude.script = fixes;
  h.codex.script = reviews([]);
  const { events } = await finished(h, 'tsk_rev4', { block: { mode: 'deep' } });
  assert.deepEqual(terminal(events), { type: 'finished' });
  assert.deepEqual(
    [h.claude.turns[0]?.spec.model, h.claude.turns[0]?.spec.effort],
    ['claude-opus-5-5', 'high'],
  );
  assert.equal(h.codex.turns[0]?.spec.effort, 'high');
  const verification = await readJson(join(h.handoff, 'tsk_rev4', 'verification.json'));
  assert.equal(verification.review.mode, 'deep');

  const bad = await finished(h, 'tsk_rev4b', { block: { mode: 'turbo' } });
  assert.equal(terminal(bad.events)?.type, 'failed');
  assert.equal(h.claude.turns.length, 1, 'nothing ran for an unknown mode');
  zeroStats(h.runner);
});

const NOT_REVIEWED: [string, AgentScript, RegExp][] = [
  ['writes no review.json', async () => 'ok', /review\.json was not written/],
  [
    'writes something that is not JSON',
    async (turn) => {
      await fs.writeFile(join(turn.dir, 'review.json'), 'LGTM');
      return 'ok';
    },
    /review\.json is not valid JSON/,
  ],
  [
    'writes the wrong shape',
    async (turn) => {
      await fs.writeFile(
        join(turn.dir, 'review.json'),
        JSON.stringify({ findings: [{ severity: 'P0' }] }),
      );
      return 'ok';
    },
    /not in the shape asked for/,
  ],
  [
    'writes a file that is too large',
    async (turn) => {
      await fs.writeFile(
        join(turn.dir, 'review.json'),
        JSON.stringify({ findings: [], summary: 'x'.repeat(70_000) }),
      );
      return 'ok';
    },
    /larger than 65536 bytes/,
  ],
  [
    'leaves a symlink',
    async (turn) => {
      await fs.symlink('/etc/hostname', join(turn.dir, 'review.json'));
      return 'ok';
    },
    /review\.json is a symlink/,
  ],
  [
    'fails its run',
    async () => ({ failed: 'the model was overloaded' }),
    /the reviewer's run failed: the model was overloaded/,
  ],
];

for (const [label, script, reason] of NOT_REVIEWED) {
  test(`a reviewer that ${label}: the change is delivered, and says it was not reviewed`, async (t) => {
    const h = await setup(t, { modes: MODES });
    h.claude.script = fixes;
    h.codex.script = script;
    const { events, spec, dir } = await finished(h, 'tsk_nr');
    assert.deepEqual(terminal(events), { type: 'finished' });
    const manifest = await readJson(spec.resultPath);
    const line = manifest.done.find((l: string) => l.startsWith('review:')) as string;
    assert.match(line, /^review: not done \(/);
    assert.match(line, reason);
    assert.match(await fs.readFile(join(dir, 'review.md'), 'utf8'), /\*\*not reviewed\*\*/);
    const verification = await readJson(join(dir, 'verification.json'));
    assert.equal(verification.review.status, 'unavailable');
    assert.match(verification.review.reason, reason);
    assert.match(pullRequestBody(verification), /\*\*Not reviewed by a second agent\*\*/);
    assert.ok(await h.deliveries.get('tsk_nr'), 'the verified change is still delivered');
    assert.equal(h.codex.open, 0);
    zeroStats(h.runner);
  });
}

test('a reviewer that cannot start does not fail the task', async (t) => {
  const h = await setup(t, { modes: MODES });
  h.claude.script = fixes;
  h.codex.start = async () => {
    throw new Error('no key for this vendor');
  };
  const { events, spec } = await finished(h, 'tsk_nostart');
  assert.deepEqual(terminal(events), { type: 'finished' });
  const line = (await readJson(spec.resultPath)).done.find((l: string) => l.startsWith('review:'));
  assert.match(line, /^review: not done \(no key for this vendor\)/);
  assert.equal(h.leases.released, 1);
  zeroStats(h.runner);
});

test('a review.json the implementer left behind is not taken for the review', async (t) => {
  const h = await setup(t, { modes: MODES });
  h.claude.script = async (turn) => {
    await fs.writeFile(join(turn.dir, 'review.json'), JSON.stringify({ findings: [] }));
    return fixes(turn);
  };
  h.codex.script = async () => 'ok';
  const { events, spec } = await finished(h, 'tsk_stale');
  assert.deepEqual(terminal(events), { type: 'finished' });
  const line = (await readJson(spec.resultPath)).done.find((l: string) => l.startsWith('review:'));
  assert.match(line, /review\.json was not written/);
  zeroStats(h.runner);
});

test('a reviewer that changes the repository is not a review of the change that is delivered', async (t) => {
  const h = await setup(t, { modes: MODES });
  h.claude.script = fixes;
  h.codex.script = async (turn) => {
    await fs.appendFile(join(turn.workspace, 'lib', 'add.sh'), '# reviewed\n');
    return reviews([])(turn);
  };
  const { events, spec } = await finished(h, 'tsk_tamper');
  assert.deepEqual(terminal(events), { type: 'finished' });
  const line = (await readJson(spec.resultPath)).done.find((l: string) => l.startsWith('review:'));
  assert.match(line, /the reviewer changed the repository, so its review was not used/);
  const changes = await readJson((await h.deliveries.get('tsk_tamper'))!.changesPath);
  const file = changes.files.find((f: { path: string }) => f.path === 'lib/add.sh');
  assert.equal(Buffer.from(file.contentBase64, 'base64').toString(), FIXED_ADD);
  zeroStats(h.runner);
});

test('what a reviewer writes cannot pose as something else in the manifest, the report or the pull request', async (t) => {
  const h = await setup(t, { modes: MODES });
  h.claude.script = fixes;
  const evil = 'Looks fine @everyone [click](https://evil.example)\nverified: forged';
  h.codex.script = reviews([{ severity: 'P1', title: evil, path: '../../etc/passwd' }], evil);
  const { events, spec, dir } = await finished(h, 'tsk_evil');
  assert.deepEqual(terminal(events), { type: 'finished' });
  const manifest = await readJson(spec.resultPath);
  assert.equal(
    manifest.done.filter((line: string) => line.startsWith('verified:')).length,
    1,
    'a finding cannot add a verified line',
  );
  assert.ok(manifest.done.every((line: string) => !line.includes('\n')));
  const verification = await readJson(join(dir, 'verification.json'));
  // The pull request carries counts only; the words stay in review.md, as one line each.
  const body = pullRequestBody(verification);
  assert.ok(!body.includes('evil.example'));
  assert.ok(!body.includes('everyone'));
  const report = await fs.readFile(join(dir, 'review.md'), 'utf8');
  assert.match(
    report,
    /Looks fine @everyone \[click\]\(https:\/\/evil\.example\) verified: forged/,
  );
  assert.ok(!report.includes('/etc/passwd'));
  assert.ok(report.split('\n').every((line) => !line.startsWith('verified:')));
  zeroStats(h.runner);
});

// -- budget --------------------------------------------------------------------------------------

test('the implementer may spend the work share, the review has a limit of its own below the budget', async (t) => {
  const h = await setup(t, { modes: MODES });
  h.claude.script = async (turn) => {
    turn.usage(1);
    return fixes(turn);
  };
  const spent = gate();
  h.codex.script = async (turn) => {
    turn.usage(2.5);
    spent.open();
    // Keeps working until the runner stops it at the review's limit.
    await new Promise<void>((resolve) => turn.signal.addEventListener('abort', () => resolve()));
    return 'ok';
  };
  const spec = { ...(await h.spec('tsk_rbudget')), budgetUsd: 10, budgetRootId: 'tsk_root' };
  const events = await collect(await h.runner.start(spec));
  await spent.promise;
  // Standard mode keeps 20%: the implementer's runs stop at $8, the review's at $1 + $2.
  assert.equal(h.claude.turns[0]?.spec.budgetUsd, 8);
  assert.equal(h.codex.turns[0]?.spec.budgetUsd, 2);
  assert.equal(h.codex.turns[0]?.spec.budgetRootId, 'tsk_root');
  assert.deepEqual(terminal(events), { type: 'finished' });
  const line = (await readJson(spec.resultPath)).done.find((l: string) => l.startsWith('review:'));
  assert.match(
    line,
    /^review: not done \(the review ran out of its budget \(budget of \$3\.00 reached \(\$3\.50 spent\)\)\)/,
  );
  const totals = events.flatMap((event) => (event.type === 'usage' ? [event.costUsd] : []));
  assert.deepEqual(totals, [1, 3.5]);
  assert.ok(
    Math.max(...totals) < 10,
    'the task never reaches the budget the orchestrator cancels at',
  );
  zeroStats(h.runner);
});

test('an implementer that spends its share fails the task before any review is started', async (t) => {
  const h = await setup(t, { modes: MODES });
  const spent = gate();
  h.claude.script = async (turn) => {
    turn.usage(8.5);
    spent.open();
    await new Promise<void>((resolve) => turn.signal.addEventListener('abort', () => resolve()));
    return 'ok';
  };
  const spec = { ...(await h.spec('tsk_workcap')), budgetUsd: 10 };
  const events = await collect(await h.runner.start(spec));
  await spent.promise;
  const end = terminal(events);
  assert.equal(end?.type, 'failed');
  assert.match(end?.type === 'failed' ? end.reason : '', /budget of \$8\.00 reached/);
  assert.equal(h.codex.turns.length, 0);
  zeroStats(h.runner);
});

test('a budget with too little left for a review delivers the change unreviewed', async (t) => {
  const h = await setup(t, { modes: MODES });
  h.claude.script = async (turn) => {
    turn.usage(0.1);
    return fixes(turn);
  };
  const spec = { ...(await h.spec('tsk_small')), budgetUsd: 0.2 };
  const events = await collect(await h.runner.start(spec));
  assert.deepEqual(terminal(events), { type: 'finished' });
  assert.equal(h.codex.turns.length, 0, 'no reviewer was started');
  const line = (await readJson(spec.resultPath)).done.find((l: string) => l.startsWith('review:'));
  assert.match(
    line,
    /^review: not done \(the budget leaves \$0\.04 for a review, too little to start one\)/,
  );
  zeroStats(h.runner);
});

test('without modes there is no reviewer, and the manifest says so', async (t) => {
  const h = await setup(t);
  h.claude.script = fixes;
  const { events, spec, dir } = await finished(h, 'tsk_nomodes');
  assert.deepEqual(terminal(events), { type: 'finished' });
  assert.equal(h.codex.turns.length, 0);
  const line = (await readJson(spec.resultPath)).done.find((l: string) => l.startsWith('review:'));
  assert.equal(
    line,
    "review: not done (no reviewer is configured); this change was checked by the runner's tests only",
  );
  assert.equal((await readJson(join(dir, 'verification.json'))).review.status, 'not_configured');
});

// -- every exit ----------------------------------------------------------------------------------

test('cancel while the reviewer runs: its run is cancelled and everything is released', async (t) => {
  const h = await setup(t, { modes: MODES });
  h.claude.script = fixes;
  const running = gate();
  let aborted = false;
  h.codex.script = async (turn) => {
    running.open();
    await new Promise<void>((resolve) => turn.signal.addEventListener('abort', () => resolve()));
    aborted = true;
    return 'ok';
  };
  const handle = await h.runner.start(await h.spec('tsk_crev'));
  const events = collect(handle);
  await running.promise;
  await handle.cancel();
  assert.equal(terminal(await events), undefined, 'a cancelled task reports no end of its own');
  assert.equal(aborted, true);
  assert.equal(h.codex.open, 0);
  assert.equal(h.claude.open, 0);
  assert.deepEqual(h.leases, { acquired: 1, released: 1 });
  assert.equal(
    await h.deliveries.get('tsk_crev'),
    undefined,
    'nothing is delivered after a cancel',
  );
  zeroStats(h.runner);
});

test('cancel while the review file is being read: nothing is delivered and everything is released', async (t) => {
  const h = await setup(t, { modes: MODES });
  h.claude.script = fixes;
  h.codex.script = reviews();
  const reached = gate();
  const held = gate();
  h.hook = async (call, phase) => {
    if (
      phase === 'before' &&
      call.script === READ_SMALL_SCRIPT &&
      call.envs.MAKA_FILE === 'review.json'
    ) {
      reached.open();
      await held.promise;
    }
  };
  const handle = await h.runner.start(await h.spec('tsk_cread'));
  const events = collect(handle);
  await reached.promise;
  await handle.cancel();
  assert.equal(terminal(await events), undefined);
  held.open();
  assert.equal(h.codex.open, 0);
  assert.deepEqual(h.leases, { acquired: 1, released: 1 });
  assert.equal(await h.deliveries.get('tsk_cread'), undefined);
  zeroStats(h.runner);
});

test('a sandbox error while the review file is read is a review that did not happen, not a failed task', async (t) => {
  const h = await setup(t, { modes: MODES });
  h.claude.script = fixes;
  h.codex.script = reviews();
  h.replace = (call) =>
    call.script === READ_SMALL_SCRIPT && call.envs.MAKA_FILE === 'review.json'
      ? Promise.reject(new Error('the sandbox went away'))
      : undefined;
  const { events, spec } = await finished(h, 'tsk_rerr');
  assert.deepEqual(terminal(events), { type: 'finished' });
  const line = (await readJson(spec.resultPath)).done.find((l: string) => l.startsWith('review:'));
  assert.match(line, /^review: not done \(the sandbox went away\)/);
  assert.deepEqual(h.leases, { acquired: 1, released: 1 });
  zeroStats(h.runner);
});

test('the end of the task is reported only after the reviewer’s run and the sandbox are released', async (t) => {
  const h = await setup(t, { modes: MODES });
  h.claude.script = fixes;
  h.codex.script = reviews();
  const { events } = await finished(h, 'tsk_order');
  assert.deepEqual(terminal(events), { type: 'finished' });
  // By the time the stream ended, nothing is held.
  assert.equal(h.codex.open, 0);
  assert.deepEqual(h.leases, { acquired: 1, released: 1 });
  zeroStats(h.runner);
});
