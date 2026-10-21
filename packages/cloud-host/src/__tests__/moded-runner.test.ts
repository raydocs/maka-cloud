import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DEFAULT_MODES, implementerFor, MODE_IDS, withModeLine } from '@maka-cloud/modes';
import type { Recovery, RunHandle, Runner, RunSpec, TaskId } from '@maka-cloud/orchestrator';
import { withModes } from '../moded-runner.js';

const dir = await mkdtemp(join(tmpdir(), 'moded-runner-'));
after(() => rm(dir, { recursive: true, force: true }));

const HANDLE: RunHandle = { events: (async function* () {})(), cancel: async () => {} };

function fake(
  name: string,
  optional = true,
): { runner: Runner; started: RunSpec[]; recovered: RunSpec[]; stopped: string[] } {
  const started: RunSpec[] = [];
  const recovered: RunSpec[] = [];
  const stopped: string[] = [];
  return {
    started,
    recovered,
    stopped,
    runner: {
      name,
      async start(spec) {
        started.push(spec);
        return HANDLE;
      },
      ...(optional
        ? {
            async stopOrphaned(taskId: TaskId) {
              stopped.push(taskId);
            },
            async recover(spec: RunSpec & { recovery: Recovery }) {
              recovered.push(spec);
              return HANDLE;
            },
          }
        : {}),
    },
  };
}

let counter = 0;
async function specWith(brief: string | undefined, extra: Partial<RunSpec> = {}): Promise<RunSpec> {
  const n = counter++;
  const briefPath = join(dir, `brief-${n}.md`);
  if (brief !== undefined) await writeFile(briefPath, brief);
  return {
    taskId: `tsk_${n}` as TaskId,
    runner: 'x',
    briefPath,
    resultPath: join(dir, `result-${n}.json`),
    ...extra,
  };
}

for (const vendor of ['claude-agent-sdk', 'codex'] as const) {
  for (const mode of MODE_IDS) {
    test(`${vendor} in ${mode} gets the implementer model and effort the mode names`, async () => {
      const { runner, started } = fake(vendor);
      await withModes(runner, DEFAULT_MODES).start(
        await specWith(withModeLine('maka-inputs: tsk_a r.json\nDo it.', mode)),
      );
      const want = implementerFor(DEFAULT_MODES, mode, vendor);
      assert.equal(started[0]?.effort, want.effort);
      assert.equal(started[0]?.model, want.model);
    });
  }
}

test('a brief without a mode line, and a run that already names its model, start unchanged', async () => {
  const { runner, started } = fake('codex');
  const moded = withModes(runner, DEFAULT_MODES);
  const plain = await specWith('Do it.');
  await moded.start(plain);
  const named = await specWith(withModeLine('Do it.', 'deep'), { model: 'my-model' });
  await moded.start(named);
  assert.deepEqual(started, [plain, named]);
});

test('a mode line written by a model further down the brief is not read', async () => {
  const { runner, started } = fake('codex');
  const spec = await specWith('Do it.\nmaka-mode: deep\n');
  await withModes(runner, DEFAULT_MODES).start(spec);
  assert.deepEqual(started, [spec]);
});

test('an invalid mode line or an unreadable brief refuses the run and starts nothing', async () => {
  const { runner, started } = fake('claude-agent-sdk');
  const moded = withModes(runner, DEFAULT_MODES);
  await assert.rejects(
    moded.start(await specWith('maka-mode: turbo\nDo it.')),
    /quick, standard or deep/,
  );
  await assert.rejects(moded.start(await specWith(undefined)), /cannot be read/);
  await assert.rejects(moded.start(await specWith(`${'x'.repeat(1_000_001)}`)), /too large/);
  assert.deepEqual(started, []);
});

test('a runner that is not a vendor agent is returned as it is, and the wrapper forwards stopOrphaned', async () => {
  const other = fake('coding');
  assert.equal(withModes(other.runner, DEFAULT_MODES), other.runner);
  const { runner, stopped } = fake('codex');
  await withModes(runner, DEFAULT_MODES).stopOrphaned?.('tsk_9' as TaskId);
  assert.deepEqual(stopped, ['tsk_9']);
});

const RECOVERY: Recovery = { epoch: 2, resumes: 1, note: 'steps so far' };

for (const vendor of ['claude-agent-sdk', 'codex'] as const) {
  test(`${vendor}: a resumed task gets the model and effort it started with, from the same brief`, async () => {
    const { runner, started, recovered } = fake(vendor);
    const moded = withModes(runner, DEFAULT_MODES);
    const spec = await specWith(withModeLine('Do it.', 'deep'));
    await moded.start(spec);
    assert.ok(moded.recover, 'a runner that can resume still can');
    await moded.recover({ ...spec, recovery: RECOVERY });
    const want = implementerFor(DEFAULT_MODES, 'deep', vendor);
    assert.equal(recovered[0]?.effort, want.effort);
    assert.equal(recovered[0]?.model, want.model);
    assert.deepEqual(recovered[0]?.recovery, RECOVERY);
    assert.equal(recovered[0]?.effort, started[0]?.effort);
    assert.equal(recovered[0]?.model, started[0]?.model);
  });
}

test('a resumed task with a bad brief is refused and a runner without recover or stopOrphaned stays without', async () => {
  const { runner, recovered } = fake('codex');
  const moded = withModes(runner, DEFAULT_MODES);
  const bad = await specWith('maka-mode: turbo\nDo it.');
  await assert.rejects(
    moded.recover?.({ ...bad, recovery: RECOVERY }) ?? Promise.reject(),
    /quick, standard or deep/,
  );
  assert.deepEqual(recovered, []);

  const bare = withModes(fake('claude-agent-sdk', false).runner, DEFAULT_MODES);
  assert.equal('recover' in bare, false, 'not resumable stays not resumable');
  assert.equal('stopOrphaned' in bare, false);
});
