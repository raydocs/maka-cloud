import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { RunEvent } from './export-helpers.js';
import {
  collect,
  deferred,
  exists,
  type Harness,
  notes,
  setup,
  settles,
  terminal,
} from './harness.js';
import { briefedSpec, fakeManifest, workspaceFile, writeBrief } from './export-helpers.js';
import type { CloudRunnersOptions } from '../fleet.js';

const TASK = 'tsk_draft';

async function withHarness(
  t: { after(fn: () => Promise<void>): void },
  cloud: Partial<CloudRunnersOptions> = {},
): Promise<Harness> {
  const h = await setup({ cloud });
  t.after(() => h.cleanup());
  await h.setMode('custom');
  return h;
}

const handoff = (h: Harness, ...parts: string[]): string => join(h.handoff, TASK, ...parts);

async function result(h: Harness): Promise<{ done: string[]; artifacts?: string[] }> {
  return JSON.parse(await fs.readFile(handoff(h, 'result.json'), 'utf8'));
}

function failureOf(events: RunEvent[]): string {
  const end = terminal(events);
  assert.equal(end?.type, 'failed', 'expected the task to fail');
  return end?.type === 'failed' ? end.reason : '';
}

/** Everything a failed or cancelled run must have given back. */
function assertReleased(h: Harness): void {
  assert.deepEqual(h.revoked, [TASK]);
  assert.equal(h.fake.leases.size, 0);
  assert.equal(h.runners.fleet.openRuns, 0);
  assert.equal(h.runners.fleet.leaseRenewals, 0);
}

async function stageFilesLeft(h: Harness): Promise<string[]> {
  return (await fs.readdir(join(h.root, TASK)).catch(() => [])).filter((n) =>
    n.startsWith('export-'),
  );
}

test('listed artifacts are exported under the same path, and the runner vouches for them in done', async (t) => {
  const h = await withHarness(t);
  await workspaceFile(h, TASK, 'out/report.md', '# Report\n');
  await workspaceFile(h, TASK, 'out/report.html', '<h1>Report</h1>');
  await workspaceFile(h, TASK, 'verification.json', '{"ok":true}');
  await fakeManifest(h, {
    done: ['wrote it', 'cite-check v1: claims=1'],
    artifacts: [
      'out/report.md',
      'out/report.html',
      'verification.json',
      'https://example.test/page',
    ],
  });
  const spec = await briefedSpec(
    h,
    TASK,
    'maka-artifacts: out/report.md verification.json\n\n# Draft\n',
  );
  const events = await collect(await h.runners.claude.start(spec));
  assert.equal(terminal(events)?.type, 'finished');

  assert.equal(await fs.readFile(handoff(h, 'out/report.md'), 'utf8'), '# Report\n');
  assert.equal(await fs.readFile(handoff(h, 'out/report.html'), 'utf8'), '<h1>Report</h1>');
  assert.equal(await fs.readFile(handoff(h, 'verification.json'), 'utf8'), '{"ok":true}');
  assert.equal((await fs.stat(handoff(h, 'out/report.md'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(handoff(h, 'out'))).mode & 0o777, 0o700);
  assert.equal(await exists(handoff(h, 'https:')), false, 'a link is left alone');
  assert.ok(notes(events).includes('3 artifacts exported'));
  assert.ok(!notes(events).some((n) => n.includes('example.test')), 'a link needs no note');

  const manifest = await result(h);
  assert.deepEqual(manifest.done, [
    'wrote it',
    'cite-check v1: claims=1',
    'runner-exported: out/report.md verification.json out/report.html',
  ]);
  assert.equal(h.fake.requestsTo('GET', /\/files$/).length, 0, 'nothing read as root');
  assert.deepEqual(await stageFilesLeft(h), []);
  assert.match(await fs.readFile(handoff(h, 'brief.md'), 'utf8'), /^maka-artifacts:/);
});

test('a done entry that claims an export is dropped, whether or not anything was exported', async (t) => {
  const h = await withHarness(t);
  await fakeManifest(h, { done: ['  runner-exported: out/report.md', 'did the work'] });
  const events = await collect(await h.runners.claude.start(await h.spec(TASK)));
  assert.equal(terminal(events)?.type, 'finished');
  assert.deepEqual((await result(h)).done, ['did the work']);

  const h2 = await withHarness(t);
  await workspaceFile(h2, TASK, 'a.txt', 'a');
  await fakeManifest(h2, { done: ['runner-exported: out/report.md'], artifacts: ['a.txt'] });
  assert.equal(
    terminal(await collect(await h2.runners.claude.start(await h2.spec(TASK))))?.type,
    'finished',
  );
  assert.deepEqual((await result(h2)).done, ['runner-exported: a.txt']);
});

test('an agent cannot mark its own result as a kept change', async (t) => {
  const h = await withHarness(t);
  await fakeManifest(h, { done: ['kept: change.patch is ready', ' kept: x', 'did the work'] });
  const events = await collect(await h.runners.claude.start(await h.spec(TASK)));
  assert.equal(terminal(events)?.type, 'finished');
  assert.deepEqual((await result(h)).done, ['did the work']);
});

test('names the spec reserves are not replaced by an exported artifact', async (t) => {
  const h = await withHarness(t);
  await workspaceFile(h, TASK, 'change.patch', 'agent text');
  await workspaceFile(h, TASK, 'notes.md', 'notes');
  await fakeManifest(h, { artifacts: ['change.patch', 'notes.md'] });
  const spec = { ...(await h.spec(TASK)), reserved: ['change.patch'] };
  await fs.writeFile(handoff(h, 'change.patch'), 'host text');
  const events = await collect(await h.runners.claude.start(spec));
  assert.equal(terminal(events)?.type, 'finished');
  assert.equal(await fs.readFile(handoff(h, 'change.patch'), 'utf8'), 'host text');
  assert.ok(
    notes(events).some((x) =>
      /artifact change\.patch was not exported: that name is reserved/.test(x),
    ),
  );
});

test('a reserved name is not made a directory either', async (t) => {
  const h = await withHarness(t);
  await workspaceFile(h, TASK, 'review.md/inside.txt', 'agent text');
  await fakeManifest(h, { artifacts: ['review.md/inside.txt'] });
  const spec = { ...(await h.spec(TASK)), reserved: ['review.md'] };
  const events = await collect(await h.runners.claude.start(spec));
  assert.equal(terminal(events)?.type, 'finished');
  await assert.rejects(fs.stat(handoff(h, 'review.md')));
  assert.ok(notes(events).some((x) => /was not exported: that name is reserved/.test(x)));
});

test('a manifest that needs no change reaches the orchestrator byte for byte', async (t) => {
  const h = await withHarness(t);
  const text = '{"summary":"s","done":["d"],"notDone":[],"confidence":"high","knownIssues":[]}';
  await fs.writeFile(join(h.home, 'fake-cli', 'manifest.json'), text);
  assert.equal(
    terminal(await collect(await h.runners.claude.start(await h.spec(TASK))))?.type,
    'finished',
  );
  assert.equal(await fs.readFile(handoff(h, 'result.json'), 'utf8'), text);
});

test('optional artifacts that cannot be exported become notes, and are not vouched for', async (t) => {
  const h = await withHarness(t, { exportLimits: { maxFileBytes: 10 } });
  await workspaceFile(h, TASK, 'ok.txt', 'fine');
  await workspaceFile(h, TASK, 'big.txt', 'x'.repeat(11));
  await fs.symlink(
    join(h.home, 'fake-cli', 'secret.txt'),
    join(h.root, TASK, 'workspace', 'link.txt'),
  );
  await fakeManifest(h, {
    artifacts: ['ok.txt', 'missing.txt', 'big.txt', 'link.txt', '/etc/passwd', '../x', 'a b'],
  });
  const events = await collect(await h.runners.claude.start(await h.spec(TASK)));
  assert.equal(terminal(events)?.type, 'finished');
  const n = notes(events);
  assert.ok(
    n.includes('artifact missing.txt was not exported: it does not exist in the workspace'),
    n.join('\n'),
  );
  assert.ok(
    n.some((x) => /artifact big\.txt was not exported: it is larger than 10 bytes/.test(x)),
  );
  assert.ok(
    n.some((x) => /artifact link\.txt was not exported: it goes through a symbolic link/.test(x)),
  );
  assert.ok(
    n.some((x) => /artifact \/etc\/passwd was not exported: it is not a plain path/.test(x)),
  );
  assert.ok(n.some((x) => /artifact \.\.\/x was not exported/.test(x)));
  assert.deepEqual((await result(h)).done.slice(-1), ['runner-exported: ok.txt']);
  for (const name of ['missing.txt', 'big.txt', 'link.txt', 'passwd', 'x']) {
    assert.equal(await exists(handoff(h, name)), false, name);
  }
});

test('a required artifact the manifest does not list is repaired once, then fails the task', async (t) => {
  const h = await withHarness(t);
  await workspaceFile(h, TASK, 'out/report.md', 'r');
  await fakeManifest(h, { artifacts: ['out/report.md'] });
  const events = await collect(
    await h.runners.claude.start(
      await briefedSpec(h, TASK, 'maka-artifacts: out/report.md verification.json\n\nDraft.\n'),
    ),
  );
  assert.match(
    failureOf(events),
    /invalid result: the manifest does not list verification\.json, which the brief requires/,
  );
  assert.equal(await h.cliCalls('claude'), 2, 'one repair turn');
  const { argv } = await h.cliCall('claude', 2);
  assert.match(
    argv[argv.indexOf('-p') + 1] ?? '',
    /artifacts were not accepted: the manifest does not list verification\.json/,
  );
  assert.ok(notes(events).some((x) => /artifacts were not accepted/.test(x)));
  assert.equal(
    await exists(handoff(h, 'result.json')),
    false,
    'no result reaches the orchestrator',
  );
  assertReleased(h);
});

test('the repair turn can fix a missing artifact, and the second manifest is the one exported', async (t) => {
  const h = await withHarness(t);
  await workspaceFile(h, TASK, 'out/report.md', 'r');
  await workspaceFile(h, TASK, 'verification.json', 'v');
  await fakeManifest(h, { artifacts: ['out/report.md'] }, 1);
  await fakeManifest(h, { artifacts: ['out/report.md', 'verification.json'] }, 2);
  const events = await collect(
    await h.runners.claude.start(
      await briefedSpec(h, TASK, 'maka-artifacts: out/report.md verification.json\n\nDraft.\n'),
    ),
  );
  assert.equal(terminal(events)?.type, 'finished');
  assert.equal(await h.cliCalls('claude'), 2);
  assert.equal(await fs.readFile(handoff(h, 'verification.json'), 'utf8'), 'v');
  assert.deepEqual((await result(h)).done.slice(-1), [
    'runner-exported: out/report.md verification.json',
  ]);
});

test('a required artifact that is not in the workspace fails the task', async (t) => {
  const h = await withHarness(t);
  await fakeManifest(h, { artifacts: ['out/report.md'] });
  const events = await collect(
    await h.runners.claude.start(
      await briefedSpec(h, TASK, 'maka-artifacts: out/report.md\n\nDraft.\n'),
    ),
  );
  assert.match(
    failureOf(events),
    /required artifact out\/report\.md was not exported: it does not exist in the workspace/,
  );
  assert.equal(await exists(handoff(h, 'out')), false);
  assertReleased(h);
});

test('a required artifact that is a symlink, or behind one, is refused and nothing is copied out', async (t) => {
  for (const make of [
    async (h: Harness) => {
      await fs.mkdir(join(h.root, TASK, 'workspace', 'out'), { recursive: true });
      await fs.symlink(
        join(h.home, 'fake-cli', 'secret.txt'),
        join(h.root, TASK, 'workspace', 'out', 'report.md'),
      );
    },
    async (h: Harness) => {
      await fs.mkdir(join(h.home, 'elsewhere'), { recursive: true });
      await fs.writeFile(join(h.home, 'elsewhere', 'report.md'), 'root-only secret');
      await fs.mkdir(join(h.root, TASK, 'workspace'), { recursive: true });
      await fs.symlink(join(h.home, 'elsewhere'), join(h.root, TASK, 'workspace', 'out'));
    },
  ]) {
    const h = await withHarness(t);
    await make(h);
    await fakeManifest(h, { artifacts: ['out/report.md'] });
    const events = await collect(
      await h.runners.claude.start(
        await briefedSpec(h, TASK, 'maka-artifacts: out/report.md\n\nDraft.\n'),
      ),
    );
    assert.match(
      failureOf(events),
      /required artifact out\/report\.md was not exported: it goes through a symbolic link/,
    );
    assert.equal(await exists(handoff(h, 'out', 'report.md')), false);
    assertReleased(h);
  }
});

test('a workspace that is itself a symlink exports nothing', async (t) => {
  const h = await withHarness(t);
  await fs.mkdir(join(h.home, 'elsewhere'), { recursive: true });
  await fs.writeFile(join(h.home, 'elsewhere', 'a.txt'), 'secret');
  await fs.mkdir(join(h.root, TASK), { recursive: true });
  await fs.symlink(join(h.home, 'elsewhere'), join(h.root, TASK, 'workspace'));
  await fakeManifest(h, { artifacts: ['a.txt'] });
  const events = await collect(
    await h.runners.claude.start(await briefedSpec(h, TASK, 'maka-artifacts: a.txt\n\nDraft.\n')),
  );
  assert.match(failureOf(events), /required artifact a\.txt was not exported/);
  assert.equal(await exists(handoff(h, 'a.txt')), false);
});

test('the limits: a file over its cap and the count (required files first)', async (t) => {
  const h = await withHarness(t, { exportLimits: { maxFileBytes: 8, maxFiles: 2 } });
  await workspaceFile(h, TASK, 'a.txt', '12345');
  await workspaceFile(h, TASK, 'b.txt', '12345');
  await workspaceFile(h, TASK, 'c.txt', '12345');
  await workspaceFile(h, TASK, 'huge.txt', '123456789');
  await fakeManifest(h, { artifacts: ['huge.txt', 'a.txt', 'b.txt', 'c.txt'] });
  const spec = await briefedSpec(h, TASK, 'maka-artifacts: c.txt\n\nDraft.\n');
  const events = await collect(await h.runners.claude.start(spec));
  assert.equal(terminal(events)?.type, 'finished');
  const n = notes(events);
  // The required c.txt is first, huge.txt second (refused for its size, but it cost a read).
  assert.ok(
    n.some((x) => /artifact huge\.txt was not exported: it is larger than 8 bytes/.test(x)),
    n.join('\n'),
  );
  for (const name of ['a.txt', 'b.txt']) {
    assert.ok(
      n.some((x) =>
        x.includes(`artifact ${name} was not exported: more than 2 artifacts are listed`),
      ),
      name,
    );
  }
  assert.deepEqual((await result(h)).done.slice(-1), ['runner-exported: c.txt']);
});

test('the total cap leaves out an optional artifact and fails a required one', async (t) => {
  const h = await withHarness(t, { exportLimits: { maxTotalBytes: 8 } });
  await workspaceFile(h, TASK, 'a.txt', '12345');
  await workspaceFile(h, TASK, 'b.txt', '12345');
  await fakeManifest(h, { artifacts: ['a.txt', 'b.txt'] });
  const optional = await collect(await h.runners.claude.start(await h.spec(TASK)));
  assert.equal(terminal(optional)?.type, 'finished');
  assert.ok(
    notes(optional).some((x) =>
      /artifact b\.txt was not exported: the artifacts together would be over 8 bytes/.test(x),
    ),
  );
  assert.deepEqual((await result(h)).done.slice(-1), ['runner-exported: a.txt']);

  const h2 = await withHarness(t, { exportLimits: { maxTotalBytes: 8 } });
  await workspaceFile(h2, TASK, 'a.txt', '12345');
  await workspaceFile(h2, TASK, 'b.txt', '12345');
  await fakeManifest(h2, { artifacts: ['a.txt', 'b.txt'] });
  const spec = await briefedSpec(h2, TASK, 'maka-artifacts: a.txt b.txt\n\nDraft.\n');
  const events = await collect(await h2.runners.claude.start(spec));
  assert.match(
    failureOf(events),
    /required artifact b\.txt was not exported: the artifacts together would be over 8 bytes/,
  );
});

test('the brief and the manifest of the handoff directory are never replaced', async (t) => {
  const h = await withHarness(t);
  await workspaceFile(h, TASK, 'brief.md', 'agent text');
  await workspaceFile(h, TASK, 'result.json', 'agent text');
  await workspaceFile(h, TASK, 'notes.md', 'notes');
  await fakeManifest(h, { artifacts: ['brief.md', 'result.json', 'notes.md'] });
  const spec = await h.spec(TASK);
  const before = await fs.readFile(spec.briefPath, 'utf8');
  const events = await collect(await h.runners.claude.start(spec));
  assert.equal(terminal(events)?.type, 'finished');
  assert.equal(await fs.readFile(handoff(h, 'brief.md'), 'utf8'), before);
  assert.notEqual(await fs.readFile(handoff(h, 'result.json'), 'utf8'), 'agent text');
  assert.equal((await result(h)).done.at(-1), 'runner-exported: notes.md');
  assert.ok(
    notes(events).some((x) => /artifact brief\.md was not exported: that name is reserved/.test(x)),
  );
});

test('a handoff directory that holds a symlink or a directory in the way is not written through', async (t) => {
  const h = await withHarness(t);
  const outside = join(h.home, 'outside');
  await fs.mkdir(outside, { recursive: true });
  await workspaceFile(h, TASK, 'out/report.md', 'r');
  await workspaceFile(h, TASK, 'other.txt', 'o');
  await workspaceFile(h, TASK, 'dir.txt', 'd');
  await fakeManifest(h, { artifacts: ['out/report.md', 'other.txt', 'dir.txt'] });
  const spec = await h.spec(TASK);
  await fs.symlink(outside, handoff(h, 'out'));
  await fs.symlink(join(outside, 'target.txt'), handoff(h, 'other.txt'));
  await fs.mkdir(handoff(h, 'dir.txt'));
  const events = await collect(await h.runners.claude.start(spec));
  assert.equal(terminal(events)?.type, 'finished');
  assert.deepEqual(await fs.readdir(outside), [], 'nothing was written through a link');
  const n = notes(events);
  assert.ok(
    n.some((x) => /artifact out\/report\.md was not exported: out is a symbolic link/.test(x)),
    n.join('\n'),
  );
  assert.ok(
    n.some((x) =>
      /artifact other\.txt was not exported: something that is not a regular file/.test(x),
    ),
  );
  assert.ok(
    n.some((x) =>
      /artifact dir\.txt was not exported: something that is not a regular file/.test(x),
    ),
  );
});

test('a handoff directory that is a symlink takes nothing', async (t) => {
  const h = await withHarness(t);
  const outside = join(h.home, 'outside');
  await fs.mkdir(outside, { recursive: true });
  await workspaceFile(h, TASK, 'a.txt', 'a');
  await fakeManifest(h, { artifacts: ['a.txt'] });
  const spec = await briefedSpec(h, TASK, 'maka-artifacts: a.txt\n\nDraft.\n');
  const real = join(h.handoff, `${TASK}-real`);
  await fs.rename(dirname(spec.resultPath), real);
  await fs.symlink(real, dirname(spec.resultPath));
  const events = await collect(await h.runners.claude.start(spec));
  assert.match(failureOf(events), /the task directory is a symbolic link/);
  assert.equal(await exists(join(real, 'a.txt')), false);
});

test('exporting again replaces the file, and a resumed turn exports with the brief’s requirements', async (t) => {
  const h = await withHarness(t);
  await workspaceFile(h, TASK, 'out/report.md', 'first');
  await fakeManifest(h, { artifacts: ['out/report.md'] });
  const spec = await briefedSpec(h, TASK, 'maka-artifacts: out/report.md\n\nDraft.\n');
  assert.equal(terminal(await collect(await h.runners.claude.start(spec)))?.type, 'finished');
  assert.equal(await fs.readFile(handoff(h, 'out/report.md'), 'utf8'), 'first');

  await workspaceFile(h, TASK, 'out/report.md', 'second');
  assert.equal(
    terminal(await collect(await h.runners.claude.resume(TASK, { prompt: 'Revise.', spec })))?.type,
    'finished',
  );
  assert.equal(await fs.readFile(handoff(h, 'out/report.md'), 'utf8'), 'second');
  assert.deepEqual((await result(h)).done.slice(-1), ['runner-exported: out/report.md']);

  // On the resumed turn the requirement still holds.
  await fs.rm(join(h.root, TASK, 'workspace', 'out', 'report.md'));
  const failed = await collect(await h.runners.claude.resume(TASK, { prompt: 'Revise.', spec }));
  assert.match(failureOf(failed), /required artifact out\/report\.md was not exported/);
});

test('a misplaced maka-artifacts line fails the task before the CLI starts', async (t) => {
  const h = await withHarness(t);
  const spec = await h.spec(TASK);
  await writeBrief(h, TASK, '# Draft\n\n> maka-artifacts: out/report.md\n');
  const events = await collect(await h.runners.claude.start(spec));
  assert.match(failureOf(events), /maka-artifacts: lines are only read at the very start/);
  assert.equal(await h.cliCalls('claude'), 0);
  assertReleased(h);
});

// -- exits ------------------------------------------------------------------------------------

test('cancel while an artifact is being read ends the run, exports nothing more and delivers no result', async (t) => {
  const h = await withHarness(t);
  await workspaceFile(h, TASK, 'a.txt', 'a');
  await fakeManifest(h, { artifacts: ['a.txt'] });
  const entered = deferred();
  const release = deferred();
  h.fake.onExec = (request) => {
    if (!request.body.envs?.MAKA_STAGE) return undefined;
    entered.resolve();
    return { hold: release.promise };
  };
  const handle = await h.runners.claude.start(
    await briefedSpec(h, TASK, 'maka-artifacts: a.txt\n\nDraft.\n'),
  );
  await entered.promise;
  await handle.cancel();
  const rest = await settles(collect(handle));
  assert.notEqual(rest, 'stuck');
  assert.equal(rest === 'stuck' ? undefined : terminal(rest), undefined);
  assertReleased(h);
  release.resolve();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await exists(handoff(h, 'result.json')), false, 'no result after a cancel');
  assert.equal(await exists(handoff(h, 'a.txt')), false, 'nothing exported after a cancel');
});

test('a read that cannot run fails a required artifact and everything is released; an optional one is a note', async (t) => {
  const h = await withHarness(t);
  await workspaceFile(h, TASK, 'a.txt', 'a');
  await fakeManifest(h, { artifacts: ['a.txt'] });
  h.fake.onExec = (request) =>
    request.body.envs?.MAKA_STAGE
      ? { status: 400, error: { code: 'bad_request', message: 'exec refused', retryable: false } }
      : undefined;
  const failed = await collect(
    await h.runners.claude.start(await briefedSpec(h, TASK, 'maka-artifacts: a.txt\n\nDraft.\n')),
  );
  assert.match(failureOf(failed), /exec refused/);
  assertReleased(h);
});

test('after a successful export the key, lease and sandbox are released', async (t) => {
  const h = await withHarness(t);
  await workspaceFile(h, TASK, 'a.txt', 'a');
  await fakeManifest(h, { artifacts: ['a.txt'] });
  assert.equal(
    terminal(await collect(await h.runners.claude.start(await h.spec(TASK))))?.type,
    'finished',
  );
  assertReleased(h);
});
