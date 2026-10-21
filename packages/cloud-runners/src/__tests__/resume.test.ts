import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FixedMachineProvider } from '../providers.js';
import type { SandboxLease } from '../types.js';
import { collect, notes, setup, terminal } from './harness.js';

test('resume continues the recorded vendor session with the new prompt', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const spec = await h.spec('tsk_resume');
  assert.equal(terminal(await collect(await h.runners.claude.start(spec)))?.type, 'finished');

  const events = await collect(
    await h.runners.claude.resume('tsk_resume', { prompt: 'Also add the tests.', spec }),
  );
  assert.equal(terminal(events)?.type, 'finished');
  const { argv } = await h.cliCall('claude', 2);
  assert.equal(argv[argv.indexOf('--resume') + 1], 'sess-1');
  const prompt = argv[argv.indexOf('-p') + 1] ?? '';
  assert.ok(prompt.startsWith('Also add the tests.'));
  assert.match(
    prompt,
    /write \S+\/tsk_resume\/result\.json as a JSON object/,
    'a resumed turn is told to write the result',
  );
  const record = await h.sessions.get('tsk_resume');
  assert.equal(record?.turns, 2);
  assert.equal(record?.snapshotIds.length, 2);
});

test('codex resumes with exec resume <thread>', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const spec = await h.spec('tsk_cresume', { runner: 'codex' });
  await collect(await h.runners.codex.start(spec));
  const events = await collect(
    await h.runners.codex.resume('tsk_cresume', { prompt: 'Continue.', spec }),
  );
  assert.equal(terminal(events)?.type, 'finished');
  const { argv } = await h.cliCall('codex', 2);
  assert.deepEqual(argv.slice(0, 3), ['exec', 'resume', 'thr-1']);
});

test('resuming a task that has no recorded session fails clearly', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const spec = await h.spec('tsk_nothing');
  const events = await collect(await h.runners.claude.resume('tsk_nothing', { prompt: 'x', spec }));
  const last = terminal(events);
  assert.equal(last?.type, 'failed');
  assert.match(last?.type === 'failed' ? last.reason : '', /nothing to resume/);
  assert.equal(h.runners.fleet.openRuns, 0);
});

test('a resume with a mismatched task id is rejected up front', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  await assert.rejects(
    h.runners.claude.resume('tsk_a', { prompt: 'x', spec: await h.spec('tsk_b') }),
    /does not match/,
  );
});

test('when the machine is gone, resume restores one from the last snapshot', async (t) => {
  const restored: { tenantId: string; snapshotId: string }[] = [];
  const h = await setup({
    cloud: {
      sandboxes: new (class extends FixedMachineProvider {
        async restoreFromSnapshot(input: {
          tenantId: string;
          taskId: string;
          snapshotId: string;
        }): Promise<SandboxLease> {
          restored.push({ tenantId: input.tenantId, snapshotId: input.snapshotId });
          // Stand-in for creating a machine from the snapshot: the fake has one machine, bring it back.
          h.fake.machineState = 'running';
          return { machineId: h.fake.machineId, release: () => undefined };
        }
      })('m_aaaaaaaaaaaaaaaaaaaaaaaaaa'),
    },
  });
  t.after(() => h.cleanup());
  const spec = await h.spec('tsk_gone');
  await collect(await h.runners.claude.start(spec));
  const lastSnapshot = (await h.sessions.get('tsk_gone'))?.snapshotIds.at(-1);
  assert.ok(lastSnapshot);

  h.fake.machineState = 'deleted';
  const events = await collect(
    await h.runners.claude.resume('tsk_gone', { prompt: 'again', spec }),
  );
  assert.equal(terminal(events)?.type, 'finished', JSON.stringify(notes(events)));
  assert.deepEqual(restored, [{ tenantId: 'default', snapshotId: lastSnapshot }]);
});

test('when the machine is gone and nothing can restore it, resume fails without a guess', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const spec = await h.spec('tsk_lost');
  await collect(await h.runners.claude.start(spec));
  h.fake.machineState = 'deleted';
  const events = await collect(
    await h.runners.claude.resume('tsk_lost', { prompt: 'again', spec }),
  );
  const last = terminal(events);
  assert.equal(last?.type, 'failed');
  assert.match(last?.type === 'failed' ? last.reason : '', /cannot resume: the sandbox is gone/);
  assert.equal(h.runners.fleet.openRuns, 0);
});

test('a task handed to the other vendor starts a new run instead of reusing the first run name', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const spec = await h.spec('tsk_handoff');
  assert.equal(terminal(await collect(await h.runners.claude.start(spec)))?.type, 'finished');

  const events = await collect(await h.runners.codex.start({ ...spec, runner: 'codex' }));
  assert.equal(terminal(events)?.type, 'finished');
  assert.equal(await h.cliCalls('codex'), 1, 'the codex CLI ran');
  const record = await h.sessions.get('tsk_handoff');
  assert.equal(record?.runner, 'codex');
  assert.equal(record?.turns, 2);
  assert.equal(record?.sessionId, 'thr-1');
});

test('recover continues the recorded session with the recovery note, and an unrecorded task fails the same way as resume', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const spec = await h.spec('tsk_recover');
  assert.equal(terminal(await collect(await h.runners.claude.start(spec)))?.type, 'finished');

  const note = 'The server running this task restarted (resume 1 in a row).\n- push: "git push"';
  const events = await collect(
    await h.runners.claude.recover({ ...spec, recovery: { epoch: 2, resumes: 1, note } }),
  );
  assert.equal(terminal(events)?.type, 'finished');
  const { argv } = await h.cliCall('claude', 2);
  assert.equal(argv[argv.indexOf('--resume') + 1], 'sess-1');
  const prompt = argv[argv.indexOf('-p') + 1] ?? '';
  assert.ok(prompt.startsWith(note));
  assert.match(prompt, /write \S+\/tsk_recover\/result\.json as a JSON object/);

  const none = await h.spec('tsk_unrecorded');
  const failed = terminal(
    await collect(
      await h.runners.claude.recover({ ...none, recovery: { epoch: 2, resumes: 1, note } }),
    ),
  );
  assert.equal(failed?.type, 'failed');
  assert.match(failed?.type === 'failed' ? failed.reason : '', /nothing to resume/);
});

test('a restart stops the leftover run by task id first and the recovered run still starts', async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const spec = await h.spec('tsk_restart');
  assert.equal(terminal(await collect(await h.runners.claude.start(spec)))?.type, 'finished');

  // What the orchestrator does at restart: stop whatever the earlier attempt left, then recover.
  await h.runners.claude.stopOrphaned('tsk_restart');
  const events = await collect(
    await h.runners.claude.recover({
      ...spec,
      recovery: { epoch: 2, resumes: 1, note: 'The server restarted.' },
    }),
  );
  assert.equal(terminal(events)?.type, 'finished', JSON.stringify(notes(events)));
  assert.equal(h.runners.fleet.openRuns, 0);
});
