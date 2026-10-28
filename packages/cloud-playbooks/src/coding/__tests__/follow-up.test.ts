import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { type ChangeSet, MemoryCodingDeliveries } from '../deliveries.js';
import {
  type FollowUpReport,
  JsonFileFollowUpStore,
  MemoryFollowUpStore,
  PrFollowUp,
} from '../follow-up.js';
import { GitHubChecks, GitHubPublisher } from '../github.js';
import { parseCodingBrief } from '../task.js';
import { FakeGitHub } from './fake-github.js';

const TOKEN = 'github_pat_11ABCDEFG_secretsecretsecret';
const LEAKED = 'github_pat_11ZZZZZZZ_leakedleakedleakedleaked';
const REPO = 'acme/calc';
const BASE = 'a'.repeat(40);

function blob(text: string): { blobSha: string; contentBase64: string } {
  const content = Buffer.from(text);
  return {
    blobSha: createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex'),
    contentBase64: content.toString('base64'),
  };
}

const record = (overrides: object = {}) => ({
  testCommand: 'bash tests/run.sh',
  baseSha: BASE,
  attempts: [{ vendor: 'codex' }],
  review: {
    status: 'reviewed',
    mode: 'standard',
    modesVersion: 1,
    counts: { P1: 0, P2: 0, P3: 0 },
    reviewSha256: '0'.repeat(64),
  },
  ...overrides,
});

interface Setup {
  fake: FakeGitHub;
  followUp: PrFollowUp;
  deliveries: MemoryCodingDeliveries;
  notices: string[];
  reports: FollowUpReport[];
  fixes: Array<{ key: string; brief: string; title: string }>;
  tasks: Map<string, { state: string; failureReason?: string }>;
  clock: { now: number };
  dir: string;
  /** The pull request's head commit now. */
  head(): string;
  /** Records the fix run's verified change, made on top of `onto`. */
  recordFix(onto: string, verification?: object): Promise<void>;
  pass(): Promise<void>;
}

async function setup(
  t: TestContext,
  options: { autoFix?: boolean; store?: MemoryFollowUpStore | JsonFileFollowUpStore } = {},
): Promise<Setup> {
  const fake = await new FakeGitHub(REPO, BASE).start();
  t.after(() => fake.close());
  const dir = await fs.mkdtemp(join(tmpdir(), 'follow-up-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const env = { MAKA_GITHUB_TOKEN: TOKEN };
  const publisher = new GitHubPublisher({ baseUrl: fake.url, env });
  const first: ChangeSet = {
    repo: REPO,
    baseSha: BASE,
    files: [{ path: 'lib/add.sh', status: 'modified', mode: '100644', ...blob('fixed\n') }],
  };
  const pr = await publisher.publish({
    changeSet: first,
    branch: 'maka/tsk_1',
    baseRef: 'main',
    title: 'Fix add',
    body: 'body',
  });
  const deliveries = new MemoryCodingDeliveries();
  const write = async (name: string, content: string) => {
    const path = join(dir, name);
    await fs.writeFile(path, content);
    return path;
  };
  const firstChanges = JSON.stringify(first);
  await deliveries.record({
    taskId: 'tsk_1',
    repo: REPO,
    baseRef: 'main',
    baseSha: BASE,
    changesPath: await write('changes-1.json', firstChanges),
    changesSha256: createHash('sha256').update(firstChanges).digest('hex'),
    verificationPath: await write('verification-1.json', JSON.stringify(record())),
  });
  const notices: string[] = [];
  const reports: FollowUpReport[] = [];
  const fixes: Setup['fixes'] = [];
  const tasks = new Map<string, { state: string; failureReason?: string }>();
  const clock = { now: 1_000_000 };
  const followUp = await PrFollowUp.create({
    checks: new GitHubChecks({ baseUrl: fake.url, env }),
    publisher,
    deliveries,
    store: options.store ?? new MemoryFollowUpStore(),
    ...(options.autoFix === undefined ? {} : { autoFix: options.autoFix }),
    now: () => clock.now,
    startFix: async (input) => {
      fixes.push({ key: input.key, brief: input.brief, title: input.title });
      tasks.set('tsk_fix', { state: 'running' });
      return { taskId: 'tsk_fix' };
    },
    taskOf: (_conversationId, taskId) => tasks.get(taskId),
    notice: async (_conversationId, text) => {
      notices.push(text);
    },
    report: (item) => {
      reports.push(item);
      return true;
    },
  });
  t.after(() => followUp.stop());
  const head = () => fake.refs.get('maka/tsk_1') as string;
  await followUp.watch({
    taskId: 'tsk_1',
    conversationId: 'cnv_1',
    repo: REPO,
    number: pr.number,
    url: pr.url,
    branch: 'maka/tsk_1',
  });
  await followUp.settled();
  return {
    fake,
    followUp,
    deliveries,
    notices,
    reports,
    fixes,
    tasks,
    clock,
    dir,
    head,
    async recordFix(onto, verification = record({ baseSha: onto })) {
      const changes = JSON.stringify({
        repo: REPO,
        baseSha: onto,
        files: [{ path: 'lib/add.sh', status: 'modified', mode: '100644', ...blob('fixed2\n') }],
      } satisfies ChangeSet);
      await deliveries.record({
        taskId: 'tsk_fix',
        repo: REPO,
        baseRef: 'maka/tsk_1',
        baseSha: onto,
        changesPath: await write('changes-fix.json', changes),
        changesSha256: createHash('sha256').update(changes).digest('hex'),
        verificationPath: await write('verification-fix.json', JSON.stringify(verification)),
      });
    },
    async pass() {
      followUp.kick();
      await followUp.settled();
    },
  };
}

const run = (id: number, name: string, conclusion: string | null, status = 'completed') => ({
  id,
  name,
  status,
  conclusion,
});

const needsYou = (reports: FollowUpReport[]) => reports.filter((report) => report.needsYou);

test('green checks are one quiet update in the conversation and the inbox, and nothing is fixed', async (t) => {
  const s = await setup(t);
  // No check yet, then one still running: nothing is said.
  await s.pass();
  s.fake.checkRuns.set(s.head(), [run(1, 'test', null, 'in_progress')]);
  await s.pass();
  assert.deepEqual(s.notices, []);
  s.fake.checkRuns.set(s.head(), [run(1, 'test', 'success'), run(2, 'lint', 'skipped')]);
  await s.pass();
  await s.pass();
  assert.deepEqual(s.notices, ['Checks passed on pull request #1 in acme/calc.']);
  assert.deepEqual(
    s.reports.map((r) => ({ needsYou: r.needsYou, key: r.key, url: r.url })),
    [{ needsYou: false, key: 'tsk_1:passed', url: 'https://github.com/acme/calc/pull/1' }],
  );
  assert.equal(s.fixes.length, 0);
  assert.equal(s.followUp.list()[0]?.outcome, 'passed');
});

test('red starts one fix run from the pull request head with the scrubbed log, pushes it once it is reviewed, and green after it is quiet', async (t) => {
  const s = await setup(t, { autoFix: true });
  const firstHead = s.head();
  s.fake.checkRuns.set(firstHead, [run(41, 'unit tests', 'failure'), run(42, 'lint', 'success')]);
  s.fake.logs.set(41, `npm test\nnot ok 3 - add\nexport TOKEN=${LEAKED}\nexit 1\n`);
  await s.pass();

  assert.equal(s.fixes.length, 1);
  const fix = s.fixes[0]!;
  assert.equal(fix.key, 'ci-fix:tsk_1');
  // The fix run is a coding task like the first: the same repository and test command and the
  // same first vendor (so the review is by the other one), starting from the pull request's branch.
  const parsed = parseCodingBrief(fix.brief);
  assert.ok(parsed.ok);
  assert.deepEqual(
    { ...parsed.task, goal: undefined },
    {
      repo: REPO,
      baseRef: 'maka/tsk_1',
      testCommand: 'bash tests/run.sh',
      runner: 'codex',
      goal: undefined,
    },
  );
  assert.match(fix.brief, /not ok 3 - add/);
  assert.ok(!fix.brief.includes(LEAKED), 'the log reaches the fix run scrubbed');
  assert.match(fix.brief, /“unit tests”/);
  assert.equal(needsYou(s.reports).length, 0);
  assert.equal(s.followUp.isFixTask('tsk_fix'), true);
  assert.equal(s.followUp.isFixTask('tsk_1'), false);

  // While it runs, nothing is pushed or said again.
  await s.pass();
  assert.equal(s.head(), firstHead);
  assert.equal(s.fixes.length, 1);

  await s.recordFix(firstHead);
  s.tasks.set('tsk_fix', { state: 'succeeded' });
  await s.pass();
  const fixedHead = s.head();
  assert.notEqual(fixedHead, firstHead);
  assert.deepEqual(s.fake.commits.get(fixedHead)?.parents, [{ sha: firstHead }]);
  assert.equal((await s.deliveries.get('tsk_fix'))?.publishedPr?.number, 1);

  s.fake.checkRuns.set(fixedHead, [run(51, 'unit tests', 'success')]);
  await s.pass();
  assert.deepEqual(
    s.notices.at(-1),
    'Checks pass on pull request #1 in acme/calc after one automatic fix.',
  );
  assert.equal(needsYou(s.reports).length, 0);
  assert.equal(s.followUp.list()[0]?.outcome, 'fixed');
});

test('a second failure after the fix is one "needs you" item, never another try', async (t) => {
  const s = await setup(t, { autoFix: true });
  const firstHead = s.head();
  s.fake.checkRuns.set(firstHead, [run(41, 'unit tests', 'failure')]);
  await s.pass();
  await s.recordFix(firstHead);
  s.tasks.set('tsk_fix', { state: 'succeeded' });
  await s.pass();
  s.fake.checkRuns.set(s.head(), [run(61, 'unit tests', 'failure')]);
  await s.pass();
  await s.pass();
  assert.equal(s.fixes.length, 1);
  const items = needsYou(s.reports);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.key, 'tsk_1:exhausted');
  assert.match(
    items[0]?.ask ?? '',
    /still fail .* after one automatic fix \(“unit tests”\)\. It was not tried again\./,
  );
  assert.equal(s.followUp.list()[0]?.state, 'done');
});

test('a fix that was kept for the owner, failed, or no longer fits the head is not pushed and needs the owner once', async (t) => {
  for (const variant of ['kept', 'failed', 'moved'] as const) {
    const s = await setup(t, { autoFix: true });
    const firstHead = s.head();
    s.fake.checkRuns.set(firstHead, [run(41, 'unit tests', 'failure')]);
    await s.pass();
    if (variant === 'kept') {
      await s.recordFix(
        firstHead,
        record({ baseSha: firstHead, kept: { reason: 'a P1 finding is left' } }),
      );
      s.tasks.set('tsk_fix', { state: 'succeeded' });
    } else if (variant === 'failed') {
      s.tasks.set('tsk_fix', { state: 'failed', failureReason: 'the checks failed twice' });
    } else {
      // Someone pushed to the branch while the fix ran: the fix is not forced over it.
      await s.recordFix(BASE);
      s.tasks.set('tsk_fix', { state: 'succeeded' });
    }
    await s.pass();
    await s.pass();
    assert.equal(s.head(), firstHead, variant);
    const items = needsYou(s.reports);
    assert.equal(items.length, 1, variant);
    assert.match(items[0]?.ask ?? '', /the automatic fix was not pushed/, variant);
    assert.equal(s.fixes.length, 1, variant);
  }
});

test('the follow-up stops quietly when the pull request is merged or closed, or after the time limit', async (t) => {
  const merged = await setup(t);
  merged.fake.prState = 'merged';
  await merged.pass();
  assert.equal(merged.followUp.list()[0]?.outcome, 'merged');
  assert.equal(needsYou(merged.reports).length, 0);

  const late = await setup(t);
  late.fake.checkRuns.set(late.head(), [run(1, 'test', null, 'queued')]);
  late.clock.now += 6 * 3_600_000;
  await late.pass();
  assert.equal(late.followUp.list()[0]?.outcome, 'timed_out');
  assert.equal(needsYou(late.reports).length, 0);
  // Done is done: later passes read nothing more.
  const calls = late.fake.calls.length;
  await late.pass();
  assert.equal(late.fake.calls.length, calls);
});

test('without "Checks: read" the workflow runs and their jobs are read instead', async (t) => {
  const s = await setup(t, { autoFix: true });
  s.fake.checksForbidden = true;
  s.fake.workflowRuns.set(s.head(), [
    {
      id: 7,
      name: 'CI',
      status: 'completed',
      conclusion: 'failure',
      jobs: [run(70, 'build', 'success'), run(71, 'test (node 22)', 'failure')],
    },
  ]);
  s.fake.logs.set(71, 'AssertionError: expected 3\n');
  await s.pass();
  assert.equal(s.fixes.length, 1);
  assert.match(s.fixes[0]?.brief ?? '', /“test \(node 22\)”/);
  assert.match(s.fixes[0]?.brief ?? '', /AssertionError: expected 3/);
});

test('by default nothing is pushed: red is one "needs you" item that offers the fix; a check waiting for approval asks once per head', async (t) => {
  const s = await setup(t);
  s.fake.checkRuns.set(s.head(), [run(1, 'deploy preview', 'action_required')]);
  await s.pass();
  await s.pass();
  assert.deepEqual(
    needsYou(s.reports).map((r) => r.key),
    [`tsk_1:approval:${s.head()}`],
  );
  s.fake.checkRuns.set(s.head(), [run(1, 'unit tests', 'failure')]);
  await s.pass();
  await s.pass();
  assert.equal(s.fixes.length, 0, 'no fix run starts without the setting');
  const head = s.head();
  assert.equal(s.fake.posts('/git/commits').length, 1, 'only the first change was ever committed');
  assert.deepEqual(
    needsYou(s.reports).map((r) => r.key),
    [`tsk_1:approval:${head}`, 'tsk_1:failed'],
  );
  assert.match(
    needsYou(s.reports)[1]?.ask ?? '',
    /Checks failed on pull request #1 in acme\/calc \(“unit tests”\)\. Nothing was pushed; ask the agent to fix them\?/,
  );
  assert.equal(s.followUp.list()[0]?.outcome, 'needs_you');
});

test('a restart picks the watch up where it was: a fix in flight is not started again', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'follow-up-store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new JsonFileFollowUpStore(join(dir, 'pr-follow-ups.json'));
  const s = await setup(t, { store, autoFix: true });
  s.fake.checkRuns.set(s.head(), [run(41, 'unit tests', 'failure')]);
  await s.pass();
  await s.followUp.stop();
  const watches = await store.load();
  assert.equal(watches[0]?.state, 'fixing');
  assert.equal(watches[0]?.fixTaskId, 'tsk_fix');
  const again = await PrFollowUp.create({
    checks: new GitHubChecks({ baseUrl: s.fake.url, env: { MAKA_GITHUB_TOKEN: TOKEN } }),
    publisher: new GitHubPublisher({ baseUrl: s.fake.url, env: { MAKA_GITHUB_TOKEN: TOKEN } }),
    deliveries: s.deliveries,
    store,
    startFix: async () => assert.fail('a fix in flight is not started again'),
    taskOf: () => ({ state: 'running' }),
    notice: async () => undefined,
    report: () => true,
  });
  t.after(() => again.stop());
  assert.equal(again.isFixTask('tsk_fix'), true);
  again.kick();
  await again.settled();
  assert.equal(again.list()[0]?.state, 'fixing');
});

test('a GitHub that stays down past the time limit ends the watch quietly instead of reading it forever', async (t) => {
  const s = await setup(t);
  s.fake.failWith = { status: 502, message: 'Bad Gateway' };
  await s.pass();
  assert.equal(s.followUp.list()[0]?.state, 'watching');
  s.clock.now += 6 * 3_600_000;
  await s.pass();
  assert.equal(s.followUp.list()[0]?.outcome, 'timed_out');
  assert.equal(needsYou(s.reports).length, 0);
});
