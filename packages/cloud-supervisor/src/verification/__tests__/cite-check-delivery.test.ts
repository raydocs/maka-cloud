import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCiteCheck } from '@maka-cloud/playbooks';
import {
  TUNNEL_QUOTE,
  defaultClaims,
  finishTask,
  itemsOf,
  researchManifest,
  verifyRig,
  world,
} from './harness.js';

const FREIGHT = 'Most of the traffic through the link is freight rather than passengers.';

/**
 * The real `cite-check` on fixture pages, then its four output files handed to the
 * supervisor as the task's artifacts, the way the runner exports them. Nothing in
 * `out/` is built by hand.
 */
async function runRealCiteCheck(args: string[] = ['--drop-unsupported']) {
  const dir = await mkdtemp(join(tmpdir(), 'cite-check-delivery-'));
  try {
    await mkdir(join(dir, 'sources'));
    await writeFile(
      join(dir, 'sources/s1.html'),
      `<html><body><p>${TUNNEL_QUOTE}</p></body></html>`,
    );
    await writeFile(join(dir, 'sources/s2.txt'), `${FREIGHT} More text.`);
    await writeFile(
      join(dir, 'report.json'),
      JSON.stringify({
        title: 'The link',
        sections: [{ heading: 'Facts', claims: defaultClaims() }],
        sources: [
          { id: 's1', url: 'https://example.com/s1' },
          { id: 's2', url: 'https://example.com/s2' },
        ],
      }),
    );
    const outcome = await runCiteCheck([
      '--report',
      join(dir, 'report.json'),
      '--sources',
      join(dir, 'sources'),
      '--out',
      join(dir, 'out'),
      ...args,
    ]);
    assert.equal(outcome.exitCode, 0, outcome.stdout + outcome.stderr);
    const files: Record<string, string> = {};
    for (const name of ['report.json', 'report.md', 'report.html', 'verification.json']) {
      files[name] = await readFile(join(dir, 'out', name), 'utf8');
    }
    return files;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the four files the real cite-check writes are independently checked by the supervisor', async () => {
  const files = await runRealCiteCheck();
  const w = world();
  for (const [name, text] of Object.entries(files)) w.evidence.set('t1', name, text);
  w.fetcher.page('https://example.com/s1', `<html><body><p>${TUNNEL_QUOTE}</p></body></html>`);
  w.fetcher.page('https://example.com/s2', `${FREIGHT} More text.`, 'text/plain');
  const r = await verifyRig(w);
  await finishTask(r, 't1', researchManifest(), { runner: 'codex' });
  assert.equal(itemsOf(r, 'verification_failed').length, 0);
  assert.match(itemsOf(r, 'finished')[0]?.ask ?? '', /independently checked/);
  await r.stop();
});

test('a cite-check run that kept its claims (no drop) is checked the same way', async () => {
  const files = await runRealCiteCheck([]);
  const w = world();
  for (const [name, text] of Object.entries(files)) w.evidence.set('t1', name, text);
  w.fetcher.page('https://example.com/s1', `<html><body><p>${TUNNEL_QUOTE}</p></body></html>`);
  w.fetcher.page('https://example.com/s2', `${FREIGHT} More text.`, 'text/plain');
  const r = await verifyRig(w);
  await finishTask(r, 't1', researchManifest(), { runner: 'codex' });
  assert.equal(itemsOf(r, 'verification_failed').length, 0);
  assert.match(itemsOf(r, 'finished')[0]?.ask ?? '', /independently checked/);
  await r.stop();
});
