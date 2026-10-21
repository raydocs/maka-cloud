import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODE_IDS, parseModeBrief, withModeLine } from '@maka-cloud/modes';
import { parseBriefHeader } from '@maka-cloud/runners';

// The conductor writes the mode line and the runners read the other leading lines: neither may
// disturb the other, whichever brief the conductor's model wrote.
const BRIEFS = [
  'Fix lib/add.sh.',
  '\n\nFix lib/add.sh.\n',
  'maka-inputs: tsk_a report.json sources\nRerun it.',
  'maka-inputs: tsk_a report.json\nmaka-inputs: tsk_b judgments.json\nmaka-artifacts: out/report.md out/report.json\nRerun it.',
  'maka-artifacts: judgments.json\nReview it. The user wrote maka-mode in prose.',
];

for (const mode of MODE_IDS) {
  test(`the ${mode} line leaves a brief’s directives for the runners exactly as they were`, () => {
    for (const brief of BRIEFS) {
      const moded = withModeLine(brief, mode);
      const before = parseBriefHeader(brief);
      const after = parseBriefHeader(moded);
      assert.deepEqual(after, before, brief);
      assert.equal(after.ok, true, brief);
      assert.deepEqual(parseModeBrief(moded), { ok: true, mode, rest: brief });
    }
  });
}

test('a directive after the mode line is still refused by the runners, not hidden behind it', () => {
  // withModeLine puts the line after the leading directives, so a directive further down is
  // exactly as late as it was.
  const brief = 'Do it.\nmaka-inputs: tsk_a report.json';
  assert.equal(parseBriefHeader(brief).ok, false);
  assert.equal(parseBriefHeader(withModeLine(brief, 'quick')).ok, false);
});
