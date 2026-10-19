import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { VerificationRecordSchema, renderFromRecord } from '../record.js';
import { ReportSchema, claimsOf } from '../report-schema.js';
import { MAX_SOURCE_BYTES, runCiteCheck } from '../run.js';
import { parseCiteCheckLine } from '../summary-line.js';
import { PAGE_BRIDGE_HTML, PAGE_TUNNEL_TXT, sampleReport } from './fixtures.js';

let dir: string;
const path = (name: string) => join(dir, name);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cite-check-'));
  await mkdir(path('sources'));
  await writeFile(path('sources/bridge.html'), PAGE_BRIDGE_HTML);
  await writeFile(path('sources/tunnel.txt'), PAGE_TUNNEL_TXT);
  await writeFile(path('report.json'), JSON.stringify(sampleReport()));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = (...extra: string[]) =>
  runCiteCheck([
    '--report',
    path('report.json'),
    '--sources',
    path('sources'),
    '--out',
    path('out'),
    ...extra,
  ]);

const lastLine = (stdout: string) => stdout.trimEnd().split('\n').pop() ?? '';

async function reportWith(mutate: (report: ReturnType<typeof sampleReport>) => void) {
  const report = sampleReport();
  mutate(report);
  await writeFile(path('report.json'), JSON.stringify(report));
}

describe('cite-check', () => {
  test('a clean report exits 0, writes the three artifacts and prints a parseable summary', async () => {
    const outcome = await run();
    assert.equal(outcome.exitCode, 0);
    const parsed = parseCiteCheckLine(lastLine(outcome.stdout));
    assert.deepEqual(parsed, {
      ok: true,
      summary: { claims: 3, verified: 0, quoteVerified: 3, failed: 0, removed: 0, judged: 0 },
    });
    assert.match(await readFile(path('out/report.md'), 'utf8'), /^# Harbor crossings/);
    assert.match(await readFile(path('out/report.html'), 'utf8'), /<h1>Harbor crossings<\/h1>/);
    assert.deepEqual(
      JSON.parse(await readFile(path('out/report.json'), 'utf8')),
      JSON.parse(await readFile(path('report.json'), 'utf8')),
    );
    const record = JSON.parse(await readFile(path('out/verification.json'), 'utf8'));
    assert.equal(record.entailment, 'not_judged');
    assert.equal(record.sources.length, 2);
    assert.match(record.sources[0].sha256, /^[0-9a-f]{64}$/);
  });

  test('out/report.json is the report that was checked, whole: dropped claims stay in it', async () => {
    await reportWith((report) => {
      report.sections[0]?.claims.push({
        id: 'bad',
        text: 'The bridge was closed for forty years.',
        citations: [{ sourceId: 'bridge', quote: 'The bridge was closed for forty years' }],
      });
    });
    const input = ReportSchema.parse(JSON.parse(await readFile(path('report.json'), 'utf8')));
    assert.equal((await run('--drop-unsupported')).exitCode, 0);
    const out = ReportSchema.parse(JSON.parse(await readFile(path('out/report.json'), 'utf8')));
    assert.deepEqual(out, input);
    assert.deepEqual(
      claimsOf(out).map((claim) => claim.id),
      ['c1', 'c2', 'bad', 'c3'],
    );
    const record = JSON.parse(await readFile(path('out/verification.json'), 'utf8'));
    assert.deepEqual(
      record.claims.map((claim: { id: string }) => claim.id),
      claimsOf(out).map((claim) => claim.id),
    );
  });

  test('--out that would overwrite the input report is refused and the input is untouched', async () => {
    const before = await readFile(path('report.json'), 'utf8');
    const outcome = await runCiteCheck([
      '--report',
      path('report.json'),
      '--sources',
      path('sources'),
      '--out',
      dir,
    ]);
    assert.equal(outcome.exitCode, 2);
    assert.match(outcome.stderr, /would overwrite --report/);
    assert.equal(await readFile(path('report.json'), 'utf8'), before);
    await assert.rejects(readFile(path('report.md')));
  });

  test('a failed claim exits 1 and is named; --drop-unsupported removes it and exits 0', async () => {
    await reportWith((report) => {
      report.sections[0]?.claims.push({
        id: 'bad',
        text: 'The bridge was closed for forty years.',
        citations: [{ sourceId: 'bridge', quote: 'The bridge was closed for forty years' }],
      });
    });
    const kept = await run();
    assert.equal(kept.exitCode, 1);
    assert.match(kept.stdout, /claim bad: quote_not_found/);
    assert.match(await readFile(path('out/report.md'), 'utf8'), /not verified/);

    const dropped = await run('--drop-unsupported');
    assert.equal(dropped.exitCode, 0);
    assert.match(lastLine(dropped.stdout), /failed=1 removed=1 judged=0$/);
    assert.doesNotMatch(
      (await readFile(path('out/report.md'), 'utf8')).split('## Not verified')[0] ?? '',
      /forty years/,
    );
    const record = JSON.parse(await readFile(path('out/verification.json'), 'utf8'));
    assert.deepEqual(
      record.claims.find((claim: { id: string }) => claim.id === 'bad')?.removed,
      true,
    );
  });

  test('dropping every claim exits 1', async () => {
    await reportWith((report) => {
      for (const section of report.sections) section.claims = [];
      report.sections[0]?.claims.push({ id: 'z', text: 'No source.', citations: [] });
    });
    const outcome = await run('--drop-unsupported');
    assert.equal(outcome.exitCode, 1);
    assert.match(lastLine(outcome.stdout), /claims=1 .* failed=1 removed=1/);
  });

  test('reviewer judgments are merged', async () => {
    await writeFile(
      path('judgments.json'),
      JSON.stringify([
        { claimId: 'c1', entailed: true, reason: 'gives the date' },
        { claimId: 'c2', entailed: false, reason: 'it is a design figure' },
      ]),
    );
    const outcome = await run('--judgments', path('judgments.json'), '--drop-unsupported');
    assert.equal(outcome.exitCode, 0);
    assert.equal(
      lastLine(outcome.stdout),
      'cite-check v1: claims=3 verified=1 quote_verified=1 failed=1 removed=1 judged=2',
    );
  });

  test('the exported record lets a renderer make the delivered report again, byte for byte', async () => {
    // The supervisor does not trust the renderings an agent delivers: it makes them again from the report and this record.
    const again = async (label: string) => {
      const record = VerificationRecordSchema.parse(
        JSON.parse(await readFile(path('out/verification.json'), 'utf8')),
      );
      const report = ReportSchema.parse(JSON.parse(await readFile(path('report.json'), 'utf8')));
      const rendered = renderFromRecord(report, record);
      assert.equal(rendered.markdown, await readFile(path('out/report.md'), 'utf8'), label);
      assert.equal(rendered.html, await readFile(path('out/report.html'), 'utf8'), label);
    };
    await run();
    await again('clean');
    await reportWith((report) => {
      report.sections[0]?.claims.push({
        id: 'bad',
        text: 'The bridge was closed for forty years.',
        citations: [{ sourceId: 'bridge', quote: 'The bridge was closed for forty years' }],
      });
    });
    await run();
    await again('a failed claim kept, with its note');
    await run('--drop-unsupported');
    await again('a failed claim dropped and listed');
    await writeFile(
      path('judgments.json'),
      JSON.stringify([
        { claimId: 'c1', entailed: true, reason: 'gives the date' },
        { claimId: 'c2', entailed: false, reason: 'it is a design figure' },
      ]),
    );
    await run('--judgments', path('judgments.json'), '--drop-unsupported');
    await again('judged claims, one of them unsupported and dropped');
  });

  test('a source with no fetched text makes its claims fail', async () => {
    await rm(path('sources/tunnel.txt'));
    const outcome = await run();
    assert.equal(outcome.exitCode, 1);
    assert.match(outcome.stdout, /claim c3: source_missing/);
  });

  test('a symbolic link in place of a source is refused and nothing is written', async () => {
    await writeFile(path('secret.txt'), 'opened in 1959 and is 2,300 metres long');
    await rm(path('sources/tunnel.txt'));
    await symlink(path('secret.txt'), path('sources/tunnel.txt'));
    const outcome = await run();
    assert.equal(outcome.exitCode, 2);
    assert.match(outcome.stderr, /symbolic link/);
    await assert.rejects(readFile(path('out/report.md')));
  });

  test('a symlinked report is refused', async () => {
    await rm(path('report.json'));
    await symlink(path('sources/tunnel.txt'), path('report.json'));
    assert.equal((await run()).exitCode, 2);
  });

  test('an oversize source is refused', async () => {
    await writeFile(path('sources/tunnel.txt'), Buffer.alloc(MAX_SOURCE_BYTES + 1, 'a'));
    const outcome = await run();
    assert.equal(outcome.exitCode, 2);
    assert.match(outcome.stderr, /larger than/);
  });

  test('a source id cannot name a path', async () => {
    await reportWith((report) => {
      report.sources[0] = { id: '../report', url: 'https://example.org/x' };
    });
    const outcome = await run();
    assert.equal(outcome.exitCode, 2);
    assert.match(outcome.stderr, /ids are 1-64/);
  });

  test('a javascript: source URL is rejected', async () => {
    await reportWith((report) => {
      report.sources[0] = { id: 'bridge', url: 'javascript:alert(1)' };
    });
    assert.equal((await run()).exitCode, 2);
  });

  test('a link planted at an output name is replaced, not followed', async () => {
    await mkdir(path('out'));
    await writeFile(path('victim.txt'), 'keep');
    await symlink(path('victim.txt'), path('out/report.md'));
    assert.equal((await run()).exitCode, 0);
    assert.equal(await readFile(path('victim.txt'), 'utf8'), 'keep');
    assert.match(await readFile(path('out/report.md'), 'utf8'), /^# Harbor/);
  });

  test('bad usage and bad JSON exit 2', async () => {
    assert.equal((await runCiteCheck([])).exitCode, 2);
    assert.equal((await runCiteCheck(['--nope'])).exitCode, 2);
    await writeFile(path('report.json'), '{not json');
    const outcome = await run();
    assert.equal(outcome.exitCode, 2);
    assert.match(outcome.stderr, /not valid JSON/);
  });

  test('duplicate claim ids exit 2', async () => {
    await reportWith((report) => {
      report.sections[1]?.claims.push({ ...report.sections[0]!.claims[0]! });
    });
    const outcome = await run();
    assert.equal(outcome.exitCode, 2);
    assert.match(outcome.stderr, /duplicate claim id/);
  });
});
