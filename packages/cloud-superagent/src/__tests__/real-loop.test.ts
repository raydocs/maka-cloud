import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { scratchFiles } from '../loop.js';
import { FakeSandbox } from '../sandbox.js';
import { formatRealLoopReport, runRealLoop } from '../real-loop.js';
import { initLocalRepo } from '../workspace.js';

test('real-loop fake path clones, tests, pushes, resumes CI/review, holds merge', async () => {
  const sandbox = new FakeSandbox();
  const report = await runRealLoop({ sandbox, env: {} });
  assert.equal(report.ok, true);
  assert.equal(report.live, false);
  assert.equal(report.coder, 'fake');
  assert.equal(report.git, 'fake');
  assert.ok(report.workerId);
  assert.ok(report.branch?.startsWith('maka/sa-'));
  assert.ok(report.prUrl);
  assert.ok(report.steps.includes('spawn'));
  assert.ok(report.steps.includes('push'));
  assert.ok(report.steps.includes('ci-resume'));
  assert.ok(report.steps.includes('review-resume'));
  assert.ok(report.steps.includes('merge-held'));
  assert.ok(report.steps.includes('merge-approved'));
  assert.equal(report.boxed, true);
  assert.ok(report.steps.includes('box-materialize'));
  assert.ok(report.steps.includes('box-test'));
  assert.match(report.evidence, /### Evidence/);
  assert.ok(
    sandbox.commands.some((row) => row.cmd.includes('src.tgz') || row.cmd.includes('tar ')),
  );
  assert.ok(sandbox.commands.some((row) => row.cmd === 'node add.test.js'));
  assert.ok(!sandbox.commands.some((row) => row.cmd.startsWith('echo loop-verify')));
  assert.match(formatRealLoopReport(report), /ok: true/);
});

test('real-loop does not go live without MAKA_CLOUD_LOOP_LIVE=1', async () => {
  const report = await runRealLoop({
    env: { INSTABOX_API_KEY: 'ibx-must-not-be-used' },
    sandbox: new FakeSandbox(),
  });
  assert.equal(report.live, false);
  assert.equal(report.machineId, null);
  assert.equal(report.ok, true);
});

test('live public clone runs tests in the box and does not need a GitHub token', async () => {
  const cloneUrl = await initLocalRepo(scratchFiles(false));
  const sandbox = new FakeSandbox();
  const report = await runRealLoop({
    sandbox,
    cloneUrl,
    env: { MAKA_CLOUD_LOOP_LIVE: '1', MAKA_CLOUD_LOOP_TEST: 'node add.test.js' },
  });
  assert.equal(report.ok, true, report.error ?? '');
  assert.equal(report.live, true);
  assert.equal(report.git, 'fake');
  assert.equal(report.boxed, true);
  assert.equal(report.prUrl, null);
  assert.ok(report.steps.includes('box-test'));
  assert.ok(!report.steps.includes('push'));
  assert.ok(sandbox.commands.some((row) => row.cmd.includes('git clone')));
  assert.ok(sandbox.commands.every((row) => !/github_pat_|INSTABOX_API_KEY/.test(row.cmd)));
});

test('live flag with a fake box still forces act and keeps merge on the fake host', async () => {
  const report = await runRealLoop({
    sandbox: new FakeSandbox(),
    env: { MAKA_CLOUD_LOOP_LIVE: '1' },
  });
  assert.equal(report.live, true);
  assert.equal(report.machineId, null);
  assert.equal(report.coder, 'fake');
  assert.equal(report.git, 'fake');
  assert.equal(report.ok, true);
  assert.ok(report.steps.includes('merge-approved'));
});

test('live GitHub host opens a PR through a mock API and does not auto-merge', async () => {
  let pulls = 0;
  let branchExists = false;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const url = req.url ?? '';
      const method = req.method ?? 'GET';
      const reply = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (method === 'GET' && url === '/repos/acme/scratch')
        return reply(200, { default_branch: 'main' });
      if (method === 'GET' && url.includes('/git/ref/heads/main')) {
        return reply(200, { object: { sha: 'base111' } });
      }
      if (method === 'GET' && url.includes('/git/commits/')) {
        return reply(200, { tree: { sha: 'tree111' } });
      }
      if (method === 'POST' && url.endsWith('/git/blobs')) return reply(201, { sha: 'blob1' });
      if (method === 'POST' && url.endsWith('/git/trees')) return reply(201, { sha: 'tree222' });
      if (method === 'POST' && url.endsWith('/git/commits'))
        return reply(201, { sha: 'commit999' });
      if (method === 'GET' && url.includes('/git/ref/heads/maka')) {
        return branchExists
          ? reply(200, { object: { sha: 'old' } })
          : reply(404, { message: 'Not Found' });
      }
      if (method === 'POST' && url.endsWith('/git/refs')) {
        branchExists = true;
        return reply(201, {});
      }
      if (method === 'PATCH' && url.includes('/git/refs/heads/')) return reply(200, {});
      if (method === 'GET' && url.startsWith('/repos/acme/scratch/pulls')) {
        return reply(
          200,
          pulls === 0 ? [] : [{ html_url: 'https://github.com/acme/scratch/pull/9', number: 9 }],
        );
      }
      if (method === 'POST' && url === '/repos/acme/scratch/pulls') {
        pulls += 1;
        return reply(201, { html_url: 'https://github.com/acme/scratch/pull/9', number: 9 });
      }
      if (method === 'PATCH' && url.startsWith('/repos/acme/scratch/pulls/')) {
        return reply(200, { html_url: 'https://github.com/acme/scratch/pull/9', number: 9 });
      }
      if (method === 'PUT' && url.includes('/merge'))
        return reply(500, { message: 'must not merge' });
      reply(500, { message: `unhandled ${method} ${url}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const report = await runRealLoop({
      sandbox: new FakeSandbox(),
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const rewritten = url.replace('https://api.github.com', `http://127.0.0.1:${port}`);
        return fetch(rewritten, init);
      },
      env: {
        MAKA_CLOUD_LOOP_LIVE: '1',
        MAKA_GITHUB_TOKEN: 'github_pat_test-live',
        MAKA_CLOUD_LOOP_REPO: 'acme/scratch',
      },
    });
    assert.equal(report.ok, true, report.error ?? '');
    assert.equal(report.git, 'github');
    assert.equal(report.prUrl, 'https://github.com/acme/scratch/pull/9');
    assert.ok(report.steps.includes('merge-held'));
    assert.ok(!report.steps.includes('merge-approved'));
    assert.ok(!JSON.stringify(report).includes('github_pat_test-live'));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
