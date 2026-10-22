import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  handsOff,
  type ProofSignals,
  proofFromArtifacts,
  proofArtifact,
  proofOf,
} from '../proof.js';
import type { CellRow } from '../report.js';
import { buildScorecard, renderScorecard, signTest } from '../scorecard.js';

const PROVEN: ProofSignals = {
  reproduced: true,
  reviewed: true,
  crossVendor: true,
  open: { P1: 0, P2: 0, P3: 0 },
  attempts: 1,
  kept: false,
};

function row(
  taskId: string,
  resolved: boolean | null,
  proof: ProofSignals | null = null,
  subjectId = 'coding-playbook',
  costUsd: number | null = 2,
): CellRow {
  return {
    cellId: `${taskId}::1::${subjectId}`,
    taskId,
    subjectId,
    repetition: 1,
    status: 'completed',
    resolved,
    costUsd,
    durationMs: 120_000,
    failureReason: null,
    proof,
  };
}

test('the proof is read from the verification record, and hands-off needs every part of it', () => {
  assert.equal(proofOf({ nope: true }), null);
  const proof = proofOf({
    repro: { command: 'npm test', files: ['a.test.ts'] },
    attempts: [{ vendor: 'codex' }],
    review: { status: 'reviewed', reviewer: 'codex', counts: { P1: 1, P2: 0, P3: 0 } },
    kept: { reason: 'a P1 remains' },
  });
  assert.deepEqual(proof, {
    reproduced: true,
    reviewed: true,
    crossVendor: false,
    open: { P1: 1, P2: 0, P3: 0 },
    attempts: 1,
    kept: true,
  });
  assert.equal(handsOff(proof), false);
  assert.equal(handsOff(PROVEN), true);
  assert.equal(handsOff({ ...PROVEN, reproduced: false }), false);
  assert.equal(handsOff({ ...PROVEN, reviewed: false }), false);
  assert.equal(handsOff({ ...PROVEN, open: { P1: 1, P2: 0, P3: 0 } }), false);
  assert.equal(handsOff({ ...PROVEN, kept: true }), false);
  assert.equal(handsOff(null), false);
  // It survives the attempt store's JSON round trip.
  const artifacts = [{ kind: 'outcome' }, JSON.parse(JSON.stringify(proofArtifact(PROVEN)))];
  assert.deepEqual(proofFromArtifacts(artifacts), PROVEN);
  assert.equal(proofFromArtifacts([{ kind: 'outcome' }]), null);
});

test('false confidence is the share of hands-off changes the hidden tests reject', () => {
  const card = buildScorecard({
    experimentId: 'run-002',
    mode: 'live',
    subjectIds: ['coding-playbook', 'codex'],
    rows: [
      row('t1', true, PROVEN),
      row('t2', true, PROVEN),
      row('t3', false, PROVEN),
      row('t4', false, { ...PROVEN, kept: true }),
      row('t5', null, PROVEN),
      row('t1', true, null, 'codex', 1),
      row('t2', false, null, 'codex', null),
    ],
  });
  const [playbook, codex] = card.subjects;
  assert.equal(playbook?.cells, 4, 'a cell without a verdict is not counted');
  assert.equal(playbook?.resolveRate, 0.5);
  assert.equal(playbook?.handsOffRate, 0.75);
  assert.equal(playbook?.falseConfidence, 0.3333);
  assert.equal(playbook?.costPerResolvedUsd, 4);
  assert.equal(playbook?.medianMinutes, 2);
  assert.equal(playbook?.autoMergeReady, false);
  assert.equal(codex?.handsOffRate, null, 'a subject without a proof record shows n/a');
  assert.equal(codex?.falseConfidence, null);
  assert.equal(codex?.costPerResolvedUsd, 1, 'a cell without a cost is left out, not zero');
  const md = renderScorecard(card);
  assert.match(
    md,
    /\| coding-playbook \| 2 of 4 \(50\.0%\) \| 75\.0% \| 33\.3% \| \$4\.00 \| 2\.0 min \| not yet \(3 of 30 hands-off seen\) \|/u,
  );
  assert.match(md, /\| codex \| 1 of 2 \(50\.0%\) \| n\/a \| n\/a \|/u);
});

test('merge on its own needs enough hands-off changes and few wrong ones', () => {
  const rows = Array.from({ length: 40 }, (_, i) => row(`t${i}`, i !== 0, PROVEN));
  const ready = buildScorecard({
    experimentId: 'r',
    mode: 'live',
    subjectIds: ['coding-playbook'],
    rows,
  });
  assert.equal(ready.subjects[0]?.falseConfidence, 0.025);
  assert.equal(ready.subjects[0]?.autoMergeReady, true);
  const wrong = rows.map((r, i) => (i < 3 ? { ...r, resolved: false } : r));
  const notReady = buildScorecard({
    experimentId: 'r',
    mode: 'live',
    subjectIds: ['coding-playbook'],
    rows: wrong,
  });
  assert.equal(notReady.subjects[0]?.autoMergeReady, false);
});

test('the sign test: nothing changed, a coin flip, and a clear win', () => {
  assert.equal(signTest(0, 0), null);
  assert.equal(signTest(1, 1), 1);
  assert.equal(signTest(3, 0), 0.25);
  assert.equal(signTest(8, 0), 0.007813);
  assert.equal(signTest(0, 8), 0.007813);
});

test('against a baseline: tasks fixed and broken, the verdict, and deltas over shared tasks only', () => {
  const before = [
    ...Array.from({ length: 10 }, (_, i) => row(`t${i}`, i < 2, PROVEN)),
    row('gone', true, PROVEN),
  ];
  const after = [
    ...Array.from({ length: 10 }, (_, i) => row(`t${i}`, i !== 1, PROVEN)),
    row('new', false, PROVEN),
  ];
  const card = buildScorecard({
    experimentId: 'run-002',
    mode: 'live',
    subjectIds: ['coding-playbook'],
    rows: after,
    baseline: { experimentId: 'run-001', rows: before },
  });
  const [c] = card.comparisons;
  assert.equal(c?.paired, 10);
  assert.deepEqual(c?.broke, ['t1::1']);
  assert.equal(c?.fixed.length, 8);
  assert.equal(c?.verdict, 'better');
  assert.equal(c?.resolveRateDelta, 0.7);
  const md = renderScorecard(card);
  assert.match(md, /## Against run-001/u);
  assert.match(md, /\| coding-playbook \| better \(p 0\.039\) \| 8 \| 1 \| \+70\.0 pt \|/u);
  assert.match(md, /\*\*coding-playbook now fails:\*\* `t1::1`/u);

  const same = buildScorecard({
    experimentId: 'b',
    mode: 'live',
    subjectIds: ['coding-playbook'],
    rows: before,
    baseline: { experimentId: 'a', rows: before },
  });
  assert.equal(same.comparisons[0]?.verdict, 'no change');
});
