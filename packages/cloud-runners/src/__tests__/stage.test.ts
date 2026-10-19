import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { RunSpec } from '@maka-cloud/orchestrator';
import type { CloudRunnersOptions } from '../fleet.js';
import type { InputPolicy } from '../inputs.js';
import {
  collect,
  deferred,
  exists,
  filesUnder,
  type Harness,
  isRunning,
  reader,
  setup,
  settles,
  terminal,
} from './harness.js';

const allow: InputPolicy = { check: () => undefined };
const SOURCE = 'tsk_src';
const TARGET = 'tsk_review';
const REPORT = '{"title":"Harbor","sections":[]}';

async function setupWith(
  cloud: Partial<CloudRunnersOptions> = { inputs: allow },
): Promise<Harness> {
  return await setup({ cloud });
}

/** Files in another task's workspace, which the sandbox (here: the same host) holds. */
async function writeSource(
  h: Harness,
  files: Record<string, string>,
  id = SOURCE,
): Promise<string> {
  const workspace = join(h.root, id, 'workspace');
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(dirname(join(workspace, rel)), { recursive: true });
    await fs.writeFile(join(workspace, rel), text);
  }
  await fs.mkdir(workspace, { recursive: true });
  await h.sessions.put({
    taskId: id,
    runner: 'claude-agent-sdk',
    tenantId: 'default',
    machineId: h.fake.machineId,
    turns: 1,
    snapshotIds: [],
    updatedAt: Date.now(),
  });
  return workspace;
}

async function reviewSpec(h: Harness, request: string, id = TARGET): Promise<RunSpec> {
  const spec = await h.spec(id);
  await fs.writeFile(spec.briefPath, `${request}\n\n# Review the report\n\nJudge each claim.\n`);
  return spec;
}

const staged = (h: Harness, id = TARGET, source = SOURCE): string =>
  join(h.root, id, 'workspace', 'inputs', source);

function stageCalls(h: Harness): number {
  return h.fake.execRequests.filter((request) => request.body.envs?.MAKA_MAX_FILES).length;
}

/** What a run that was refused must have done: no CLI, everything it held given back, nothing copied. */
async function assertRefused(
  h: Harness,
  events: Awaited<ReturnType<typeof collect>>,
  reason: RegExp,
  id = TARGET,
): Promise<void> {
  const end = terminal(events);
  assert.equal(end?.type, 'failed');
  assert.match(end?.type === 'failed' ? end.reason : '', reason);
  assert.equal(await h.cliCalls('claude'), 0, 'the CLI never started');
  assert.deepEqual(h.revoked, [id]);
  assert.equal(h.fake.leases.size, 0);
  assert.equal(h.runners.fleet.openRuns, 0);
  assert.equal(h.runners.fleet.leaseRenewals, 0);
  assert.equal(await exists(staged(h, id)), false, 'nothing was left at the destination');
  const inputs = join(h.root, id, 'workspace', 'inputs');
  const left = (await fs.readdir(inputs).catch(() => [])).filter((name) =>
    name.startsWith('.stage-'),
  );
  assert.deepEqual(left, [], 'no temporary copy is left behind');
}

test('files and directories of another task arrive under inputs/<task>/ before the CLI starts', async (t) => {
  const h = await setupWith();
  t.after(() => h.cleanup());
  await writeSource(h, {
    'report.json': REPORT,
    'sources/a.txt': 'alpha',
    'sources/deep/b.html': '<p>beta</p>',
    'notes/private.txt': 'not requested',
  });
  const spec = await reviewSpec(h, `maka-inputs: ${SOURCE} report.json sources`);
  const events = await collect(await h.runners.claude.start(spec));
  assert.equal(terminal(events)?.type, 'finished');

  const dir = staged(h);
  assert.equal(await fs.readFile(join(dir, 'report.json'), 'utf8'), REPORT);
  assert.equal(await fs.readFile(join(dir, 'sources/a.txt'), 'utf8'), 'alpha');
  assert.equal(await fs.readFile(join(dir, 'sources/deep/b.html'), 'utf8'), '<p>beta</p>');
  assert.equal(await exists(join(dir, 'notes')), false, 'only what was asked for');
  assert.equal(
    (await fs.stat(join(dir, 'report.json'))).mode & 0o077,
    0,
    'private to the sandbox user',
  );

  const { argv } = await h.cliCall('claude', 1);
  const prompt = argv[argv.indexOf('-p') + 1] ?? '';
  assert.match(
    prompt,
    new RegExp(
      `${TARGET}/workspace/: report\\.json, sources of task ${SOURCE} \\(3 files\\) in inputs/${SOURCE}/`,
    ),
  );
  // The brief reached the sandbox unchanged, request lines included.
  assert.match(
    await fs.readFile(join(h.root, TARGET, 'brief.md'), 'utf8'),
    /^maka-inputs: tsk_src report\.json sources\n/,
  );
  // The sandbox user did all of it.
  assert.equal(h.fake.requestsTo('GET', /\/files$/).length, 0);
  assert.equal(stageCalls(h), 1);
});

test('files of several tasks are staged, each under its own directory', async (t) => {
  const h = await setupWith();
  t.after(() => h.cleanup());
  await writeSource(h, { 'report.json': REPORT });
  await writeSource(h, { 'judgments.json': '[]' }, 'tsk_judge');
  const spec = await reviewSpec(
    h,
    `maka-inputs: ${SOURCE} report.json\nmaka-inputs: tsk_judge judgments.json`,
  );
  assert.equal(terminal(await collect(await h.runners.claude.start(spec)))?.type, 'finished');
  assert.equal(await fs.readFile(join(staged(h), 'report.json'), 'utf8'), REPORT);
  assert.equal(
    await fs.readFile(join(staged(h, TARGET, 'tsk_judge'), 'judgments.json'), 'utf8'),
    '[]',
  );
});

test('staging again replaces the earlier copy instead of merging into it', async (t) => {
  const h = await setupWith();
  t.after(() => h.cleanup());
  await writeSource(h, { 'report.json': REPORT });
  const stale = join(staged(h), 'stale.txt');
  await fs.mkdir(staged(h), { recursive: true });
  await fs.writeFile(stale, 'left over from an earlier attempt');
  const spec = await reviewSpec(h, `maka-inputs: ${SOURCE} report.json`);
  assert.equal(terminal(await collect(await h.runners.claude.start(spec)))?.type, 'finished');
  assert.equal(await exists(stale), false);
  assert.deepEqual(
    (await filesUnder(staged(h))).map((p) => p.slice(staged(h).length + 1)),
    ['report.json'],
  );
});

test('a resumed turn does not stage again, and the files are still there', async (t) => {
  const h = await setupWith();
  t.after(() => h.cleanup());
  await writeSource(h, { 'report.json': REPORT });
  const spec = await reviewSpec(h, `maka-inputs: ${SOURCE} report.json`);
  assert.equal(terminal(await collect(await h.runners.claude.start(spec)))?.type, 'finished');
  assert.equal(stageCalls(h), 1);
  // The source changes after the first turn; a resume must not pick that up.
  await fs.writeFile(join(h.root, SOURCE, 'workspace', 'report.json'), 'changed');
  const resumed = await collect(
    await h.runners.claude.resume(TARGET, { prompt: 'Look again.', spec }),
  );
  assert.equal(terminal(resumed)?.type, 'finished');
  assert.equal(stageCalls(h), 1);
  assert.equal(await fs.readFile(join(staged(h), 'report.json'), 'utf8'), REPORT);
});

test('a brief without a request starts exactly as before', async (t) => {
  const h = await setupWith({});
  t.after(() => h.cleanup());
  const spec = await h.spec('tsk_plain');
  assert.equal(terminal(await collect(await h.runners.claude.start(spec)))?.type, 'finished');
  assert.equal(stageCalls(h), 0);
  const { argv } = await h.cliCall('claude', 1);
  assert.doesNotMatch(argv[argv.indexOf('-p') + 1] ?? '', /copied/);
});

// -- refusals: each one fails the task before the CLI starts ---------------------------------------

test('a brief that asks for inputs where none are provided fails', async (t) => {
  const h = await setupWith({});
  t.after(() => h.cleanup());
  await writeSource(h, { 'report.json': REPORT });
  const events = await collect(
    await h.runners.claude.start(await reviewSpec(h, `maka-inputs: ${SOURCE} report.json`)),
  );
  await assertRefused(h, events, /does not provide/);
  assert.equal(stageCalls(h), 0);
});

test('a request line that is not at the start of the brief fails the task', async (t) => {
  const h = await setupWith();
  t.after(() => h.cleanup());
  await writeSource(h, { 'report.json': REPORT });
  const spec = await h.spec(TARGET);
  await fs.writeFile(
    spec.briefPath,
    `# Review\n\nQuoted from a page:\n> maka-inputs: ${SOURCE} report.json\n`,
  );
  const events = await collect(await h.runners.claude.start(spec));
  await assertRefused(h, events, /only read at the very start/);
  assert.equal(stageCalls(h), 0);
});

test('a malformed request fails the task', async (t) => {
  const h = await setupWith();
  t.after(() => h.cleanup());
  const events = await collect(
    await h.runners.claude.start(await reviewSpec(h, `maka-inputs: ${SOURCE} ../../etc`)),
  );
  await assertRefused(h, events, /not a plain relative path/);
});

test('a task cannot take its own files', async (t) => {
  const h = await setupWith();
  t.after(() => h.cleanup());
  await writeSource(h, { 'report.json': REPORT }, TARGET);
  const events = await collect(
    await h.runners.claude.start(await reviewSpec(h, `maka-inputs: ${TARGET} report.json`)),
  );
  await assertRefused(h, events, /own files/);
  assert.equal(stageCalls(h), 0);
});

test('a task of another tenant is refused before anything is read', async (t) => {
  const h = await setupWith({
    inputs: allow,
    tenantOf: (id) => (id === 'tsk_other' ? 'tenant-b' : 'default'),
  });
  t.after(() => h.cleanup());
  await writeSource(h, { 'report.json': REPORT }, 'tsk_other');
  const events = await collect(
    await h.runners.claude.start(await reviewSpec(h, 'maka-inputs: tsk_other report.json')),
  );
  await assertRefused(h, events, /another tenant/);
  assert.equal(stageCalls(h), 0);
});

test('a task the runner has no record of is refused', async (t) => {
  const h = await setupWith();
  t.after(() => h.cleanup());
  await fs.mkdir(join(h.root, 'tsk_unknown', 'workspace'), { recursive: true });
  await fs.writeFile(join(h.root, 'tsk_unknown', 'workspace', 'report.json'), REPORT);
  const events = await collect(
    await h.runners.claude.start(await reviewSpec(h, 'maka-inputs: tsk_unknown report.json')),
  );
  await assertRefused(h, events, /no sandbox is recorded/);
  assert.equal(stageCalls(h), 0);
});

test('a task on another sandbox is refused, not copied across', async (t) => {
  const h = await setupWith();
  t.after(() => h.cleanup());
  await writeSource(h, { 'report.json': REPORT });
  await h.sessions.put({
    ...(await h.sessions.get(SOURCE))!,
    machineId: 'm_bbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  const events = await collect(
    await h.runners.claude.start(await reviewSpec(h, `maka-inputs: ${SOURCE} report.json`)),
  );
  await assertRefused(h, events, /on another sandbox/);
  assert.equal(stageCalls(h), 0);
});

test('the policy decides, and its reason reaches the task', async (t) => {
  const asked: { target: string; source: string }[] = [];
  const h = await setupWith({
    inputs: {
      check: (input) => {
        asked.push(input);
        return 'task tsk_src is not part of this conversation';
      },
    },
  });
  t.after(() => h.cleanup());
  await writeSource(h, { 'report.json': REPORT });
  const events = await collect(
    await h.runners.claude.start(await reviewSpec(h, `maka-inputs: ${SOURCE} report.json`)),
  );
  await assertRefused(
    h,
    events,
    /inputs from tsk_src: task tsk_src is not part of this conversation/,
  );
  assert.deepEqual(asked, [{ target: TARGET, source: SOURCE }]);
  assert.equal(stageCalls(h), 0);
});

test('a policy that throws fails the task and everything is released', async (t) => {
  const h = await setupWith({
    inputs: {
      check: () => {
        throw new Error('directory unavailable');
      },
    },
  });
  t.after(() => h.cleanup());
  await writeSource(h, { 'report.json': REPORT });
  const events = await collect(
    await h.runners.claude.start(await reviewSpec(h, `maka-inputs: ${SOURCE} report.json`)),
  );
  await assertRefused(h, events, /directory unavailable/);
});

test('a path the source does not have, or a source without a directory, is refused', async (t) => {
  const h = await setupWith();
  t.after(() => h.cleanup());
  await writeSource(h, { 'report.json': REPORT });
  await assertRefused(
    h,
    await collect(
      await h.runners.claude.start(
        await reviewSpec(h, `maka-inputs: ${SOURCE} report.json sources`),
      ),
    ),
    /sources does not exist in task tsk_src/,
  );

  // A record without a directory: the task never ran here, or its directory was removed.
  const h2 = await setupWith();
  t.after(() => h2.cleanup());
  await writeSource(h2, { 'report.json': REPORT });
  await fs.rm(join(h2.root, SOURCE), { recursive: true });
  await assertRefused(
    h2,
    await collect(
      await h2.runners.claude.start(await reviewSpec(h2, `maka-inputs: ${SOURCE} report.json`)),
    ),
    /has no directory in this sandbox/,
  );
});

test('symbolic links are refused wherever they are', async (t) => {
  const outside = '/dev/shm/stage-outside-secret.txt';
  await fs.writeFile(outside, 'secret');
  t.after(() => fs.rm(outside, { force: true }));
  const cases: {
    name: string;
    link: (workspace: string) => Promise<void>;
    request: string;
    reason: RegExp;
  }[] = [
    {
      name: 'the requested file is a link',
      link: async (w) => void (await fs.symlink(outside, join(w, 'report.json'))),
      request: 'report.json',
      reason: /report\.json goes through a symbolic link/,
    },
    {
      name: 'the requested directory is a link',
      link: async (w) => void (await fs.symlink('/dev/shm', join(w, 'sources'))),
      request: 'sources',
      reason: /sources goes through a symbolic link/,
    },
    {
      name: 'a directory on the way is a link',
      link: async (w) => {
        await fs.mkdir(join(w, 'out'));
        await fs.symlink('/dev/shm', join(w, 'out', 'inner'));
      },
      request: 'out/inner/x.txt',
      reason: /goes through a symbolic link/,
    },
    {
      name: 'a file inside a requested directory is a link',
      link: async (w) => {
        await fs.mkdir(join(w, 'sources'));
        await fs.writeFile(join(w, 'sources', 'ok.txt'), 'fine');
        await fs.symlink(outside, join(w, 'sources', 'leak.txt'));
      },
      request: 'sources',
      reason: /sources contains a symbolic link/,
    },
    {
      name: 'a directory inside a requested directory is a link',
      link: async (w) => {
        await fs.mkdir(join(w, 'sources'));
        await fs.symlink('/dev/shm', join(w, 'sources', 'dir'));
      },
      request: 'sources',
      reason: /sources contains a symbolic link/,
    },
  ];
  for (const c of cases) {
    const h = await setupWith();
    t.after(() => h.cleanup());
    const workspace = await writeSource(h, {});
    await c.link(workspace);
    const events = await collect(
      await h.runners.claude.start(await reviewSpec(h, `maka-inputs: ${SOURCE} ${c.request}`)),
    );
    await assertRefused(h, events, c.reason);
    assert.equal(await h.cliCalls('claude'), 0, c.name);
  }
});

test('the source workspace and the source directory themselves may not be links', async (t) => {
  const h = await setupWith();
  t.after(() => h.cleanup());
  await fs.mkdir('/dev/shm/stage-elsewhere', { recursive: true });
  t.after(() => fs.rm('/dev/shm/stage-elsewhere', { recursive: true, force: true }));
  await fs.writeFile('/dev/shm/stage-elsewhere/report.json', REPORT);
  const workspace = await writeSource(h, {});
  await fs.rm(workspace, { recursive: true });
  await fs.symlink('/dev/shm/stage-elsewhere', workspace);
  const events = await collect(
    await h.runners.claude.start(await reviewSpec(h, `maka-inputs: ${SOURCE} report.json`)),
  );
  await assertRefused(h, events, /has no workspace/);
});

test('something that is not a regular file is refused', async (t) => {
  const h = await setupWith();
  t.after(() => h.cleanup());
  const workspace = await writeSource(h, { 'sources/ok.txt': 'fine' });
  execFileSync('mkfifo', [join(workspace, 'sources', 'pipe')]);
  const events = await collect(
    await h.runners.claude.start(await reviewSpec(h, `maka-inputs: ${SOURCE} sources`)),
  );
  await assertRefused(h, events, /sources contains something that is not a regular file/);
});

test('a source with a process still running is refused', async (t) => {
  const h = await setupWith();
  t.after(() => h.cleanup());
  await h.setMode('hang');
  const source = await h.runners.claude.start(await h.spec(SOURCE));
  const watching = reader(source);
  await watching.until((e) => e.type === 'progress' && e.note === 'working on it');
  const pid = await h.runPid(SOURCE);
  assert.equal(await isRunning(pid), true);
  await fs.mkdir(join(h.root, SOURCE, 'workspace'), { recursive: true });
  await fs.writeFile(join(h.root, SOURCE, 'workspace', 'report.json'), REPORT);

  await h.setMode('ok');
  const events = await collect(
    await h.runners.claude.start(await reviewSpec(h, `maka-inputs: ${SOURCE} report.json`)),
  );
  const end = terminal(events);
  assert.equal(end?.type, 'failed');
  assert.match(end?.type === 'failed' ? end.reason : '', /still has a running process/);
  assert.equal(await exists(staged(h)), false);
  assert.equal(await h.cliCalls('claude'), 1, 'only the source ran');

  await source.cancel();
  await watching.rest();
});

test('the caps on files, size per file and total size are enforced', async (t) => {
  const cases: { limits: NonNullable<CloudRunnersOptions['inputLimits']>; reason: RegExp }[] = [
    { limits: { maxFiles: 2 }, reason: /more than 2 files/ },
    { limits: { maxFileBytes: 4 }, reason: /is larger than 4 bytes/ },
    { limits: { maxTotalBytes: 10 }, reason: /more than 10 bytes/ },
  ];
  for (const c of cases) {
    const h = await setupWith({ inputs: allow, inputLimits: c.limits });
    t.after(() => h.cleanup());
    await writeSource(h, {
      'sources/a.txt': 'aaaaa',
      'sources/b.txt': 'bbbbb',
      'sources/c.txt': 'ccccc',
    });
    const events = await collect(
      await h.runners.claude.start(await reviewSpec(h, `maka-inputs: ${SOURCE} sources`)),
    );
    await assertRefused(h, events, c.reason);
  }
});

test('a request that matches no file is refused', async (t) => {
  const h = await setupWith();
  t.after(() => h.cleanup());
  await fs.mkdir(join(h.root, SOURCE, 'workspace', 'sources'), { recursive: true });
  await writeSource(h, {});
  const events = await collect(
    await h.runners.claude.start(await reviewSpec(h, `maka-inputs: ${SOURCE} sources`)),
  );
  await assertRefused(h, events, /no files to copy/);
});

test('a refusal after earlier sources were copied leaves nothing of the failed one and no stray temp', async (t) => {
  const h = await setupWith();
  t.after(() => h.cleanup());
  await writeSource(h, { 'report.json': REPORT });
  await writeSource(h, {}, 'tsk_judge');
  const spec = await reviewSpec(
    h,
    `maka-inputs: ${SOURCE} report.json\nmaka-inputs: tsk_judge judgments.json`,
  );
  const events = await collect(await h.runners.claude.start(spec));
  const end = terminal(events);
  assert.equal(end?.type, 'failed');
  assert.match(
    end?.type === 'failed' ? end.reason : '',
    /inputs from tsk_judge: judgments\.json does not exist/,
  );
  assert.equal(await h.cliCalls('claude'), 0);
  assert.equal(await exists(staged(h, TARGET, 'tsk_judge')), false);
  const left = (await fs.readdir(join(h.root, TARGET, 'workspace', 'inputs'))).filter((n) =>
    n.startsWith('.stage-'),
  );
  assert.deepEqual(left, []);
});

// -- exits: cancel, a failing exec, and the end -----------------------------------------------------

test('cancel while the policy is being asked ends the run and releases everything', async (t) => {
  const asked = deferred();
  const answer = deferred<string | undefined>();
  const h = await setupWith({
    inputs: {
      check: () => {
        asked.resolve();
        return answer.promise;
      },
    },
  });
  t.after(() => h.cleanup());
  await writeSource(h, { 'report.json': REPORT });
  const handle = await h.runners.claude.start(
    await reviewSpec(h, `maka-inputs: ${SOURCE} report.json`),
  );
  await asked.promise;
  await handle.cancel();
  const rest = await settles(collect(handle));
  assert.notEqual(rest, 'stuck');
  assert.equal(rest === 'stuck' ? undefined : terminal(rest), undefined);
  assert.equal(await h.cliCalls('claude'), 0);
  assert.deepEqual(h.revoked, [TARGET]);
  assert.equal(h.fake.leases.size, 0);
  assert.equal(h.runners.fleet.openRuns, 0);

  // The answer that arrives afterwards starts nothing.
  answer.resolve(undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stageCalls(h), 0);
  assert.equal(await h.cliCalls('claude'), 0);
});

test('cancel while the files are being copied ends the run and the CLI never starts', async (t) => {
  const h = await setupWith();
  t.after(() => h.cleanup());
  await writeSource(h, { 'report.json': REPORT });
  const entered = deferred();
  const release = deferred();
  h.fake.onExec = (request) => {
    if (!request.body.envs?.MAKA_MAX_FILES) return undefined;
    entered.resolve();
    return { hold: release.promise };
  };
  const handle = await h.runners.claude.start(
    await reviewSpec(h, `maka-inputs: ${SOURCE} report.json`),
  );
  await entered.promise;
  await handle.cancel();
  const rest = await settles(collect(handle));
  assert.notEqual(rest, 'stuck');
  assert.equal(rest === 'stuck' ? undefined : terminal(rest), undefined);
  assert.deepEqual(h.revoked, [TARGET]);
  assert.equal(h.fake.leases.size, 0);
  assert.equal(h.runners.fleet.openRuns, 0);
  release.resolve();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await h.cliCalls('claude'), 0, 'a copy that finishes late starts nothing');
});

test('a copy that cannot be run fails the task and everything is released', async (t) => {
  const h = await setupWith();
  t.after(() => h.cleanup());
  await writeSource(h, { 'report.json': REPORT });
  h.fake.onExec = (request) =>
    request.body.envs?.MAKA_MAX_FILES
      ? { status: 400, error: { code: 'bad_request', message: 'exec refused', retryable: false } }
      : undefined;
  const events = await collect(
    await h.runners.claude.start(await reviewSpec(h, `maka-inputs: ${SOURCE} report.json`)),
  );
  await assertRefused(h, events, /exec refused/);
});
