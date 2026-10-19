import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { InstaboxClient } from '../client.js';
import { INSTABOX_MAX_FILE_BYTES, InstaboxWorkspaceExecutor } from '../executor.js';
import { setup, type Harness } from './harness.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('InstaboxWorkspaceExecutor paths', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const scope = 'workspace' as const;

  it('resolves existing relative and absolute paths to the canonical path', async () => {
    await fs.mkdir(join(h.work, 'src'));
    await fs.writeFile(join(h.work, 'src', 'a.txt'), 'a');
    const relative = await h.executor.resolveExistingPath({
      cwd: h.work,
      path: 'src/a.txt',
      label: 'Read',
      scope,
    });
    const absolute = await h.executor.resolveExistingPath({
      cwd: h.work,
      path: join(h.work, 'src', '..', 'src', 'a.txt'),
      label: 'Read',
      scope,
    });
    assert.equal(relative.path, join(h.work, 'src', 'a.txt'));
    assert.equal(absolute.path, relative.path);
  });

  it('reports a missing file as ENOENT', async () => {
    await assert.rejects(
      h.executor.resolveExistingPath({ cwd: h.work, path: 'nope.txt', label: 'Read', scope }),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    );
  });

  it('resolves a not-yet-existing writable path through its existing ancestors', async () => {
    const resolved = await h.executor.resolveWritablePath({
      cwd: h.work,
      path: 'new/file.txt',
      label: 'Write',
      scope,
    });
    assert.equal(resolved.path, join(h.work, 'new', 'file.txt'));
  });

  it('rejects paths that leave the workspace', async () => {
    for (const path of ['../outside/x', join(h.outside, 'x'), '/etc/passwd']) {
      await assert.rejects(
        h.executor.resolveWritablePath({ cwd: h.work, path, label: 'Write', scope }),
        (error: NodeJS.ErrnoException) =>
          error.code === 'EACCES' && /must stay inside session cwd/.test(error.message),
        path,
      );
    }
  });

  it('rejects a symlink inside the workspace that points outside', async () => {
    await fs.writeFile(join(h.outside, 'secret.txt'), 'secret');
    await fs.symlink(h.outside, join(h.work, 'link'));
    await assert.rejects(
      h.executor.resolveExistingPath({
        cwd: h.work,
        path: 'link/secret.txt',
        label: 'Read',
        scope,
      }),
      (error: NodeJS.ErrnoException) => error.code === 'EACCES',
    );
    await assert.rejects(
      h.executor.resolveWritablePath({ cwd: h.work, path: 'link/new.txt', label: 'Write', scope }),
      (error: NodeJS.ErrnoException) => error.code === 'EACCES',
    );
  });

  it('rejects host path scope explicitly', async () => {
    await assert.rejects(
      h.executor.resolveExistingPath({
        cwd: h.work,
        path: '/etc/hosts',
        label: 'Read',
        scope: 'host',
      }),
      (error: NodeJS.ErrnoException) =>
        error.code === 'EACCES' && /host path scope/.test(error.message),
    );
    assert.equal(h.fake.execRequests.length, 0);
  });

  it('gives every spelling of one file the same lock key, and a different key per sandbox', async () => {
    await fs.writeFile(join(h.work, 'a.txt'), 'a');
    await fs.symlink(join(h.work, 'a.txt'), join(h.work, 'alias.txt'));
    const keys = await Promise.all(
      ['a.txt', join(h.work, 'a.txt'), './a.txt', 'alias.txt'].map((path) =>
        h.executor.writeLockKey({ cwd: h.work, path }),
      ),
    );
    assert.equal(new Set(keys.map((k) => k.key)).size, 1);
    assert.ok(keys[0]?.key.startsWith(`${h.fake.machineId}:`));
    const entry = await h.executor.writeLockKey({
      cwd: h.work,
      path: 'alias.txt',
      semantics: 'entry',
    });
    assert.equal(entry.key, `${h.fake.machineId}:${join(h.work, 'alias.txt')}`);
  });
});

describe('InstaboxWorkspaceExecutor.readFile', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const filesApiCalls = () => h.fake.requestsTo('GET', /\/files$/);

  it('reads small text through GET /files', async () => {
    await fs.writeFile(join(h.work, 'a.txt'), 'one\ntwo\nthree');
    const result = await h.executor.readFile({ cwd: h.work, path: 'a.txt' });
    assert.deepEqual(result, { content: 'one\ntwo\nthree' });
    assert.equal(filesApiCalls().length, 1);
    assert.equal(filesApiCalls()[0]?.query.get('path'), join(h.work, 'a.txt'));
  });

  it('applies the line window', async () => {
    await fs.writeFile(join(h.work, 'a.txt'), 'one\ntwo\nthree\nfour');
    const result = await h.executor.readFile({ cwd: h.work, path: 'a.txt', offset: 1, limit: 2 });
    assert.deepEqual(result, { content: 'two\nthree' });
  });

  it('returns an empty text file as empty without calling GET /files', async () => {
    await fs.writeFile(join(h.work, 'empty.txt'), '');
    assert.deepEqual(await h.executor.readFile({ cwd: h.work, path: 'empty.txt' }), {
      content: '',
    });
    assert.equal(filesApiCalls().length, 0);
  });

  it('never treats empty GET /files content as an empty file: a binary file is read with exec', async () => {
    const bytes = Buffer.from([0x61, 0xff, 0xfe, 0x62, 0x00, 0x63]);
    await fs.writeFile(join(h.work, 'blob.dat'), bytes);
    const result = await h.executor.readFile({ cwd: h.work, path: 'blob.dat' });
    assert.equal(filesApiCalls().length, 1);
    assert.ok('content' in result);
    assert.equal(result.content, bytes.toString('utf8'));
    assert.notEqual(result.content, '');
  });

  it('falls back to exec when GET /files returns empty content for a non-empty file', async () => {
    await fs.writeFile(join(h.work, 'a.txt'), 'real content');
    // The API answers with empty content for a 12-byte file: that must not read as "empty".
    const emptying: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!String(input).includes('/files')) return response;
      return new Response(JSON.stringify({ ...(await response.json()), content: '' }), {
        status: 200,
      });
    };
    const executor = new InstaboxWorkspaceExecutor({
      client: new InstaboxClient({ apiKey: h.fake.apiKey, baseUrl: h.fake.url, fetch: emptying }),
      machineId: h.fake.machineId,
    });
    assert.deepEqual(await executor.readFile({ cwd: h.work, path: 'a.txt' }), {
      content: 'real content',
    });
    assert.equal(filesApiCalls().length, 1);
    assert.ok(
      h.fake.execRequests.some((r) => r.body.envs?.MAKA_OFFSET === '0'),
      'content came from exec',
    );
  });

  it('reads text above the GET /files cap with exec in several chunks', async () => {
    const line = 'x'.repeat(99) + '\n';
    const text = line.repeat(Math.ceil((1.3 * 1024 * 1024) / line.length));
    await fs.writeFile(join(h.work, 'big.txt'), text);
    const result = await h.executor.readFile({ cwd: h.work, path: 'big.txt' });
    assert.ok('content' in result && result.content === text);
    assert.equal(filesApiCalls().length, 0);
    const reads = h.fake.execRequests.filter((r) => r.body.envs?.MAKA_OFFSET !== undefined);
    assert.equal(reads.length, 3);
    assert.deepEqual(
      reads.map((r) => r.body.envs.MAKA_OFFSET),
      ['0', String(512 * 1024), String(1024 * 1024)],
    );
  });

  it('returns a supported image as bytes and a mime type', async () => {
    await fs.writeFile(join(h.work, 'pixel.png'), PNG_1X1);
    const result = await h.executor.readFile({ cwd: h.work, path: 'pixel.png' });
    assert.ok('bytes' in result);
    assert.equal(result.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(result.bytes), PNG_1X1);
    assert.equal(filesApiCalls().length, 0);
  });

  it('recognises an image by content when the name gives no hint', async () => {
    await fs.writeFile(join(h.work, 'pixel.dat'), PNG_1X1);
    const result = await h.executor.readFile({ cwd: h.work, path: 'pixel.dat' });
    assert.ok('bytes' in result && result.mimeType === 'image/png');
  });

  it('rejects an invalid image', async () => {
    await fs.writeFile(join(h.work, 'broken.png'), 'not a png');
    await assert.rejects(
      h.executor.readFile({ cwd: h.work, path: 'broken.png' }),
      /not a supported PNG/,
    );
  });

  it('rejects a read outside the workspace and never calls GET /files', async () => {
    await fs.writeFile(join(h.outside, 'secret.txt'), 'secret');
    for (const path of [join(h.outside, 'secret.txt'), '../outside/secret.txt', '/etc/passwd']) {
      await assert.rejects(
        h.executor.readFile({ cwd: h.work, path }),
        (error: NodeJS.ErrnoException) =>
          error.code === 'EACCES' && /must stay inside session cwd/.test(error.message),
        path,
      );
    }
    assert.equal(filesApiCalls().length, 0);
  });

  it('rejects a symlink inside the workspace that points outside and never calls GET /files', async () => {
    await fs.writeFile(join(h.outside, 'secret.txt'), 'secret');
    await fs.symlink(join(h.outside, 'secret.txt'), join(h.work, 'innocent.txt'));
    await assert.rejects(
      h.executor.readFile({ cwd: h.work, path: 'innocent.txt' }),
      (error: NodeJS.ErrnoException) => error.code === 'EACCES',
    );
    assert.equal(filesApiCalls().length, 0);
  });

  it('refuses a directory and a missing file', async () => {
    await fs.mkdir(join(h.work, 'dir'));
    await assert.rejects(h.executor.readFile({ cwd: h.work, path: 'dir' }), /Not a regular file/);
    await assert.rejects(
      h.executor.readFile({ cwd: h.work, path: 'missing.txt' }),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    );
  });

  it('resumes a paused sandbox for GET /files', async () => {
    await fs.writeFile(join(h.work, 'a.txt'), 'hello');
    const resolved = await h.executor.readFile({ cwd: h.work, path: 'a.txt' });
    assert.ok('content' in resolved);
    h.fake.machineState = 'suspended';
    assert.deepEqual(await h.executor.readFile({ cwd: h.work, path: 'a.txt' }), {
      content: 'hello',
    });
    assert.equal(h.fake.requestsTo('POST', /\/resume$/).length, 1);
  });

  it('refuses files above the sandbox transfer limit', async () => {
    await fs.writeFile(join(h.work, 'huge.bin'), '');
    await fs.truncate(join(h.work, 'huge.bin'), INSTABOX_MAX_FILE_BYTES + 1);
    await assert.rejects(h.executor.readFile({ cwd: h.work, path: 'huge.bin' }), /limited to/);
  });
});

describe('InstaboxWorkspaceExecutor.writeFile', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const writeChunks = () =>
    h.fake.execRequests.filter(
      (r) => r.body.envs?.MAKA_TMP && r.body.envs?.MAKA_FIRST !== undefined,
    );
  const leftovers = async (dir = h.work) =>
    (await fs.readdir(dir)).filter((name) => name.includes('.maka-'));

  it('writes new and existing files and reports the byte count', async () => {
    const path = join(h.work, 'a.txt');
    assert.deepEqual(await h.executor.writeFile({ cwd: h.work, path, content: 'héllo' }), {
      ok: true,
      path,
      bytes: 6,
    });
    assert.equal(await fs.readFile(path, 'utf8'), 'héllo');
    await h.executor.writeFile({ cwd: h.work, path, content: 'second' });
    assert.equal(await fs.readFile(path, 'utf8'), 'second');
    assert.deepEqual(await leftovers(), []);
  });

  it('writes an empty file', async () => {
    const path = join(h.work, 'empty.txt');
    await fs.writeFile(path, 'old');
    await h.executor.writeFile({ cwd: h.work, path, content: '' });
    assert.equal((await fs.stat(path)).size, 0);
  });

  it('survives quotes, command substitution, heredoc markers and control characters', async () => {
    const content = [
      `it's "quoted" \`backtick\` $(touch pwned) \${HOME} $'x'`,
      'EOF',
      "'; rm -rf /tmp/nothing; echo '",
      'tab\there\r\nwindows line',
      'nul\u0000inside and ☃ and \u{1F600}',
      'no trailing newline',
    ].join('\n');
    const path = join(h.work, "we ird 'name' $(x).txt");
    await h.executor.writeFile({ cwd: h.work, path, content });
    assert.equal(await fs.readFile(path, 'utf8'), content);
    await assert.rejects(fs.stat(join(h.work, 'pwned')));
    await assert.rejects(fs.stat(join(process.cwd(), 'pwned')));
  });

  it('keeps the target mode when it overwrites a file', async () => {
    const path = join(h.work, 'run.sh');
    await fs.writeFile(path, '#!/bin/sh\n');
    await fs.chmod(path, 0o755);
    await h.executor.writeFile({ cwd: h.work, path, content: '#!/bin/sh\necho hi\n' });
    assert.equal((await fs.stat(path)).mode & 0o777, 0o755);
  });

  it('writes a file larger than one request in several chunks', async () => {
    const content = 'abcdefghij'.repeat(Math.ceil((3.2 * 1024 * 1024) / 10));
    const path = join(h.work, 'big.txt');
    const result = await h.executor.writeFile({ cwd: h.work, path, content });
    assert.equal(result.bytes, Buffer.byteLength(content));
    assert.equal(await fs.readFile(path, 'utf8'), content);
    const requests = writeChunks();
    assert.equal(requests.length, 7);
    assert.deepEqual(
      requests.map((r) => r.body.envs.MAKA_FIRST),
      ['1', '0', '0', '0', '0', '0', '0'],
    );
    assert.deepEqual(
      requests.map((r) => r.body.envs.MAKA_LAST),
      ['0', '0', '0', '0', '0', '0', '1'],
    );
    assert.ok(requests.every((r) => r.body.stdin.length <= 1024 * 1024));
    assert.ok(requests.every((r) => r.body.cmd.length < 64 * 1024));
    assert.equal(new Set(requests.map((r) => r.body.envs.MAKA_TMP)).size, 1);
    assert.deepEqual(await leftovers(), []);
  });

  it('writes multi-byte characters that straddle a chunk boundary', async () => {
    const content = '€'.repeat(Math.ceil((600 * 1024) / 3));
    const path = join(h.work, 'euro.txt');
    await h.executor.writeFile({ cwd: h.work, path, content });
    assert.equal(await fs.readFile(path, 'utf8'), content);
  });

  it('leaves the original untouched and removes the temp file when a chunk fails halfway', async () => {
    const path = join(h.work, 'keep.txt');
    await fs.writeFile(path, 'original');
    h.fake.onExec = (request) =>
      request.body.envs?.MAKA_FIRST === '0' && request.body.envs?.MAKA_LAST === '0'
        ? { status: 500, error: { code: 'internal', message: 'disk exploded', retryable: false } }
        : undefined;
    const content = 'z'.repeat(2 * 1024 * 1024);
    await assert.rejects(h.executor.writeFile({ cwd: h.work, path, content }), /internal/);
    assert.equal(await fs.readFile(path, 'utf8'), 'original');
    assert.deepEqual(await leftovers(), []);
    assert.ok(
      h.fake.execRequests.some((r) => r.body.cmd.includes('rm -f')),
      'cleanup ran',
    );
  });

  it('leaves the original untouched when the connection drops before the final rename', async () => {
    const path = join(h.work, 'keep.txt');
    await fs.writeFile(path, 'original');
    h.fake.onExec = (request) =>
      request.body.envs?.MAKA_LAST === '1' ? { drop: true } : undefined;
    await assert.rejects(
      h.executor.writeFile({ cwd: h.work, path, content: 'y'.repeat(700 * 1024) }),
    );
    assert.equal(await fs.readFile(path, 'utf8'), 'original');
    assert.deepEqual(await leftovers(), []);
  });

  it('reports a corrupt chunk, keeps the original and removes the temp file', async () => {
    const path = join(h.work, 'keep.txt');
    await fs.writeFile(path, 'original');
    h.fake.onExec = (request) =>
      request.body.envs?.MAKA_FIRST === '0' ? { stdin: '!!!not-base64!!!' } : undefined;
    await assert.rejects(
      h.executor.writeFile({ cwd: h.work, path, content: 'q'.repeat(700 * 1024) }),
      /chunk 2 of 2.*could not be decoded/s,
    );
    assert.equal(await fs.readFile(path, 'utf8'), 'original');
    assert.deepEqual(await leftovers(), []);
  });

  it('fails cleanly when the directory is missing', async () => {
    await assert.rejects(
      h.executor.writeFile({
        cwd: h.work,
        path: join(h.work, 'no', 'such', 'dir.txt'),
        content: 'x',
      }),
      /missing directory or no permission/,
    );
    assert.deepEqual(await leftovers(), []);
  });

  it('does not move the file into a directory when the target is a directory', async () => {
    const dir = join(h.work, 'dir');
    await fs.mkdir(dir);
    await assert.rejects(
      h.executor.writeFile({ cwd: h.work, path: dir, content: 'x' }),
      /final rename failed/,
    );
    assert.deepEqual(await fs.readdir(dir), []);
    assert.deepEqual(await leftovers(), []);
  });

  it('rejects content above the transfer limit and relative paths', async () => {
    await assert.rejects(
      h.executor.writeFile({
        cwd: h.work,
        path: join(h.work, 'x'),
        content: 'a'.repeat(INSTABOX_MAX_FILE_BYTES + 1),
      }),
      /limited to/,
    );
    await assert.rejects(
      h.executor.writeFile({ cwd: h.work, path: 'x.txt', content: 'x' }),
      /absolute/,
    );
    assert.equal(h.fake.execRequests.length, 0);
  });

  it('round trips through readFile', async () => {
    const content = 'line 1\nline 2 ünï\n'.repeat(40_000);
    const path = join(h.work, 'round.txt');
    await h.executor.writeFile({ cwd: h.work, path, content });
    assert.deepEqual(await h.executor.readFile({ cwd: h.work, path }), { content });
  });
});
