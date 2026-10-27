import assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { pullRequestBody } from '../evidence.js';
import { PREVIEW_FILE } from '../viewport.js';
import { type AgentScript, collect, fixes, readJson, setup, terminal } from './harness.js';

const BROWSERS = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'chrome',
];
const browserOnPath = (process.env.PATH ?? '')
  .split(delimiter)
  .some((dir) => dir !== '' && BROWSERS.some((name) => existsSync(join(dir, name))));
const python = (process.env.PATH ?? '')
  .split(delimiter)
  .some((dir) => dir !== '' && existsSync(join(dir, 'python3')));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

/** Fixes the code and adds a page with a box wider than a phone, served by a static server. */
function fixesAndAddsPage(port: number, command?: string): AgentScript {
  return async (turn) => {
    await fixes(turn);
    await fs.mkdir(join(turn.workspace, 'site'), { recursive: true });
    await fs.writeFile(
      join(turn.workspace, 'site', 'index.html'),
      '<!doctype html><meta name="viewport" content="width=device-width"><h1>Sum</h1><div style="width:600px">wide</div>\n',
    );
    await fs.writeFile(
      join(turn.dir, PREVIEW_FILE),
      JSON.stringify({
        command: command ?? `python3 -m http.server ${port} --bind 127.0.0.1`,
        port,
        paths: ['/site/'],
      }),
    );
    return 'ok';
  };
}

test('a change without a preview.json says it has no screenshots, and is delivered as before', async (t) => {
  const h = await setup(t);
  h.claude.script = fixes;
  const spec = await h.spec('tsk_vp_none');
  assert.deepEqual(terminal(await collect(await h.runner.start(spec))), { type: 'finished' });
  const manifest = await readJson(spec.resultPath);
  assert.deepEqual(manifest.artifacts, [
    'change.patch',
    'changes.json',
    'verification.json',
    'review.md',
  ]);
  assert.ok(manifest.done.includes('no screenshots: no page was named to look at'));
  const verification = await readJson(join(h.handoff, 'tsk_vp_none', 'verification.json'));
  assert.equal(verification.viewport.result, 'not_declared');
  assert.match(pullRequestBody(verification), /No screenshots: no page was named to look at/);
});

test('a preview that never listens is recorded as not looked at, and the change is still delivered', async (t) => {
  const h = await setup(t);
  const port = await freePort();
  h.claude.script = fixesAndAddsPage(port, 'echo starting; exit 3');
  const spec = await h.spec('tsk_vp_broken');
  assert.deepEqual(terminal(await collect(await h.runner.start(spec))), { type: 'finished' });
  const manifest = await readJson(spec.resultPath);
  assert.match(manifest.summary, /^Verified change to acme\/calc/);
  assert.ok(!manifest.artifacts.some((name: string) => name.endsWith('.png')));
  const verification = await readJson(join(h.handoff, 'tsk_vp_broken', 'verification.json'));
  assert.equal(verification.viewport.result, 'not_run');
  assert.equal(
    verification.viewport.reason,
    `the preview command exited before it listened on port ${port}`,
  );
  assert.match(pullRequestBody(verification), /⚠️ Not looked at: `the preview command exited/);
});

test('the runner screenshots the page itself at desktop and phone width, with and without the change', {
  skip: browserOnPath && python ? false : 'needs chromium or chrome, and python3, on PATH',
}, async (t) => {
  const h = await setup(t);
  const port = await freePort();
  h.claude.script = fixesAndAddsPage(port);
  const spec = await h.spec('tsk_vp_shots');
  assert.deepEqual(terminal(await collect(await h.runner.start(spec))), { type: 'finished' });

  const manifest = await readJson(spec.resultPath);
  assert.deepEqual(manifest.artifacts.slice(0, 4), [
    'viewport-desktop.png',
    'viewport-phone.png',
    'before-viewport-desktop.png',
    'before-viewport-phone.png',
  ]);
  const dir = join(h.handoff, 'tsk_vp_shots');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  for (const name of manifest.artifacts.slice(0, 4)) {
    const bytes = await fs.readFile(join(dir, name));
    assert.ok(bytes.subarray(0, 4).equals(png), `${name} is a png`);
  }
  // The phone screenshot is twice as dense: 390 px wide at scale 2.
  const phone = await fs.readFile(join(dir, 'viewport-phone.png'));
  assert.equal(phone.readUInt32BE(16), 780);
  const desktop = await fs.readFile(join(dir, 'viewport-desktop.png'));
  assert.equal(desktop.readUInt32BE(16), 1280);

  const verification = await readJson(join(dir, 'verification.json'));
  const { viewport } = verification;
  assert.equal(viewport.result, 'captured');
  const byViewport = Object.fromEntries(
    viewport.pages.map((page: { viewport: string }) => [page.viewport, page]),
  );
  // The 600 px box fits a desktop and is 210 px or more too wide for a 390 px phone.
  assert.equal(byViewport.desktop.status, 200);
  assert.equal(byViewport.desktop.overflowPx, 0);
  assert.ok(byViewport.phone.overflowPx >= 210, `phone overflow ${byViewport.phone.overflowPx}`);
  // On the base commit the page is not there yet (the server lists the empty folder): no wide box,
  // so a different picture than with the change.
  assert.equal(viewport.before.result, 'captured');
  const before = Object.fromEntries(
    viewport.before.pages.map((page: { viewport: string }) => [page.viewport, page]),
  );
  assert.equal(before.phone.overflowPx, 0);
  assert.notEqual(before.phone.sha256, byViewport.phone.sha256);
  assert.equal(before.phone.file, 'before-viewport-phone.png');

  assert.ok(
    manifest.knownIssues.some((issue: string) =>
      /^viewport: \/site\/ at 390 px: \d+ px wider than the screen$/u.test(issue),
    ),
  );
  assert.ok(
    manifest.done.some((line: string) =>
      line.startsWith(
        'the runner looked at /site/ at 1280 and 390 px wide, with and without the change',
      ),
    ),
  );
  assert.match(
    pullRequestBody(verification),
    /\| Desktop and phone \(the runner's own screenshots\) \| ⚠️ `\/site\/` at 1280 and 390 px wide, with and without this change: `\/site\/ at 390 px: \d+ px wider than the screen`/u,
  );
});
