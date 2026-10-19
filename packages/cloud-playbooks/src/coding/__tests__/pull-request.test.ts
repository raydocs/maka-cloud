import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { type ChangeSet, JsonFileCodingDeliveries, MemoryCodingDeliveries } from '../deliveries.js';
import { GitHubPublisher, githubTokenProblem, type PullRequestPublisher } from '../github.js';
import { openPullRequestTool, pullRequestBody } from '../pull-request.js';
import { FakeGitHub } from './fake-github.js';

const TOKEN = 'github_pat_11ABCDEFG_secretsecretsecret';
const REPO = 'acme/calc';
const BASE = 'a'.repeat(40);

function blob(text: string): { blobSha: string; contentBase64: string } {
  const content = Buffer.from(text);
  return {
    blobSha: createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex'),
    contentBase64: content.toString('base64'),
  };
}

const CHANGES: ChangeSet = {
  repo: REPO,
  baseSha: BASE,
  files: [
    { path: 'lib/add.sh', status: 'modified', mode: '100644', ...blob('fixed\n') },
    { path: 'tests/test_add.sh', status: 'added', mode: '100755', ...blob('test\n') },
    { path: 'old.txt', status: 'deleted' },
  ],
};

const VERIFICATION = {
  testCommand: 'bash tests/run.sh',
  baseSha: BASE,
  repro: { command: 'bash tests/test_add.sh', files: ['tests/test_add.sh'] },
  attempts: [{ vendor: 'claude-agent-sdk' }],
  changedFiles: [{ path: 'lib/add.sh', status: 'modified' }],
};

async function github(t: TestContext): Promise<FakeGitHub> {
  const fake = await new FakeGitHub(REPO, BASE).start();
  t.after(() => fake.close());
  return fake;
}

function publisher(fake: FakeGitHub, token: string | undefined = TOKEN): GitHubPublisher {
  return new GitHubPublisher({
    baseUrl: fake.url,
    env: token === undefined ? {} : { MAKA_GITHUB_TOKEN: token },
  });
}

const input = (overrides: Partial<Parameters<GitHubPublisher['publish']>[0]> = {}) => ({
  changeSet: CHANGES,
  branch: 'maka/tsk_1',
  baseRef: 'main',
  title: 'Fix add',
  body: 'body',
  ...overrides,
});

test('only a fine-grained token from MAKA_GITHUB_TOKEN is accepted', () => {
  assert.match(githubTokenProblem(undefined) ?? '', /MAKA_GITHUB_TOKEN is not set/);
  assert.match(
    githubTokenProblem('ghp_classic') ?? '',
    /not a fine-grained token \(it must start with github_pat_\)/,
  );
  assert.match(githubTokenProblem('gho_oauth') ?? '', /fine-grained/);
  assert.equal(githubTokenProblem(TOKEN), undefined);
  // A CI or shell GITHUB_TOKEN is never picked up.
  const fromEnv = new GitHubPublisher({ env: { GITHUB_TOKEN: TOKEN } });
  assert.match(fromEnv.precheck() ?? '', /MAKA_GITHUB_TOKEN is not set/);
});

test('publishing commits the change on the base commit, creates the branch and opens the pull request', async (t) => {
  const fake = await github(t);
  const pr = await publisher(fake).publish(input());
  assert.deepEqual(pr, {
    url: `https://github.com/${REPO}/pull/1`,
    number: 1,
    branch: 'maka/tsk_1',
  });

  assert.ok(fake.calls.every((call) => call.authorization === `Bearer ${TOKEN}`));
  const [tree] = fake.posts('/git/trees');
  assert.deepEqual(tree?.body, {
    base_tree: 'f'.repeat(40),
    tree: [
      {
        path: 'lib/add.sh',
        mode: '100644',
        type: 'blob',
        sha: CHANGES.files[0]!.status === 'deleted' ? null : CHANGES.files[0]!.blobSha,
      },
      {
        path: 'tests/test_add.sh',
        mode: '100755',
        type: 'blob',
        sha: (CHANGES.files[1] as { blobSha: string }).blobSha,
      },
      { path: 'old.txt', mode: '100644', type: 'blob', sha: null },
    ],
  });
  const commitSha = fake.refs.get('maka/tsk_1') as string;
  assert.deepEqual(fake.commits.get(commitSha)?.parents, [{ sha: BASE }]);
  assert.equal(fake.commits.get(commitSha)?.message, 'Fix add');
  assert.deepEqual(
    fake.pulls.map(({ head, base, title, body }) => ({ head, base, title, body })),
    [{ head: 'maka/tsk_1', base: 'main', title: 'Fix add', body: 'body' }],
  );
});

test('a retried publish reuses the branch and the pull request', async (t) => {
  const fake = await github(t);
  const first = await publisher(fake).publish(input());
  const second = await publisher(fake).publish(input());
  assert.deepEqual(second, first);
  assert.equal(fake.posts('/git/commits').length, 1);
  assert.equal(fake.posts('/git/refs').length, 1);
  assert.equal(fake.posts('/pulls').length, 1);
});

test('a crash between the branch and the pull request is finished by the retry', async (t) => {
  const fake = await github(t);
  await publisher(fake).publish(input());
  fake.pulls.length = 0; // as if the pull request was never opened
  const pr = await publisher(fake).publish(input());
  assert.equal(pr.number, 1);
  assert.equal(fake.posts('/git/commits').length, 1, 'no second commit');
});

test('an existing branch with other content is never overwritten', async (t) => {
  const fake = await github(t);
  fake.refs.set('maka/tsk_1', BASE);
  await assert.rejects(
    publisher(fake).publish(input()),
    /branch maka\/tsk_1 already exists in acme\/calc with other content/,
  );
  assert.equal(fake.pulls.length, 0);
});

test('a base commit sha targets the default branch; an unknown branch name does too', async (t) => {
  const fake = await github(t);
  fake.defaultBranch = 'trunk';
  await publisher(fake).publish(input({ baseRef: BASE }));
  await publisher(fake).publish(input({ baseRef: 'gone', branch: 'maka/tsk_2' }));
  assert.deepEqual(
    fake.pulls.map((pull) => pull.base),
    ['trunk', 'trunk'],
  );
});

test('GitHub errors never carry the token', async (t) => {
  const fake = await github(t);
  fake.failWith = { status: 401, message: 'Bad credentials' };
  await assert.rejects(publisher(fake).publish(input()), (error: Error) => {
    assert.match(error.message, /failed with 401: Bad credentials/);
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
});

test('publishing refuses to start without a fine-grained token', async (t) => {
  const fake = await github(t);
  await assert.rejects(publisher(fake, 'ghp_classic').publish(input()), /fine-grained/);
  assert.equal(fake.calls.length, 0);
});

// -- the conductor tool ---------------------------------------------------------------------------

async function deliveryFiles(t: TestContext) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pr-tool-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const changesPath = join(dir, 'changes.json');
  const verificationPath = join(dir, 'verification.json');
  const changes = JSON.stringify(CHANGES);
  await fs.writeFile(changesPath, changes);
  await fs.writeFile(verificationPath, JSON.stringify(VERIFICATION));
  const deliveries = new MemoryCodingDeliveries();
  await deliveries.record({
    taskId: 'tsk_1',
    repo: REPO,
    baseRef: 'main',
    baseSha: BASE,
    changesPath,
    changesSha256: createHash('sha256').update(changes).digest('hex'),
    verificationPath,
  });
  return { dir, changesPath, deliveries };
}

class CountingPublisher implements PullRequestPublisher {
  calls = 0;
  problem: string | undefined;
  release: (() => void) | undefined;
  precheck() {
    return this.problem;
  }
  async publish() {
    this.calls++;
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    return { url: 'https://github.com/acme/calc/pull/7', number: 7, branch: 'maka/tsk_1' };
  }
}

const context = (runId = 'run_1') => ({
  runId,
  conversationId: 'cnv_1',
  signal: new AbortController().signal,
});

test('the tool is irreversible and its approval card names the repository, branch and title', async (t) => {
  const { deliveries } = await deliveryFiles(t);
  const tool = openPullRequestTool({
    deliveries,
    publisher: new CountingPublisher(),
    ownsTask: () => true,
  });
  assert.equal(tool.irreversible, true);
  assert.equal(
    await tool.approvalDetails?.({ taskId: 'tsk_1', title: 'Fix add' }),
    'Repository: acme/calc\nBranch: maka/tsk_1\nTitle: Fix add',
  );
  const noToken = openPullRequestTool({
    deliveries,
    publisher: new GitHubPublisher({ env: {} }),
    ownsTask: () => true,
  });
  assert.match(
    (await noToken.approvalDetails?.({ taskId: 'tsk_1', title: 'Fix add' })) ?? '',
    /This cannot be opened yet: MAKA_GITHUB_TOKEN is not set/,
  );
});

test('the tool refuses a task of another run, an unverified task, a changed change set and a wrong token', async (t) => {
  const { deliveries, changesPath } = await deliveryFiles(t);
  const publisher = new CountingPublisher();
  const tool = openPullRequestTool({
    deliveries,
    publisher,
    ownsTask: (runId, taskId) => (runId === 'run_1' && taskId === 'tsk_1') || taskId === 'tsk_none',
  });
  await assert.rejects(
    tool.impl({ taskId: 'tsk_1', title: 'x' }, context('run_2')),
    /^ToolRefusal: |not_your_task/,
  );
  await assert.rejects(tool.impl({ taskId: 'tsk_none', title: 'x' }, context()), /not_verified/);
  publisher.problem = 'MAKA_GITHUB_TOKEN is not a fine-grained token';
  await assert.rejects(
    tool.impl({ taskId: 'tsk_1', title: 'x' }, context()),
    /github_token: MAKA_GITHUB_TOKEN is not a fine-grained token/,
  );
  publisher.problem = undefined;
  await fs.writeFile(changesPath, JSON.stringify({ ...CHANGES, files: [] }));
  await assert.rejects(tool.impl({ taskId: 'tsk_1', title: 'x' }, context()), /change_modified/);
  assert.equal(publisher.calls, 0);
});

test('two calls at once open one pull request, and a later call returns it without publishing again', async (t) => {
  const { deliveries } = await deliveryFiles(t);
  const publisher = new CountingPublisher();
  const tool = openPullRequestTool({ deliveries, publisher, ownsTask: () => true });
  const first = tool.impl({ taskId: 'tsk_1', title: 'Fix add' }, context());
  const second = tool.impl({ taskId: 'tsk_1', title: 'Fix add' }, context());
  while (!publisher.release) await new Promise((resolve) => setImmediate(resolve));
  publisher.release();
  const results = await Promise.all([first, second]);
  assert.equal(publisher.calls, 1);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(await tool.impl({ taskId: 'tsk_1', title: 'Fix add' }, context()), {
    url: 'https://github.com/acme/calc/pull/7',
    number: 7,
    branch: 'maka/tsk_1',
    alreadyOpen: true,
  });
  assert.equal(publisher.calls, 1);
  assert.equal((await deliveries.get('tsk_1'))?.publishedPr?.number, 7);
});

test('end to end against the fake GitHub: the body comes from the verification record', async (t) => {
  const { deliveries } = await deliveryFiles(t);
  const fake = await github(t);
  const tool = openPullRequestTool({
    deliveries,
    publisher: publisher(fake),
    ownsTask: () => true,
  });
  const result = (await tool.impl({ taskId: 'tsk_1', title: 'Fix add' }, context())) as {
    url: string;
  };
  assert.equal(result.url, `https://github.com/${REPO}/pull/1`);
  assert.equal(fake.pulls[0]?.body, pullRequestBody(VERIFICATION));
  assert.match(fake.pulls[0]?.body ?? '', /`bash tests\/run.sh` passed/);
  assert.match(
    fake.pulls[0]?.body ?? '',
    /failed on the base commit aaaaaaaaaaaa with the rest of this change reverted, and passes with it/,
  );
});

test('deliveries in a JSON file survive a restart', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'deliveries-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'deliveries.json');
  const store = new JsonFileCodingDeliveries(path);
  const delivery = {
    taskId: 'tsk_1',
    repo: REPO,
    baseRef: 'main',
    baseSha: BASE,
    changesPath: '/x/changes.json',
    changesSha256: 'h',
    verificationPath: '/x/verification.json',
  };
  await Promise.all([store.record(delivery), store.record({ ...delivery, taskId: 'tsk_2' })]);
  await store.markPublished('tsk_1', { url: 'u', number: 1, branch: 'maka/tsk_1' });
  const reopened = new JsonFileCodingDeliveries(path);
  assert.deepEqual(await reopened.get('tsk_1'), {
    ...delivery,
    publishedPr: { url: 'u', number: 1, branch: 'maka/tsk_1' },
  });
  assert.equal((await reopened.get('tsk_2'))?.taskId, 'tsk_2');
});
