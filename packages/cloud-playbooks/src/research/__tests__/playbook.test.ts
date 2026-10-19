import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Manifest, Playbook } from '@maka-cloud/conductor';
import { researchPlaybook, verifyResearchManifest } from '../playbook.js';
import { type CiteCheckSummary, formatCiteCheckLine, parseCiteCheckLine } from '../summary-line.js';

const summary: CiteCheckSummary = {
  claims: 10,
  verified: 4,
  quoteVerified: 4,
  failed: 2,
  removed: 2,
  judged: 6,
};

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    summary: 'Report written',
    done: ['wrote the report', formatCiteCheckLine(summary)],
    notDone: [],
    confidence: 'high',
    knownIssues: [],
    artifacts: ['out/report.md', 'out/report.html', 'out/verification.json'],
    ...overrides,
  };
}

describe('verifyResearchManifest', () => {
  test('a complete manifest passes, and is labelled runner-reported', () => {
    const verdict = verifyResearchManifest(manifest());
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.problems, []);
    assert.equal(verdict.basis, 'runner_reported');
    assert.match(verdict.note, /not independently verified/);
    assert.deepEqual(verdict.checked, summary);
  });

  test('the label is there on a failure too, and says when nobody judged the quotes', () => {
    const verdict = verifyResearchManifest(
      manifest({ done: [formatCiteCheckLine({ ...summary, judged: 0 })], notDone: ['x'] }),
    );
    assert.equal(verdict.ok, false);
    assert.equal(verdict.basis, 'runner_reported');
    assert.match(verdict.note, /quote-checked only/);
  });

  test('a missing report artifact fails, by file name wherever it lives', () => {
    const verdict = verifyResearchManifest(
      manifest({ artifacts: ['a/report.md', 'verification.json'] }),
    );
    assert.equal(verdict.ok, false);
    assert.match(verdict.problems.join(), /report\.html/);
    assert.equal(verifyResearchManifest(manifest({ artifacts: undefined })).ok, false);
  });

  test('no cite-check line fails', () => {
    const verdict = verifyResearchManifest(manifest({ done: ['wrote the report'] }));
    assert.deepEqual(verdict.problems, ['done has no cite-check line']);
    assert.equal(verdict.checked, undefined);
  });

  test('a malformed cite-check line fails', () => {
    for (const line of [
      'cite-check v1: claims=10 verified=4',
      `${formatCiteCheckLine(summary)} extra`,
      'cite-check v2: claims=10 verified=4 quote_verified=4 failed=2 removed=2 judged=6',
      'cite-check v1: claims=10 verified=4 quote_verified=4 failed=2 removed=2 judged=6\nsecond line',
      'cite-check: all good',
    ]) {
      const verdict = verifyResearchManifest(manifest({ done: [line] }));
      assert.equal(verdict.ok, false, line);
      assert.match(verdict.problems.join(), /cite-check/);
    }
  });

  test('counts that do not add up fail', () => {
    assert.equal(parseCiteCheckLine(formatCiteCheckLine({ ...summary, verified: 9 })).ok, false);
    assert.equal(parseCiteCheckLine(formatCiteCheckLine({ ...summary, removed: 3 })).ok, false);
    assert.equal(parseCiteCheckLine(formatCiteCheckLine({ ...summary, judged: 11 })).ok, false);
    const huge = `cite-check v1: claims=${'9'.repeat(30)} verified=0 quote_verified=0 failed=0 removed=0 judged=0`;
    assert.equal(parseCiteCheckLine(huge).ok, false);
  });

  test('two cite-check lines fail', () => {
    const line = formatCiteCheckLine(summary);
    assert.deepEqual(verifyResearchManifest(manifest({ done: [line, line] })).problems, [
      'done has more than one cite-check line',
    ]);
  });

  test('a failed claim left in the report fails', () => {
    const verdict = verifyResearchManifest(
      manifest({ done: [formatCiteCheckLine({ ...summary, removed: 1 })] }),
    );
    assert.equal(verdict.ok, false);
    assert.match(
      verdict.problems.join(),
      /1 claim\(s\) that failed the citation check are still in the report/,
    );
  });

  test('a report with no claim left fails', () => {
    const empty = formatCiteCheckLine({
      claims: 2,
      verified: 0,
      quoteVerified: 0,
      failed: 2,
      removed: 2,
      judged: 0,
    });
    assert.match(
      verifyResearchManifest(manifest({ done: [empty] })).problems.join(),
      /no checked claim is left/,
    );
  });

  test('the generic checks still apply', () => {
    const verdict = verifyResearchManifest(
      manifest({ confidence: 'low', notDone: ['sub-question 3'], knownIssues: ['paywalled'] }),
    );
    assert.equal(verdict.ok, false);
    assert.equal(verdict.problems.length, 3);
  });
});

test('the research playbook has the conductor Playbook shape and tells the conductor what to put in the brief', () => {
  const playbook: Playbook = researchPlaybook;
  assert.equal(playbook.id, 'research');
  assert.deepEqual([...playbook.allowedRunners], ['claude-agent-sdk', 'codex']);
  const steps = playbook.steps.join('\n');
  for (const needle of [
    'cite-check',
    'sources/',
    'report.json',
    '--drop-unsupported',
    'runner-reported',
    'judgments.json',
  ]) {
    assert.ok(steps.includes(needle), needle);
  }
  assert.equal(playbook.verify(manifest()).ok, true);
});
