import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { collect, notes, setup, terminal } from './harness.js';

function reasonOf(events: Parameters<typeof terminal>[0]): string {
  const last = terminal(events);
  assert.equal(last?.type, 'failed');
  return last?.type === 'failed' ? last.reason : '';
}

test('a CLI that exits non-zero fails the task with its own error text', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('fail');
  const reason = reasonOf(await collect(await h.runners.claude.start(await h.spec('tsk_fail'))));
  assert.match(reason, /claude exited with code 1/);
  assert.match(reason, /model said no/);
  assert.equal(await h.sessions.get('tsk_fail').then((r) => r?.snapshotIds.length), 0);
});

test('codex reports a failed turn the same way', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('fail');
  const spec = await h.spec('tsk_cfail', { runner: 'codex' });
  const reason = reasonOf(await collect(await h.runners.codex.start(spec)));
  assert.match(reason, /codex exited with code 1/);
  assert.match(reason, /model said no/);
});

test('a missing result.json gets one repair turn in the same session, then fails', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('noresult');
  const events = await collect(await h.runners.claude.start(await h.spec('tsk_noresult')));
  assert.match(reasonOf(events), /invalid result: result\.json was not written/);
  assert.ok(notes(events).some((note) => note.includes('asking the agent to rewrite it')));
  assert.equal(await h.cliCalls('claude'), 2);
  const second = await h.cliCall('claude', 2);
  assert.equal(second.argv[second.argv.indexOf('--resume') + 1], 'sess-1');
  assert.ok(second.argv.some((arg) => arg.includes('Write it again')));
});

test('an invalid manifest is repaired by resuming the session once', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('badthengood');
  const spec = await h.spec('tsk_repair');
  const events = await collect(await h.runners.claude.start(spec));
  assert.equal(terminal(events)?.type, 'finished');
  assert.equal(await h.cliCalls('claude'), 2);
  const second = await h.cliCall('claude', 2);
  assert.ok(second.argv.includes('--resume'));
  assert.equal(JSON.parse(await fs.readFile(spec.resultPath, 'utf8')).summary, 'fake run complete');
  const record = await h.sessions.get('tsk_repair');
  assert.equal(record?.turns, 2);
  assert.equal(record?.snapshotIds.length, 2, 'a snapshot after each turn');
});

test('a result.json that is a symlink is refused and what it points at is never copied', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('symlink');
  const spec = await h.spec('tsk_symlink');
  const events = await collect(await h.runners.claude.start(spec));
  assert.match(reasonOf(events), /result\.json is a symlink/);
  await assert.rejects(fs.stat(spec.resultPath));
  for (const file of await fs.readdir(join(h.handoff, 'tsk_symlink'))) {
    const text = await fs.readFile(join(h.handoff, 'tsk_symlink', file), 'utf8');
    assert.ok(!text.includes('root-only secret'));
  }
  // The root-privileged file API was never used to read it.
  assert.equal(h.fake.requestsTo('GET', /\/files$/).length, 0);
});

test('a result.json over 1 MiB is refused', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await h.setMode('big');
  const spec = await h.spec('tsk_big');
  const reason = reasonOf(await collect(await h.runners.claude.start(spec)));
  assert.match(reason, /larger than 1048576 bytes/);
  await assert.rejects(fs.stat(spec.resultPath));
});

test('a result.json that is a fifo or directory is refused', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await machine.prepare('tsk_dir');
  await fs.mkdir(join(h.root, 'tsk_dir', 'result.json'));
  assert.deepEqual(await machine.readResult('tsk_dir'), {
    ok: false,
    reason: 'result.json is not a regular file',
  });
});

test('the result is written next to resultPath through a temp file and rename', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const base = await h.spec('tsk_atomic');
  const spec = { ...base, resultPath: join(h.handoff, 'tsk_atomic', 'deeper', 'result.json') };
  const events = await collect(await h.runners.claude.start(spec));
  assert.equal(terminal(events)?.type, 'finished');
  assert.deepEqual(await fs.readdir(join(h.handoff, 'tsk_atomic', 'deeper')), ['result.json']);
  assert.equal((await fs.stat(spec.resultPath)).mode & 0o777, 0o600);
});

test('a result copied back in several chunks arrives byte for byte', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const machine = h.runners.fleet.machine(h.fake.machineId);
  await machine.prepare('tsk_chunks');
  const payload = Buffer.alloc(700_000);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) % 256;
  await fs.writeFile(join(h.root, 'tsk_chunks', 'result.json'), payload);
  const read = await machine.readResult('tsk_chunks');
  assert.ok(read.ok);
  assert.ok(read.ok && read.bytes.equals(payload));
  await assert.rejects(fs.stat(join(h.root, 'tsk_chunks', 'result.read')));
});
