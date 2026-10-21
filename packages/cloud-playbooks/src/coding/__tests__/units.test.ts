import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LoopDetector, parseSample } from '../loop.js';
import { codingPlaybook, verifyCodingManifest } from '../playbook.js';
import { isRepoPath, parseCodingBrief } from '../task.js';

const block = (json: string) => `Plan.\n\n\`\`\`coding-task\n${json}\n\`\`\`\n`;
const valid = { repo: 'acme/calc', baseRef: 'main', testCommand: 'npm test', goal: 'Fix it.' };

test('the coding-task block is parsed strictly', () => {
  assert.deepEqual(parseCodingBrief(block(JSON.stringify(valid))), { ok: true, task: valid });
  const bad = (value: unknown) => {
    const parsed = parseCodingBrief(block(JSON.stringify(value)));
    assert.equal(parsed.ok, false);
    return parsed.ok ? '' : parsed.reason;
  };
  assert.match(parseCodingBrief('no block').ok ? '' : 'missing', /missing/);
  assert.match(bad({ ...valid, repo: 'https://evil.example/x' }), /repo must be "owner\/name"/);
  assert.match(bad({ ...valid, baseRef: '--upload-pack=sh' }), /baseRef/);
  assert.match(bad({ ...valid, baseRef: 'a..b' }), /baseRef/);
  assert.match(bad({ ...valid, runner: 'gpt' }), /runner/);
  assert.match(bad({ ...valid, hiddenTests: 'x' }), /Unrecognized key/);
  const two = parseCodingBrief(block(JSON.stringify(valid)) + block(JSON.stringify(valid)));
  assert.equal(two.ok, false);
});

test('repository paths stay inside the repository', () => {
  assert.equal(isRepoPath('tests/test_add.sh'), true);
  for (const path of ['/etc/passwd', '../x', 'a/../../x', '.git/config', 'a//b', './a', 'a\nb']) {
    assert.equal(isRepoPath(path), false, path);
  }
});

test('a file that keeps coming back to earlier versions is a loop; steady edits are not', () => {
  const steady = new LoopDetector({ maxRevisits: 3, maxChanges: 30 });
  for (let i = 0; i < 20; i++) {
    assert.equal(steady.observe(new Map([['a.ts', `v${i}`]])), undefined);
  }
  const looping = new LoopDetector({ maxRevisits: 3, maxChanges: 30 });
  const seen = ['A', 'B', 'A', 'B'].map((v) => looping.observe(new Map([['a.ts', v]])));
  assert.deepEqual(seen.slice(0, 3), [undefined, undefined, undefined]);
  assert.equal(
    looping.observe(new Map([['a.ts', 'A']])),
    'a.ts went back to an earlier version 3 times',
  );
  // Reverting to the base version counts as going back too.
  const reverting = new LoopDetector({ maxRevisits: 2, maxChanges: 30 });
  reverting.observe(new Map([['b.ts', 'X']]));
  assert.equal(reverting.observe(new Map()), undefined);
  assert.equal(
    reverting.observe(new Map([['b.ts', 'X']])),
    'b.ts went back to an earlier version 2 times',
  );
});

test('a file that changes in more samples than the limit is a loop', () => {
  const detector = new LoopDetector({ maxRevisits: 99, maxChanges: 3 });
  for (let i = 0; i < 3; i++)
    assert.equal(detector.observe(new Map([['a.ts', `v${i}`]])), undefined);
  assert.equal(
    detector.observe(new Map([['a.ts', 'v9']])),
    'a.ts changed in 4 samples without the attempt finishing',
  );
});

test('workspace samples are parsed', () => {
  assert.deepEqual(
    [...parseSample(`H ${'1'.repeat(40)} src/a b.ts\nL link\nD gone.txt\nH  broken\n`)],
    [
      ['src/a b.ts', '1'.repeat(40)],
      ['link', 'symlink'],
      ['gone.txt', 'deleted'],
    ],
  );
});

test('verify accepts only a manifest the coding runner wrote', () => {
  const manifest = {
    summary: 's',
    done: [
      'verified: `npm test` passed; ...',
      'review: an independent agent reviewed the change and reported no findings (see review.md)',
      'agent: did it',
    ],
    notDone: [],
    confidence: 'high' as const,
    knownIssues: [],
    artifacts: ['change.patch', 'changes.json', 'verification.json', 'review.md'],
  };
  assert.deepEqual(codingPlaybook.verify(manifest), { ok: true, problems: [] });
  assert.match(
    verifyCodingManifest({ ...manifest, done: ['agent: tests pass'] }).problems.join(),
    /not verified by the coding runner/,
  );
  // Whether the change was reviewed is always said, once, in the runner's words.
  const verified = manifest.done[0] as string;
  assert.match(
    verifyCodingManifest({ ...manifest, done: [verified] }).problems.join(),
    /does not say whether the change was reviewed/,
  );
  assert.match(
    verifyCodingManifest({
      ...manifest,
      done: [verified, 'review: not done (x)', 'review: reviewed'],
    }).problems.join(),
    /more than one review line/,
  );
  assert.equal(
    verifyCodingManifest({ ...manifest, done: [verified, 'review: not done (no budget)'] }).ok,
    true,
    'a change that was not reviewed says so and is still a verified change',
  );
  assert.match(
    verifyCodingManifest({ ...manifest, artifacts: ['change.patch'] }).problems.join(),
    /artifacts do not list: changes.json, verification.json, review.md/,
  );
  assert.equal(verifyCodingManifest({ ...manifest, confidence: 'low' }).ok, false);
  assert.deepEqual(codingPlaybook.allowedRunners, ['coding']);
});

test('the coding runner wires onto the T6 runners', async () => {
  const { InstaboxClient } = await import('@maka-cloud/instabox');
  const { createCloudRunners, FixedMachineProvider } = await import('@maka-cloud/runners');
  const { createCodingRunner } = await import('../wiring.js');
  const { MemoryCodingDeliveries } = await import('../deliveries.js');
  const cloud = createCloudRunners({
    client: new InstaboxClient({ apiKey: 'ibk_test', baseUrl: 'http://127.0.0.1:9' }),
    sandboxes: new FixedMachineProvider('m_test'),
  });
  const runner = createCodingRunner(cloud, { deliveries: new MemoryCodingDeliveries() });
  assert.equal(runner.name, 'coding');
  assert.equal(runner.options.agents['claude-agent-sdk'], cloud.claude);
  assert.equal(runner.options.agents.codex, cloud.codex);
});
