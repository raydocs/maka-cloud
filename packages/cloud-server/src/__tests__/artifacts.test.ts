import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { type ArtifactRead, type ArtifactSource, FileArtifactSource } from '../artifacts.js';
import { conductorSession, recordingHandler } from './conductor.js';
import { eventually, type Harness, newConversation, startHarness } from './harness.js';

type Options = Parameters<typeof startHarness>[1];

async function setup(t: TestContext, options: Options = {}) {
  const { handler, seen } = recordingHandler();
  const h = await startHarness(t, { handler, ...options });
  const conversationId = await newConversation(h);
  const { session } = await conductorSession(h, seen, conversationId);
  /** Runs a task to success with these artifact references and files in its directory. */
  const finished = async (artifacts: string[] | undefined, files: Record<string, string> = {}) => {
    const before = h.fake.runs.length;
    const task = await h.server.orchestrator.delegate(session, { runner: 'fake', brief: 'work' });
    await eventually(() => h.fake.runs.length > before, 'run');
    const run = h.fake.runFor(task.taskId);
    const dir = dirname(run.spec.resultPath);
    for (const [name, content] of Object.entries(files)) {
      await mkdir(dirname(join(dir, name)), { recursive: true });
      await writeFile(join(dir, name), content);
    }
    await run.complete({
      summary: 'done',
      done: ['x'],
      notDone: [],
      confidence: 'high',
      knownIssues: [],
      ...(artifacts === undefined ? {} : { artifacts }),
    });
    await h.server.orchestrator.wait(session, task.taskId, 2000);
    return { taskId: task.taskId, dir };
  };
  return { h, conversationId, finished };
}

const get = (h: Harness, taskId: string, rest: string, token?: string | null) =>
  h.api(`/v1/tasks/${taskId}/artifacts${rest}`, token === undefined ? {} : { token });

test('the manifest lists its references and each file comes back as an attachment, never as a page', async (t) => {
  const { h, finished } = await setup(t);
  const { taskId } = await finished(['report.md', 'out/changes.diff', 'data.json'], {
    'report.md': '# Findings\n<script>alert(1)</script>',
    'out/changes.diff': '--- a\n+++ b\n',
    'data.json': '{"a":1}',
  });
  const listing = await get(h, taskId, '');
  assert.equal(listing.status, 200);
  assert.deepEqual(await listing.json(), {
    artifacts: [
      { index: 0, name: 'report.md', kind: 'file' },
      { index: 1, name: 'changes.diff', kind: 'file' },
      { index: 2, name: 'data.json', kind: 'file' },
    ],
    total: 3,
  });

  const report = await get(h, taskId, '/0');
  assert.equal(report.status, 200);
  assert.equal(await report.text(), '# Findings\n<script>alert(1)</script>');
  assert.equal(report.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(report.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(report.headers.get('content-disposition'), 'attachment; filename="report.md"');
  assert.match(report.headers.get('content-security-policy') ?? '', /sandbox/u);
  assert.equal(await (await get(h, taskId, '/1')).text(), '--- a\n+++ b\n');
  assert.equal(
    (await get(h, taskId, '/2')).headers.get('content-type'),
    'application/json; charset=utf-8',
  );
});

test("a research run's exported report is served as both files, never as a page", async (t) => {
  const { h, finished } = await setup(t);
  const { taskId } = await finished(['out/report.md', 'out/report.html', 'out/verification.json'], {
    'out/report.md': '# Report\n',
    'out/report.html': '<h1>Report</h1><script>alert(1)</script>',
    'out/verification.json': '{"checked":3}',
  });
  assert.deepEqual(await (await get(h, taskId, '')).json(), {
    artifacts: [
      { index: 0, name: 'report.md', kind: 'file' },
      { index: 1, name: 'report.html', kind: 'file' },
      { index: 2, name: 'verification.json', kind: 'file' },
    ],
    total: 3,
  });
  const html = await get(h, taskId, '/1');
  assert.equal(html.status, 200);
  assert.equal(await html.text(), '<h1>Report</h1><script>alert(1)</script>');
  assert.equal(html.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(html.headers.get('content-disposition'), 'attachment; filename="report.html"');
  assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
  assert.match(html.headers.get('content-security-policy') ?? '', /sandbox/u);
  assert.equal(await (await get(h, taskId, '/0')).text(), '# Report\n');
  assert.equal(await (await get(h, taskId, '/2')).text(), '{"checked":3}');
});

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR-and-the-rest'),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF')]);

test('a picture is sent as a picture only when its name and its own bytes agree', async (t) => {
  const { h, finished } = await setup(t);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  const { taskId, dir } = await finished(
    ['out/proof.png', 'photo.JPG', 'fake.png', 'shot.jpg', 'vector.svg', 'proof.png.txt', 'bare'],
    {},
  );
  const write = async (name: string, bytes: Buffer | string) => {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), bytes);
  };
  await write('out/proof.png', PNG);
  await write('photo.JPG', JPEG);
  await write('fake.png', '<html><script>alert(1)</script></html>');
  await write('shot.jpg', PNG);
  await write('vector.svg', svg);
  await write('proof.png.txt', PNG);
  await write('bare', PNG);

  const listing = (await (await get(h, taskId, '')).json()) as {
    artifacts: Array<{ name: string; image?: boolean }>;
  };
  assert.deepEqual(
    listing.artifacts.map((a) => [a.name, a.image === true]),
    [
      ['proof.png', true],
      ['photo.JPG', true],
      ['fake.png', true],
      ['shot.jpg', true],
      ['vector.svg', false],
      ['proof.png.txt', false],
      ['bare', false],
    ],
  );

  const png = await get(h, taskId, '/0');
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.equal(png.headers.get('x-content-type-options'), 'nosniff');
  assert.match(png.headers.get('content-security-policy') ?? '', /sandbox/u);
  assert.equal(png.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(png.headers.get('content-disposition'), 'attachment; filename="proof.png"');
  assert.deepEqual(Buffer.from(await png.arrayBuffer()), PNG);
  const jpg = await get(h, taskId, '/1');
  assert.equal(jpg.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await jpg.arrayBuffer()), JPEG);

  // A name that claims a picture over other bytes, and bytes of one under another name or a
  // different picture type, stay what they always were: plain text, never something to render.
  for (const index of [2, 3, 4, 5, 6]) {
    const res = await get(h, taskId, `/${index}`);
    assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8', String(index));
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment;/u);
  }
});

test('every route needs the invite, and unknown tasks, missing manifests and bad indexes are 404', async (t) => {
  const { h, finished } = await setup(t);
  const { taskId } = await finished(['a.md'], { 'a.md': 'a' });
  const none = (await finished(undefined)).taskId;
  for (const rest of ['', '/0']) {
    for (const token of [null, 'inv_x.y']) {
      assert.equal((await get(h, taskId, rest, token)).status, 401);
    }
  }
  assert.equal((await get(h, 'tsk_nope', '')).status, 404);
  assert.equal((await get(h, 'tsk_nope', '/0')).status, 404);
  assert.deepEqual(await (await get(h, none, '')).json(), { artifacts: [], total: 0 });
  for (const rest of ['/0', '/1', '/-1', '/x', '/1e3', '/0.5', '/99999999999']) {
    const res = await get(h, rest === '/0' ? none : taskId, rest);
    assert.equal(res.status, 404, rest);
  }
  const post = await h.api(`/v1/tasks/${taskId}/artifacts`, { method: 'POST' });
  assert.equal(post.status, 405);
});

test('a reference that is a path outside the task directory is 404 and nothing is read', async (t) => {
  const { h, finished } = await setup(t);
  const other = await finished(['x.md'], { 'x.md': 'other task secret' });
  await writeFile(join(h.dir, 'secret.txt'), 'outside the handoff root');
  const refs = [
    `../${other.taskId}/x.md`,
    '../../secret.txt',
    '/etc/passwd',
    join(h.dir, 'secret.txt'),
    'a/../../x.md',
    './x.md',
    'a//b',
    '%2e%2e/secret.txt',
    '..%2fsecret.txt',
    'sub\\..\\..\\secret.txt',
    'brief\0.md',
    'C:\\Windows\\win.ini',
    'file:///etc/passwd',
    'data:text/plain,hello',
    'http://127.0.0.1/x',
    '',
  ];
  const { taskId } = await finished(refs, { 'x.md': 'mine' });
  for (const [index, ref] of refs.entries()) {
    const res = await get(h, taskId, `/${index}`);
    assert.equal(res.status, 404, JSON.stringify(ref));
    assert.ok(!(await res.text()).includes('secret'), JSON.stringify(ref));
  }
});

test('symlinks are refused: a file, a directory in the path, and the task directory itself', async (t) => {
  const { h, finished } = await setup(t);
  const outside = join(h.dir, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'outside');
  const { taskId, dir } = await finished(['link.txt', 'dirlink/secret.txt', 'ok.txt'], {
    'ok.txt': 'fine',
  });
  await symlink(join(outside, 'secret.txt'), join(dir, 'link.txt'));
  await symlink(outside, join(dir, 'dirlink'));
  assert.equal((await get(h, taskId, '/0')).status, 404);
  assert.equal((await get(h, taskId, '/1')).status, 404);
  assert.equal(await (await get(h, taskId, '/2')).text(), 'fine');
  await rename(dir, `${dir}.moved`);
  await symlink(`${dir}.moved`, dir);
  assert.equal((await get(h, taskId, '/2')).status, 404);
});

test('a FIFO is refused without blocking, and a directory is not a file', async (t) => {
  const { h, finished } = await setup(t);
  const { taskId, dir } = await finished(['pipe', 'folder'], {});
  try {
    execFileSync('mkfifo', [join(dir, 'pipe')]);
  } catch {
    t.skip('mkfifo is not available');
    return;
  }
  await mkdir(join(dir, 'folder'));
  assert.equal((await get(h, taskId, '/0')).status, 404);
  assert.equal((await get(h, taskId, '/1')).status, 404);
});

test('a file over the cap is 413 and one exactly at it is served', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'artifact-cap-'));
  const { h, finished } = await setup(t, {
    dir,
    artifacts: new FileArtifactSource(join(dir, 'handoff'), { maxBytes: 16 }),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { taskId } = await finished(['at.txt', 'over.txt', 'empty.txt'], {
    'at.txt': 'x'.repeat(16),
    'over.txt': 'x'.repeat(17),
    'empty.txt': '',
  });
  assert.equal((await get(h, taskId, '/0')).status, 200);
  const over = await get(h, taskId, '/1');
  assert.equal(over.status, 413);
  assert.deepEqual(await over.json(), { error: 'artifact_too_large' });
  const empty = await get(h, taskId, '/2');
  assert.equal(empty.status, 200);
  assert.equal(await empty.text(), '');
});

test('an https reference is returned as a link and never fetched; other schemes are not links', async (t) => {
  const seen: string[] = [];
  const listener = createServer((req) => {
    seen.push(req.url ?? '');
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const connections: number[] = [];
  listener.on('connection', () => connections.push(1));
  t.after(() => {
    listener.closeAllConnections();
    listener.close();
  });
  const port = (listener.address() as AddressInfo).port;
  const { h, finished } = await setup(t);
  const link = `https://127.0.0.1:${port}/report?x=1`;
  const { taskId } = await finished([
    link,
    `http://127.0.0.1:${port}/plain`,
    `https://user:pw@127.0.0.1:${port}/creds`,
    'HTTPS://Example.com/Path',
  ]);
  const listing = (await (await get(h, taskId, '')).json()) as {
    artifacts: Array<{ kind: string; url?: string; name: string }>;
  };
  assert.deepEqual(
    listing.artifacts.map((a) => [a.kind, a.url]),
    [
      ['link', link],
      ['file', undefined],
      ['file', undefined],
      ['link', 'https://example.com/Path'],
    ],
  );
  assert.deepEqual(await (await get(h, taskId, '/0')).json(), { url: link });
  for (const index of [1, 2]) assert.equal((await get(h, taskId, `/${index}`)).status, 404);
  assert.deepEqual(seen, []);
  assert.deepEqual(connections, []);
});

test('names in the listing and the download header carry no path or control characters', async (t) => {
  const { h, finished } = await setup(t);
  const { taskId } = await finished(['a b"\r\nSet-Cookie: x.md', 'dir/..hidden', 'ok.md'], {});
  const listing = (await (await get(h, taskId, '')).json()) as {
    artifacts: Array<{ name: string }>;
  };
  for (const { name } of listing.artifacts) assert.match(name, /^[\w.@+-]+$/u);
});

test('reads in flight are capped and the slot comes back on every exit', async (t) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  let mode: 'wait' | 'throw' | 'ok' = 'wait';
  const source: ArtifactSource = {
    async read(): Promise<ArtifactRead> {
      entered += 1;
      if (mode === 'throw') throw new Error('disk gone');
      if (mode === 'wait') await gate;
      return { ok: true, bytes: Buffer.from('x') };
    },
  };
  const { h, finished } = await setup(t, {
    artifacts: source,
    http: { artifactReadsInFlight: 2, artifactsPerMinute: 1_000_000 },
  });
  const { taskId } = await finished(['a.md']);
  const first = get(h, taskId, '/0');
  const second = get(h, taskId, '/0');
  await eventually(() => entered === 2, 'two reads in flight');
  const refused = await get(h, taskId, '/0');
  assert.equal(refused.status, 429);
  assert.equal(entered, 2);
  release();
  assert.deepEqual([(await first).status, (await second).status], [200, 200]);
  // A source that throws frees its slot too.
  mode = 'throw';
  for (let i = 0; i < 3; i += 1) assert.equal((await get(h, taskId, '/0')).status, 500);
  mode = 'ok';
  assert.equal((await get(h, taskId, '/0')).status, 200);
});

test('downloads are limited per invite and the limit comes back with Retry-After', async (t) => {
  const { h, finished } = await setup(t, { http: { artifactsPerMinute: 2 } });
  const { taskId } = await finished(['a.md'], { 'a.md': 'a' });
  assert.equal((await get(h, taskId, '/0')).status, 200);
  assert.equal((await get(h, taskId, '/0')).status, 200);
  const refused = await get(h, taskId, '/0');
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('retry-after')) >= 1);
  assert.equal((await get(h, taskId, '')).status, 200);
});
