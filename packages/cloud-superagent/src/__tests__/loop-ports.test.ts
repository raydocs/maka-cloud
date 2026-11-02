import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { HttpCoder, createCoderFromEnv, parseCoderJson } from '../loop-coder.js';
import { ADD_FIXED } from '../loop.js';
import { HttpGitHost, createGitHostFromEnv, githubTokenProblem } from '../loop-github.js';
import { initLocalRepo } from '../workspace.js';
import { scratchFiles } from '../loop.js';

test('githubTokenProblem refuses classic tokens and empty values', () => {
  assert.match(githubTokenProblem(undefined) ?? '', /not set/);
  assert.match(githubTokenProblem('ghp_classic') ?? '', /fine-grained/);
  assert.equal(githubTokenProblem('github_pat_ok'), undefined);
});

test('createCoderFromEnv and createGitHostFromEnv stay fake unless live plus keys', () => {
  assert.equal(createCoderFromEnv({}).kind, 'fake');
  assert.equal(createCoderFromEnv({ ANTHROPIC_API_KEY: 'sk-x' }).kind, 'fake');
  assert.equal(createGitHostFromEnv({}).kind, 'fake');
  assert.equal(createGitHostFromEnv({ MAKA_GITHUB_TOKEN: 'github_pat_x' }).kind, 'fake');
  assert.throws(
    () =>
      createGitHostFromEnv({
        MAKA_CLOUD_LOOP_LIVE: '1',
        MAKA_GITHUB_TOKEN: 'ghp_nope',
        MAKA_CLOUD_LOOP_REPO: 'acme/scratch',
      }),
    /fine-grained/,
  );
  assert.throws(
    () =>
      createGitHostFromEnv({
        MAKA_CLOUD_LOOP_LIVE: '1',
        MAKA_GITHUB_TOKEN: 'github_pat_ok',
      }),
    /MAKA_CLOUD_LOOP_REPO/,
  );
});

test('HttpCoder writes model files and falls back on garbage', async () => {
  const dir = await initLocalRepo(scratchFiles());
  const event = {
    eventId: 'e',
    tenantId: 't',
    source: 'github' as const,
    type: 'pr_opened' as const,
    subject: null,
    idempotencyKey: 'k',
    actor: { login: 'alice' as const, kind: 'user' as const },
    occurredAt: 1,
    receivedAt: 1,
    summary: 'fix add',
    fields: [],
    closesSubject: false,
  };
  const worker = { workerId: 'wrk' } as never;
  const coded = new HttpCoder(async () =>
    JSON.stringify({ summary: 'fixed add', files: { 'add.js': ADD_FIXED } }),
  );
  const result = await coded.apply({ dir, brief: 'fix add', event, worker });
  assert.equal(result.summary, 'fixed add');
  assert.equal(await readFile(join(dir, 'add.js'), 'utf8'), ADD_FIXED);

  const fallback = new HttpCoder(async () => 'not json');
  const second = await fallback.apply({ dir, brief: 'fix add', event, worker });
  assert.match(second.summary, /fake coder/);
  assert.equal(parseCoderJson('```json\n{"files":{"a.js":"x"}}\n```')?.files['a.js'], 'x');
});

test('HttpGitHost publishes blobs and opens a PR without putting the token on argv', async () => {
  const seen: Array<{ method: string; url: string; auth: string | undefined; body: unknown }> = [];
  let pulls = 0;
  let branchExists = false;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const url = req.url ?? '';
      const method = req.method ?? 'GET';
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      seen.push({ method, url, auth: header(req, 'authorization'), body });
      const reply = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (method === 'GET' && url === '/repos/acme/scratch') {
        reply(200, { default_branch: 'main' });
        return;
      }
      if (method === 'GET' && url.includes('/git/ref/heads/main')) {
        reply(200, { object: { sha: 'base111' } });
        return;
      }
      if (method === 'GET' && url.includes('/git/commits/')) {
        reply(200, { tree: { sha: 'tree111' } });
        return;
      }
      if (method === 'POST' && url.endsWith('/git/blobs')) {
        reply(201, { sha: `blob${seen.length}` });
        return;
      }
      if (method === 'POST' && url.endsWith('/git/trees')) {
        reply(201, { sha: 'tree222' });
        return;
      }
      if (method === 'POST' && url.endsWith('/git/commits')) {
        reply(201, { sha: 'commit999' });
        return;
      }
      if (method === 'GET' && url.includes('/git/ref/heads/maka')) {
        if (!branchExists) {
          reply(404, { message: 'Not Found' });
          return;
        }
        reply(200, { object: { sha: 'old' } });
        return;
      }
      if (method === 'POST' && url.endsWith('/git/refs')) {
        branchExists = true;
        reply(201, { object: { sha: 'commit999' } });
        return;
      }
      if (method === 'PATCH' && url.includes('/git/refs/heads/maka')) {
        reply(200, { object: { sha: 'commit999' } });
        return;
      }
      if (method === 'GET' && url.startsWith('/repos/acme/scratch/pulls')) {
        reply(
          200,
          pulls === 0 ? [] : [{ html_url: 'https://github.com/acme/scratch/pull/3', number: 3 }],
        );
        return;
      }
      if (method === 'POST' && url === '/repos/acme/scratch/pulls') {
        pulls += 1;
        reply(201, { html_url: 'https://github.com/acme/scratch/pull/3', number: 3 });
        return;
      }
      if (method === 'PATCH' && url === '/repos/acme/scratch/pulls/3') {
        reply(200, { html_url: 'https://github.com/acme/scratch/pull/3', number: 3 });
        return;
      }
      reply(500, { message: `unhandled ${method} ${url}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const dir = await initLocalRepo(scratchFiles(false));
    const git = new HttpGitHost({
      token: 'github_pat_test-token',
      repo: 'acme/scratch',
      baseUrl: `http://127.0.0.1:${port}`,
    });
    const pushed = await git.commitAndPush({
      dir,
      branch: 'maka/sa-wrk',
      message: 'superagent: fix add',
      repo: 'acme/scratch',
    });
    assert.equal(pushed.sha, 'commit999');
    const pr = await git.openOrUpdatePullRequest({
      repo: 'acme/scratch',
      branch: 'maka/sa-wrk',
      base: 'main',
      title: 'fix add',
      body: 'Evidence',
    });
    assert.equal(pr.url, 'https://github.com/acme/scratch/pull/3');
    assert.ok(seen.every((row) => row.auth === 'Bearer github_pat_test-token'));
    assert.ok(seen.some((row) => row.method === 'POST' && row.url.endsWith('/git/blobs')));
    assert.ok(!JSON.stringify(seen.map((row) => row.body)).includes('github_pat_test-token'));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
