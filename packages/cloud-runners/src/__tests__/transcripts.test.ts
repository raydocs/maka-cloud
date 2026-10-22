import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  MemoryTranscriptStore,
  restoreTranscript,
  TranscriptFull,
  type TranscriptLimits,
  type TranscriptLine,
  type TranscriptStore,
  transcriptSessionStore,
} from '../transcripts.js';
import { SqliteTranscriptStore } from '../sqlite-transcripts.js';
import { TRANSCRIPT_CHUNK_SCRIPT } from '../scripts.js';
import { setup } from './harness.js';

const SESSION = '11111111-2222-4333-8444-555555555555';
const OTHER_SESSION = '99999999-2222-4333-8444-555555555555';
const THINKING = {
  type: 'thinking',
  thinking: 'The user wants the file renamed.',
  signature:
    'EqQBCkYIBxgCKkA0Vh7Pq9m1ZtQ2w8d3Jx5sL0bN4cR6yU/aKfGhTeWnMoPzXvB1iDjE2lSq+u7CyHrAgFkIwVtQpZnYb',
};

const KEY = { projectKey: '-work-tsk-a-workspace', sessionId: SESSION };

const line = (n: number, extra: Record<string, unknown> = {}): TranscriptLine => {
  const uuid = `u${n}`;
  return { json: JSON.stringify({ type: 'user', uuid, n, ...extra }), uuid };
};

const STORES: Array<[string, (limits?: Partial<TranscriptLimits>) => TranscriptStore]> = [
  ['memory', (limits) => new MemoryTranscriptStore(limits)],
  ['sqlite', (limits) => SqliteTranscriptStore.open(':memory:', limits)],
];

for (const [name, make] of STORES) {
  test(`${name}: lines come back in the order they were kept, and a batch sent again lands once`, async () => {
    const store = make();
    await store.append('tsk_a', KEY, [line(1), line(2)]);
    await store.append('tsk_a', KEY, [line(2), line(3)]);
    await store.append('tsk_a', KEY, [line(3)]);
    assert.deepEqual(await store.locate('tsk_a', SESSION), {
      projectKey: KEY.projectKey,
      lines: 3,
    });
    const page = await store.read('tsk_a', SESSION);
    assert.deepEqual(
      page.lines.map((text) => JSON.parse(text).n),
      [1, 2, 3],
    );
    assert.equal(page.next, undefined);
    // Lines without a uuid (titles, tags) are kept as they come.
    const bare: TranscriptLine = { json: '{"type":"title","title":"x"}' };
    await store.append('tsk_a', KEY, [bare, bare]);
    assert.equal((await store.locate('tsk_a', SESSION))?.lines, 5);
  });

  test(`${name}: append answers with the lines it committed, not those it skipped as stored already`, async () => {
    const store = make();
    assert.deepEqual(await store.append('tsk_a', KEY, [line(1), line(2), line(2)]), [
      line(1),
      line(2),
    ]);
    assert.deepEqual(await store.append('tsk_a', KEY, [line(2), line(3)]), [line(3)]);
    assert.deepEqual(await store.append('tsk_a', KEY, [line(1), line(3)]), []);
    const bare: TranscriptLine = { json: '{"type":"title","title":"x"}' };
    assert.deepEqual(await store.append('tsk_a', KEY, [bare, bare]), [bare, bare]);
  });

  test(`${name}: the mirror reports as kept only the lines the store committed`, async () => {
    const store = make();
    const kept: string[][] = [];
    const mirror = transcriptSessionStore({
      taskId: 'tsk_a',
      store,
      onKept: (lines) => kept.push(lines.map((entry) => entry.uuid ?? '')),
    });
    const entry = (n: number) => JSON.parse(line(n).json);
    await mirror.append(KEY, [entry(1), entry(2)]);
    // A batch sent again, with one new line among the old.
    await mirror.append(KEY, [entry(2), entry(3)]);
    await mirror.append(KEY, [entry(1)]);
    assert.deepEqual(kept, [['u1', 'u2'], ['u3'], []]);
  });

  test(`${name}: a transcript is read in pages that cover it once`, async () => {
    const store = make();
    await store.append(
      'tsk_a',
      KEY,
      Array.from({ length: 10 }, (_, i) => line(i, { pad: 'x'.repeat(100) })),
    );
    const seen: number[] = [];
    let cursor: number | undefined;
    let pages = 0;
    for (;;) {
      const page = await store.read('tsk_a', SESSION, cursor, 400);
      pages++;
      seen.push(...page.lines.map((text) => JSON.parse(text).n));
      if (page.next === undefined) break;
      cursor = page.next;
    }
    assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.ok(pages > 1, 'a small page limit splits the transcript');
  });

  test(`${name}: transcripts belong to their task: another task, and another session, see nothing of them`, async () => {
    const store = make();
    await store.append('tsk_a', KEY, [line(1)]);
    assert.equal(await store.locate('tsk_b', SESSION), undefined);
    assert.equal(await store.locate('tsk_a', OTHER_SESSION), undefined);
    assert.deepEqual((await store.read('tsk_b', SESSION)).lines, []);
    await store.deleteTask('tsk_a');
    assert.equal(await store.locate('tsk_a', SESSION), undefined);
  });

  test(`${name}: keys that are not plain names are refused, and a task keeps one project key`, async () => {
    const store = make();
    for (const key of [
      { ...KEY, projectKey: '../etc' },
      { ...KEY, projectKey: '..' },
      { ...KEY, projectKey: 'a/b' },
      { ...KEY, projectKey: '.hidden' },
      { ...KEY, projectKey: '' },
      { ...KEY, projectKey: 'x'.repeat(300) },
      { ...KEY, sessionId: '../../x' },
      { ...KEY, sessionId: 'sess-1' },
      { ...KEY, subpath: '../x' },
      { ...KEY, subpath: '/abs' },
      { ...KEY, subpath: '' },
    ]) {
      await assert.rejects(store.append('tsk_a', key, [line(1)]), /refused/, JSON.stringify(key));
    }
    assert.equal(await store.locate('tsk_a', SESSION), undefined, 'a refused batch keeps nothing');
    await store.append('tsk_a', KEY, [line(1)]);
    await assert.rejects(
      store.append('tsk_a', { ...KEY, projectKey: '-elsewhere' }, [line(2)]),
      /another project key/,
    );
    // A subagent's transcript is kept apart from the main one.
    await store.append('tsk_a', { ...KEY, subpath: 'subagents/agent-1' }, [line(9)]);
    assert.equal((await store.locate('tsk_a', SESSION))?.lines, 1);
  });

  test(`${name}: a line, a batch and a task are capped, and a refused batch keeps nothing of itself`, async () => {
    const store = make({
      maxLineBytes: 100,
      maxBatchBytes: 150,
      maxTaskBytes: 300,
      maxTranscripts: 2,
    });
    const big = { json: JSON.stringify({ type: 'user', pad: 'x'.repeat(200) }) };
    await assert.rejects(store.append('tsk_a', KEY, [big]), TranscriptFull);
    const small = (n: number) => line(n, { pad: 'y'.repeat(30) });
    await assert.rejects(
      store.append('tsk_a', KEY, [small(1), small(2), small(3), small(4)]),
      /batch/,
    );
    assert.equal(await store.locate('tsk_a', SESSION), undefined);
    await store.append('tsk_a', KEY, [small(1), small(2)]);
    await store.append('tsk_a', KEY, [small(3), small(4)]);
    await assert.rejects(store.append('tsk_a', KEY, [small(5), small(6)]), /byte cap/);
    assert.equal((await store.locate('tsk_a', SESSION))?.lines, 4);
    await store.append('tsk_b', KEY, [small(1)]);
    await store.append('tsk_b', { ...KEY, subpath: 'subagents/a' }, [small(2)]);
    await assert.rejects(
      store.append('tsk_b', { ...KEY, subpath: 'subagents/b' }, [small(3)]),
      /transcripts/,
    );
  });
}

test('the SDK’s store keeps every line exactly as written, in order, and gives nothing back', async () => {
  const kept = new MemoryTranscriptStore();
  const problems: string[] = [];
  const mirror = transcriptSessionStore({
    taskId: 'tsk_a',
    store: kept,
    onProblem: (message) => problems.push(message),
  });
  // The first append is slow; the second must still land after it.
  const slow = new Promise<void>((resolve) => setTimeout(resolve, 30));
  const realAppend = kept.append.bind(kept);
  let first = true;
  kept.append = async (...args) => {
    if (first) {
      first = false;
      await slow;
    }
    return await realAppend(...args);
  };
  await Promise.all([
    mirror.append(KEY, [
      { type: 'user', uuid: 'a', message: { content: 'key sk-secret-123456 here' } },
      { type: 'assistant', uuid: 'b', message: { content: [THINKING] } },
    ]),
    mirror.append(KEY, [{ type: 'assistant', uuid: 'c' }]),
  ]);
  const lines = (await kept.read('tsk_a', SESSION)).lines;
  // The model checks its own history on a resume (the signature of a thinking block, the redacted
  // blocks): a line the store changed would fail it.
  assert.ok(lines[0]?.includes('sk-secret-123456'), 'the line was edited');
  assert.deepEqual(JSON.parse(lines[1] ?? ''), {
    type: 'assistant',
    uuid: 'b',
    message: { content: [THINKING] },
  });
  assert.deepEqual(
    (await kept.read('tsk_a', SESSION)).lines.map((l) => JSON.parse(l).uuid),
    ['a', 'b', 'c'],
  );
  assert.equal(await mirror.load(KEY), null);
  assert.deepEqual(problems, []);
});

test('a refusal by the store is reported and passed to the SDK, and the next batch still goes in', async () => {
  const kept = new MemoryTranscriptStore();
  const problems: string[] = [];
  const mirror = transcriptSessionStore({
    taskId: 'tsk_a',
    store: kept,
    onProblem: (message) => problems.push(message),
  });
  await assert.rejects(
    mirror.append({ ...KEY, projectKey: '../x' }, [{ type: 'user', uuid: 'a' }]),
    /refused/,
  );
  await assert.rejects(mirror.append(KEY, [null as never]), /not an object/);
  await mirror.append(KEY, [{ type: 'user', uuid: 'b' }]);
  assert.equal(problems.length, 2);
  assert.match(problems[0] ?? '', /a transcript batch was not kept/);
  assert.equal((await kept.locate('tsk_a', SESSION))?.lines, 1);
});

test('an entry that is not an object with a type keeps nothing and says so', async () => {
  const kept = new MemoryTranscriptStore();
  const mirror = transcriptSessionStore({ taskId: 'tsk_a', store: kept });
  await assert.rejects(
    mirror.append(KEY, [{ type: 'user', uuid: 'a' }, { uuid: 'b' } as never]),
    /not an object with a type/,
  );
  assert.equal(await kept.locate('tsk_a', SESSION), undefined);
});

test('the transcript database is readable by its owner only, with its log and journal', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'transcripts-mode-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'transcripts.db');
  // A database an earlier version made with the default mode is put right when it is opened.
  await fs.writeFile(path, '', { mode: 0o644 });
  const store = SqliteTranscriptStore.open(path);
  t.after(() => store.close());
  await store.append('tsk_a', KEY, [
    { json: JSON.stringify({ type: 'user', uuid: 'a' }), uuid: 'a' },
  ]);
  const modes = new Map<string, number>();
  for (const name of await fs.readdir(dir)) {
    modes.set(name, (await fs.stat(join(dir, name))).mode & 0o777);
  }
  assert.ok(modes.size >= 1);
  for (const [name, mode] of modes) assert.equal(mode & 0o077, 0, `${name} is ${mode.toString(8)}`);
});

// -- the sandbox side ----------------------------------------------------------------------------

async function bytesOf(...parts: string[]): Promise<AsyncGenerator<Buffer>> {
  return (async function* () {
    for (const part of parts) yield Buffer.from(part);
  })();
}

async function rig(t: { after(fn: () => Promise<void>): void }, dir: string) {
  const h = await setup();
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await machine.prepare(dir);
  const file = join(machine.configDir(dir), 'projects', KEY.projectKey, `${SESSION}.jsonl`);
  return { h, machine, file };
}

test('a transcript larger than one chunk is written whole, atomically, and counted', async (t) => {
  const r = await rig(t, 'tsk_up_big');
  const text =
    Array.from({ length: 3000 }, (_, i) => JSON.stringify({ i, pad: 'é'.repeat(100) })).join('\n') +
    '\n';
  assert.ok(Buffer.byteLength(text) > 512 * 1024, 'more than two chunks');
  await r.machine.installTranscript({
    dirName: 'tsk_up_big',
    ...KEY,
    // Uneven pieces, with a character cut across two of them.
    bytes: await bytesOf(text.slice(0, 1000), text.slice(1000, 400_001), text.slice(400_001)),
  });
  assert.equal(await fs.readFile(r.file, 'utf8'), text);
  assert.equal(await r.machine.transcriptLines('tsk_up_big', KEY.projectKey, SESSION), 3000);
  const left = await fs.readdir(
    join(r.machine.configDir('tsk_up_big'), 'projects', KEY.projectKey),
  );
  assert.deepEqual(left, [`${SESSION}.jsonl`], 'no temporary file is left');
});

test('an empty transcript is written as an empty file; a missing one counts as no lines', async (t) => {
  const r = await rig(t, 'tsk_up_empty');
  assert.equal(await r.machine.transcriptLines('tsk_up_empty', KEY.projectKey, SESSION), 0);
  await r.machine.installTranscript({ dirName: 'tsk_up_empty', ...KEY, bytes: await bytesOf() });
  assert.equal(await fs.readFile(r.file, 'utf8'), '');
});

test('an upload that fails halfway leaves no file behind and the earlier transcript stays', async (t) => {
  const r = await rig(t, 'tsk_up_fail');
  await r.machine.installTranscript({
    dirName: 'tsk_up_fail',
    ...KEY,
    bytes: await bytesOf('{"a":1}\n'),
  });
  const broken = (async function* () {
    yield Buffer.alloc(300 * 1024, 0x61);
    yield Buffer.alloc(300 * 1024, 0x62);
    throw new Error('store went away');
  })();
  await assert.rejects(
    r.machine.installTranscript({ dirName: 'tsk_up_fail', ...KEY, bytes: broken }),
    /store went away/,
  );
  assert.equal(await fs.readFile(r.file, 'utf8'), '{"a":1}\n');
  const left = await fs.readdir(
    join(r.machine.configDir('tsk_up_fail'), 'projects', KEY.projectKey),
  );
  assert.deepEqual(left, [`${SESSION}.jsonl`]);
});

test('a chunk sent again lands once, a chunk out of step is refused, and a damaged file is not put in place', async (t) => {
  const r = await rig(t, 'tsk_up_chunks');
  const run = (extra: Record<string, string>, stdin: string) =>
    r.machine.execOk(TRANSCRIPT_CHUNK_SCRIPT, {
      envs: {
        MAKA_DIR: r.machine.taskDir('tsk_up_chunks'),
        MAKA_KEY: KEY.projectKey,
        MAKA_SESSION: SESSION,
        MAKA_LAST: '0',
        MAKA_HASH: '',
        ...extra,
      },
      stdin: Buffer.from(stdin).toString('base64'),
    });
  const tmp = join(
    r.machine.configDir('tsk_up_chunks'),
    'projects',
    KEY.projectKey,
    `.restore-${SESSION}.tmp`,
  );
  await run({ MAKA_OFFSET: '0', MAKA_LEN: '4' }, 'abc\n');
  await run({ MAKA_OFFSET: '0', MAKA_LEN: '4' }, 'abc\n'); // the first chunk again: starts over
  await run({ MAKA_OFFSET: '4', MAKA_LEN: '3' }, 'de\n');
  await run({ MAKA_OFFSET: '4', MAKA_LEN: '3' }, 'de\n'); // the answer was lost: not written twice
  assert.equal(await fs.readFile(tmp, 'utf8'), 'abc\nde\n');
  await assert.rejects(run({ MAKA_OFFSET: '2', MAKA_LEN: '3' }, 'zz\n'), /out of step/);
  assert.equal(await fs.readFile(tmp, 'utf8'), 'abc\nde\n');
  await assert.rejects(
    run({ MAKA_OFFSET: '7', MAKA_LEN: '0', MAKA_LAST: '1', MAKA_HASH: 'f'.repeat(64) }, ''),
    /damaged/,
  );
  await assert.rejects(fs.stat(r.file), 'a damaged file is not put in place');
  await assert.rejects(fs.stat(tmp), 'and its temporary file is removed');
});

test('a link where the configuration directory should be is not followed', async (t) => {
  const r = await rig(t, 'tsk_up_link');
  const outside = join(r.h.tmp, 'outside');
  await fs.mkdir(outside, { recursive: true });
  await fs.symlink(outside, r.machine.configDir('tsk_up_link'));
  await assert.rejects(
    r.machine.installTranscript({
      dirName: 'tsk_up_link',
      ...KEY,
      bytes: await bytesOf('{"a":1}\n'),
    }),
    /symbolic link/,
  );
  assert.deepEqual(await fs.readdir(outside), [], 'nothing was written through the link');
  // The same for the directory of the project, and the probe does not read through links either.
  await fs.rm(r.machine.configDir('tsk_up_link'));
  const projects = join(r.machine.configDir('tsk_up_link'), 'projects');
  await fs.mkdir(projects, { recursive: true });
  await fs.symlink(outside, join(projects, KEY.projectKey));
  await assert.rejects(
    r.machine.installTranscript({
      dirName: 'tsk_up_link',
      ...KEY,
      bytes: await bytesOf('{"a":1}\n'),
    }),
    /symbolic link/,
  );
  await fs.writeFile(join(outside, `${SESSION}.jsonl`), 'a\nb\n');
  assert.equal(await r.machine.transcriptLines('tsk_up_link', KEY.projectKey, SESSION), 0);
  assert.deepEqual(await fs.readdir(outside), [`${SESSION}.jsonl`]);
});

test('a sandbox always gets the store’s copy of the transcript, whatever the one it has holds', async (t) => {
  const r = await rig(t, 'tsk_restore');
  const store = new MemoryTranscriptStore();
  await store.append('tsk_restore', KEY, [line(1), line(2), line(3)]);
  const input = { machine: r.machine, store, taskId: 'tsk_restore', sessionId: SESSION };

  assert.deepEqual(await restoreTranscript(input), {
    status: 'restored',
    projectKey: KEY.projectKey,
    lines: 3,
  });
  assert.equal((await fs.readFile(r.file, 'utf8')).split('\n').filter(Boolean).length, 3);
  // The server's copy is always the one put on the sandbox: a copy that has the same lines, fewer,
  // more, or the same count with other words (the agent's to write) is replaced.
  const kept = (await store.read('tsk_restore', SESSION)).lines;
  const rewrites = [
    `${kept[0]}\n`,
    `${kept.join('\n')}\n{"type":"user","uuid":"later"}\n`,
    `${kept.map((text) => text.replace('"type":"user"', '"type":"assistant"')).join('\n')}\n`,
  ];
  for (const text of rewrites) {
    await fs.writeFile(r.file, text);
    assert.equal((await restoreTranscript(input)).status, 'restored');
    assert.equal(await fs.readFile(r.file, 'utf8'), `${kept.join('\n')}\n`);
  }
  // Same count of lines, same lengths: only the words differ.
  await fs.writeFile(r.file, `${kept.join('\n').replaceAll('"n":', '"m":')}\n`);
  assert.equal((await restoreTranscript(input)).status, 'restored');
  assert.equal(await fs.readFile(r.file, 'utf8'), `${kept.join('\n')}\n`);

  // Nothing stored, or a session id that is not one: nothing is put on the sandbox.
  assert.deepEqual(await restoreTranscript({ ...input, sessionId: OTHER_SESSION }), {
    status: 'absent',
  });
  assert.deepEqual(await restoreTranscript({ ...input, sessionId: '../../x' }), {
    status: 'absent',
  });
  assert.deepEqual(await restoreTranscript({ ...input, taskId: 'tsk_other' }), {
    status: 'absent',
  });
});
