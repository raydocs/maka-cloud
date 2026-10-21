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

const EXPORTED =
  'runner-exported: out/report.md out/report.html out/report.json out/verification.json';

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    summary: 'Report written',
    done: ['wrote the report', formatCiteCheckLine(summary), EXPORTED],
    notDone: [],
    confidence: 'high',
    knownIssues: [],
    artifacts: ['out/report.md', 'out/report.html', 'out/report.json', 'out/verification.json'],
    ...overrides,
  };
}

describe('verifyResearchManifest', () => {
  test('a deep task whose claims no reviewer judged fails; judged, or any other mode, is as before', () => {
    const unjudged = manifest({
      done: ['wrote the report', formatCiteCheckLine({ ...summary, judged: 0 }), EXPORTED],
    });
    for (const mode of ['quick', 'standard', undefined] as const) {
      const verdict = verifyResearchManifest(unjudged, mode ? { mode } : {});
      assert.equal(verdict.ok, true, String(mode));
    }
    const deep = verifyResearchManifest(unjudged, { mode: 'deep' });
    assert.equal(deep.ok, false);
    assert.match(deep.problems.join('\n'), /deep task needs a reviewer from the other runner/);
    assert.equal(
      verifyResearchManifest(manifest(), { mode: 'deep', otherRunnerInput: true }).ok,
      true,
    );
  });

  test('a deep task’s judged count is believed only when it built on files from the other runner', () => {
    for (const context of [
      { mode: 'deep' as const },
      { mode: 'deep' as const, otherRunnerInput: false },
    ]) {
      const verdict = verifyResearchManifest(manifest(), context);
      assert.equal(verdict.ok, false, JSON.stringify(context));
      assert.match(verdict.problems.join('\n'), /must come from a task run by the other runner/);
    }
    // Other modes do not need a reviewer, so the count is not examined.
    assert.equal(verifyResearchManifest(manifest(), { mode: 'standard' }).ok, true);
  });

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
      manifest({
        done: [formatCiteCheckLine({ ...summary, judged: 0 }), EXPORTED],
        notDone: ['x'],
      }),
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

  test('a manifest that does not list report.json fails', () => {
    const verdict = verifyResearchManifest(
      manifest({ artifacts: ['out/report.md', 'out/report.html', 'out/verification.json'] }),
    );
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.problems, ['artifacts do not list: report.json']);
  });

  test('no cite-check line fails', () => {
    const verdict = verifyResearchManifest(manifest({ done: ['wrote the report', EXPORTED] }));
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
      const verdict = verifyResearchManifest(manifest({ done: [line, EXPORTED] }));
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

  test('the runner must vouch that the report files reached the handoff directory', () => {
    const cite = formatCiteCheckLine(summary);
    const problems = (done: string[]) => verifyResearchManifest(manifest({ done })).problems;

    assert.deepEqual(problems([cite]), [
      "done has no runner-exported line: the report files were not copied to the task's handoff directory",
    ]);
    assert.deepEqual(problems([cite, EXPORTED, EXPORTED]), [
      'done has more than one runner-exported line',
    ]);
    // A file the runner did not export is named, wherever the others live.
    assert.deepEqual(
      problems([cite, 'runner-exported: out/report.md out/report.html out/report.json']),
      ['the runner did not export: verification.json'],
    );
    assert.deepEqual(problems([cite, 'runner-exported: out/verification.json']), [
      'the runner did not export: report.md, report.html, report.json',
    ]);
    assert.deepEqual(problems([cite, 'runner-exported:']), [
      'the runner did not export: report.md, report.html, report.json, verification.json',
    ]);
    // The checked report.json is required: a later independent check reads it.
    assert.deepEqual(
      problems([cite, 'runner-exported: out/report.md out/report.html out/verification.json']),
      ['the runner did not export: report.json'],
    );
    // Listing a file in artifacts is not the same as having it exported.
    assert.deepEqual(problems([cite, 'runner-exported: notes.md']).length, 1);
    assert.deepEqual(
      problems([cite, 'x/report.md x/report.html x/report.json x/verification.json']).length,
      1,
    );
    assert.deepEqual(
      problems([
        cite,
        'runner-exported: a/report.md b/report.html c/report.json d/verification.json',
      ]),
      [],
    );
  });

  test('two cite-check lines fail', () => {
    const line = formatCiteCheckLine(summary);
    assert.deepEqual(verifyResearchManifest(manifest({ done: [line, line, EXPORTED] })).problems, [
      'done has more than one cite-check line',
    ]);
  });

  test('a failed claim left in the report fails', () => {
    const verdict = verifyResearchManifest(
      manifest({ done: [formatCiteCheckLine({ ...summary, removed: 1 }), EXPORTED] }),
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
      verifyResearchManifest(manifest({ done: [empty, EXPORTED] })).problems.join(),
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
    'maka-inputs: <drafterTaskId> report.json sources',
    'maka-inputs: <reviewerTaskId> judgments.json',
    '--judgments inputs/<reviewerTaskId>/judgments.json',
  ]) {
    assert.ok(steps.includes(needle), needle);
  }
  assert.equal(playbook.verify(manifest()).ok, true);
});

test('every maka-artifacts line in the steps asks for out/report.json, and the contract lists it', () => {
  const steps = researchPlaybook.steps.join('\n');
  const lines = [...steps.matchAll(/maka-artifacts: ([^`]*)`/g)]
    .map((match) => (match[1] as string).trim())
    .filter((line) => line.startsWith('out/'));
  assert.equal(lines.length, 2, 'the drafting brief and the rerun brief');
  for (const line of lines) {
    assert.deepEqual(line.split(' '), [
      'out/report.md',
      'out/report.html',
      'out/report.json',
      'out/verification.json',
    ]);
  }
  assert.match(
    steps,
    /List out\/report\.md, out\/report\.html, out\/report\.json and out\/verification\.json in artifacts/,
  );
});
