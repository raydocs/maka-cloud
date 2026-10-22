import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyCodingManifest } from '../playbook.js';
import { BASE_RESTORE_SCRIPT, BASE_REVERT_SCRIPT, BASE_STAGE_SCRIPT } from '../scripts.js';
import {
  type AgentScript,
  BUGGY_ADD,
  collect,
  FIXED_ADD,
  fixes,
  readJson,
  reviewsNothing,
  setup,
  terminal,
  testOnly,
  writeRepro,
  zeroStats,
} from './harness.js';

test('a change that passes the checks on the first run is delivered with a runner-written manifest', async (t) => {
  const h = await setup(t);
  h.claude.script = fixes;
  const spec = await h.spec('tsk_first');
  const events = await collect(await h.runner.start(spec));
  assert.deepEqual(terminal(events), { type: 'finished' });
  zeroStats(h.runner);
  assert.deepEqual(h.leases, { acquired: 1, released: 1 });

  const manifest = await readJson(spec.resultPath);
  assert.deepEqual(verifyCodingManifest(manifest), { ok: true, problems: [] });
  assert.match(
    manifest.done[0],
    /^verified: `bash tests\/run.sh` passed; the reproduction test `bash tests\/test_add.sh` failed on base [0-9a-f]{12} and passes/,
  );

  const delivery = await h.deliveries.get('tsk_first');
  assert.equal(delivery?.repo, 'acme/calc');
  assert.equal(delivery?.baseRef, 'main');
  assert.equal(delivery?.baseSha, h.baseSha);
  const changes = await readJson(join(h.handoff, 'tsk_first', 'changes.json'));
  assert.deepEqual(
    changes.files.map((file: { path: string; status: string }) => [file.path, file.status]),
    [
      ['lib/add.sh', 'modified'],
      ['tests/test_add.sh', 'added'],
    ],
  );
  const added = changes.files[0];
  assert.equal(Buffer.from(added.contentBase64, 'base64').toString(), FIXED_ADD);
  const patch = await fs.readFile(join(h.handoff, 'tsk_first', 'change.patch'), 'utf8');
  assert.match(patch, /^\+add\(\) \{ echo \$\(\( \$1 \+ \$2 \)\); \}$/mu);

  assert.equal(h.claude.turns.length, 1);
  assert.equal(h.codex.turns.length, 1, 'the other vendor reviewed it');
  const brief = await fs.readFile(h.claude.turns[0]!.spec.briefPath, 'utf8');
  assert.match(brief, new RegExp(`checked out at commit \`${h.baseSha}\``));
  assert.match(brief, /repro\.json/);
  assert.match(brief, /Never look for, fetch or use hidden or held-out tests/);
});

test('a failed check resumes the same vendor with the failure, and a fixed change is delivered', async (t) => {
  const h = await setup(t);
  h.claude.script = async (turn) => (turn.n === 1 ? testOnly(turn) : fixes(turn));
  const spec = await h.spec('tsk_repair');
  assert.deepEqual(terminal(await collect(await h.runner.start(spec))), { type: 'finished' });
  assert.deepEqual(
    h.claude.turns.map((turn) => turn.kind),
    ['start', 'resume'],
  );
  assert.match(
    h.claude.turns[1]!.prompt ?? '',
    /the reproduction test `bash tests\/test_add.sh` fails with your change \(exit 1\)/,
  );
  assert.equal(h.codex.turns.length, 1, 'and the other vendor reviews the repaired change');
  const verification = await readJson(join(h.handoff, 'tsk_repair', 'verification.json'));
  assert.deepEqual(
    verification.attempts[0].turns.map((turn: { outcome: string }) => turn.outcome),
    ['check_failed', 'verified'],
  );
  zeroStats(h.runner);
});

test('a reproduction test that passes without the change is rejected, and the change is put back after the base check', async (t) => {
  const h = await setup(t);
  h.claude.script = async (turn) => {
    if (turn.n === 1) {
      // Fixes the code, but the "reproduction" test passes on the base commit too.
      await writeRepro(turn, 'source lib/add.sh\n[ "$(add 2 0)" = 2 ]\n');
      await fs.writeFile(join(turn.workspace, 'lib', 'add.sh'), FIXED_ADD);
      return 'ok';
    }
    // The fix must still be there after the base check of turn 1.
    assert.equal(await fs.readFile(join(turn.workspace, 'lib', 'add.sh'), 'utf8'), FIXED_ADD);
    await writeRepro(turn);
    return 'ok';
  };
  const spec = await h.spec('tsk_notrepro');
  assert.deepEqual(terminal(await collect(await h.runner.start(spec))), { type: 'finished' });
  assert.match(
    h.claude.turns[1]!.prompt ?? '',
    /also passes with your changes outside its files reverted, so it does not reproduce the problem/,
  );
  const verification = await readJson(join(h.handoff, 'tsk_notrepro', 'verification.json'));
  const first = verification.attempts[0].turns[0];
  assert.equal(first.outcome, 'check_failed');
  assert.deepEqual(
    first.checks.map((check: { name: string; exitCode: number }) => [check.name, check.exitCode]),
    [
      ['repro', 0],
      ['tests', 0],
      ['repro-base', 0],
    ],
  );
  assert.deepEqual(
    await fs.readdir(join(h.root, 'tsk_notrepro', 'base-check')),
    [],
    'the backup is emptied',
  );
  zeroStats(h.runner);
});

test('the base check edits the workspace as the agent account, and the sandbox user only stages', async (t) => {
  const h = await setup(t);
  h.claude.script = async (turn) => {
    if (turn.n === 1) {
      await writeRepro(turn, 'source lib/add.sh\n[ "$(add 2 0)" = 2 ]\n');
      await fs.writeFile(join(turn.workspace, 'lib', 'add.sh'), FIXED_ADD);
      return 'ok';
    }
    await writeRepro(turn);
    return 'ok';
  };
  const spec = await h.spec('tsk_base_acct');
  assert.deepEqual(terminal(await collect(await h.runner.start(spec))), { type: 'finished' });
  const via = (script: string) =>
    h.calls.filter((call) => call.script === script).map((call) => call.via);
  // The revert and the restore write in the workspace: only ever as the agent's account.
  assert.deepEqual(new Set(via(BASE_REVERT_SCRIPT)), new Set(['execCheck']));
  assert.deepEqual(new Set(via(BASE_RESTORE_SCRIPT)), new Set(['execCheck']));
  assert.ok(via(BASE_REVERT_SCRIPT).length >= 1);
  assert.ok(via(BASE_RESTORE_SCRIPT).length >= 2, 'a leftover is put back first, the change after');
  // The stage runs as the sandbox user, in front of the revert.
  assert.deepEqual(new Set(via(BASE_STAGE_SCRIPT)), new Set(['exec']));
  const order = h.calls
    .map((call) =>
      call.script === BASE_RESTORE_SCRIPT
        ? 'restore'
        : call.script === BASE_STAGE_SCRIPT
          ? 'stage'
          : call.script === BASE_REVERT_SCRIPT
            ? 'revert'
            : '',
    )
    .filter(Boolean)
    .join(' ');
  assert.match(order, /^restore stage revert restore/u);
  // Each of them ran as the agent's account (one sudo run per call).
  const users = await h.sudoUsers();
  assert.ok(users.length >= via(BASE_REVERT_SCRIPT).length + via(BASE_RESTORE_SCRIPT).length);
  assert.ok(users.every((user) => user === 'maka-agent'));
  zeroStats(h.runner);
});

test('after two failures the task goes to the other vendor once, from the base commit, with a failure brief', async (t) => {
  const h = await setup(t);
  // Its third run is the review of the other vendor's change.
  h.claude.script = (turn) => (turn.n <= 2 ? testOnly(turn) : reviewsNothing(turn));
  let seen:
    | { add: string; testExists: boolean; brief: string; failure: any; reproLeft: boolean }
    | undefined;
  h.codex.script = async (turn) => {
    seen = {
      add: await fs.readFile(join(turn.workspace, 'lib', 'add.sh'), 'utf8'),
      testExists: await fs.stat(join(turn.workspace, 'tests', 'test_add.sh')).then(
        () => true,
        () => false,
      ),
      brief: await fs.readFile(turn.spec.briefPath, 'utf8'),
      failure: JSON.parse(
        await fs.readFile(join(turn.dir, 'handoff', 'failure_brief.json'), 'utf8'),
      ),
      reproLeft: await fs.stat(join(turn.dir, 'handoff', 'repro.json')).then(
        () => true,
        () => false,
      ),
    };
    return fixes(turn);
  };
  const spec = await h.spec('tsk_handoff');
  assert.deepEqual(terminal(await collect(await h.runner.start(spec))), { type: 'finished' });

  assert.deepEqual(
    h.claude.turns.map((turn) => turn.kind),
    ['start', 'resume', 'start'],
    'two failed runs, then the review of the other vendor',
  );
  assert.deepEqual(
    h.codex.turns.map((turn) => turn.kind),
    ['start'],
    'the other vendor starts once',
  );
  assert.ok(seen);
  assert.equal(seen.add, BUGGY_ADD, 'the workspace is back at the base commit');
  assert.equal(seen.testExists, false);
  assert.equal(seen.reproLeft, false, "the first agent's repro.json is gone");
  assert.match(
    seen.brief,
    /Another agent \(claude-agent-sdk\) tried this task and it was taken from it: 2 failed runs/,
  );
  assert.equal(seen.failure.vendor, 'claude-agent-sdk');
  assert.equal(seen.failure.reason, '2 failed runs');
  assert.equal(seen.failure.baseSha, h.baseSha);
  assert.equal(seen.failure.runs.length, 2);
  assert.match(seen.failure.runs[0].outcome, /fails with your change/);
  const attemptPatch = await fs.readFile(
    join(h.root, 'tsk_handoff', 'handoff', 'attempt-1.patch'),
    'utf8',
  );
  assert.match(attemptPatch, /tests\/test_add.sh/);
  assert.match(
    seen.brief,
    /handoff\/failure_brief\.json/,
    'the brief points where the agent can read',
  );

  const manifest = await readJson(spec.resultPath);
  assert.ok(
    manifest.done.includes('claude-agent-sdk failed (2 failed runs); codex made the change'),
  );
  assert.deepEqual(verifyCodingManifest(manifest), { ok: true, problems: [] });
  zeroStats(h.runner);
});

test('when both vendors fail, the task finishes with an honest manifest and never starts a third attempt', async (t) => {
  const h = await setup(t);
  h.claude.script = testOnly;
  h.codex.script = async () => ({ failed: 'the CLI crashed' });
  const spec = await h.spec('tsk_giveup');
  assert.deepEqual(terminal(await collect(await h.runner.start(spec))), { type: 'finished' });
  assert.equal(h.claude.turns.length, 2);
  assert.deepEqual(
    h.codex.turns.map((turn) => turn.kind),
    ['start', 'resume'],
  );
  const manifest = await readJson(spec.resultPath);
  assert.equal(manifest.confidence, 'low');
  assert.deepEqual(manifest.notDone, ['add() subtracts; make it add.']);
  assert.deepEqual(manifest.artifacts, ['failure_brief.json', 'verification.json']);
  assert.equal(verifyCodingManifest(manifest).ok, false);
  assert.equal(await h.deliveries.get('tsk_giveup'), undefined, 'nothing to deliver');
  zeroStats(h.runner);
});

test('a key in a check’s output is scrubbed before the sandbox’s cut, in the failure brief and the verification record', async (t) => {
  const key = 'ghp_0123456789abcdef0123456789abcdef0123';
  // One key is cut in two by the old 200-byte tail, one lies whole inside it.
  const leak = [
    `echo A=${key}`,
    `echo ${'b'.repeat(115)}`,
    `echo B=${key}`,
    'echo END',
    'exit 1',
  ].join('\n');
  const h = await setup(t, { limits: { outputTailBytes: 200 } });
  const leaks: AgentScript = async (turn) => {
    await writeRepro(turn, `${leak}\n`);
    return 'ok';
  };
  h.claude.script = leaks;
  h.codex.script = leaks;
  const spec = await h.spec('tsk_leak');
  assert.deepEqual(terminal(await collect(await h.runner.start(spec))), { type: 'finished' });
  const dir = join(h.handoff, 'tsk_leak');
  const brief = await fs.readFile(join(dir, 'failure_brief.json'), 'utf8');
  const record = await fs.readFile(join(dir, 'verification.json'), 'utf8');
  assert.match(brief, /END/, 'the check output is in the brief');
  for (const text of [brief, record]) {
    assert.doesNotMatch(text, /ghp_|0123456789abcdef/);
  }
  zeroStats(h.runner);
});

test('many redacted keys in a cut check output do not pull the cut fragment of a key into the record', async (t) => {
  const key = 'ghp_0123456789abcdef0123456789abcdef0123';
  // Each redaction shortens the scrubbed text by 32 characters: twenty of them would walk the old
  // character count back over the whole margin and keep the line the sandbox's cut split.
  const leak = [...Array.from({ length: 20 }, () => `echo T=${key}`), 'echo END', 'exit 1'].join(
    '\n',
  );
  const h = await setup(t, { limits: { outputTailBytes: 205 } });
  const leaks: AgentScript = async (turn) => {
    await writeRepro(turn, `${leak}\n`);
    return 'ok';
  };
  h.claude.script = leaks;
  h.codex.script = leaks;
  const spec = await h.spec('tsk_many');
  assert.deepEqual(terminal(await collect(await h.runner.start(spec))), { type: 'finished' });
  const dir = join(h.handoff, 'tsk_many');
  for (const name of ['failure_brief.json', 'verification.json']) {
    assert.doesNotMatch(
      await fs.readFile(join(dir, name), 'utf8'),
      /ghp_|0123456789abcdef|def0123/,
    );
  }
  zeroStats(h.runner);
});

test('a key the agent put in its reproduction command or a file name is scrubbed from verification.json', async (t) => {
  const key = 'ghp_0123456789abcdef0123456789abcdef0123';
  const h = await setup(t);
  h.claude.script = async (turn) => {
    await fixes(turn);
    await fs.writeFile(join(turn.workspace, 'tests', `notes-${key}.txt`), 'x');
    await fs.writeFile(
      join(turn.dir, 'handoff', 'repro.json'),
      JSON.stringify({
        command: `bash tests/test_add.sh # ${key}`,
        files: ['tests/test_add.sh', `tests/notes-${key}.txt`],
      }),
    );
    return 'ok';
  };
  h.codex.script = reviewsNothing;
  const spec = await h.spec('tsk_keyname');
  assert.deepEqual(terminal(await collect(await h.runner.start(spec))), { type: 'finished' });
  const dir = join(h.handoff, 'tsk_keyname');
  const record = await fs.readFile(join(dir, 'verification.json'), 'utf8');
  assert.doesNotMatch(record, /ghp_|0123456789abcdef/);
  assert.match(record, /tests\/test_add\.sh/, 'the rest of the command is kept');
  zeroStats(h.runner);
});

test('a brief without a valid coding-task block fails before anything is acquired', async (t) => {
  const h = await setup(t);
  const spec = await h.spec('tsk_badbrief', { repo: 'not a repo' });
  const last = terminal(await collect(await h.runner.start(spec)));
  assert.equal(last?.type, 'failed');
  assert.match(last?.type === 'failed' ? last.reason : '', /repo: repo must be "owner\/name"/);
  assert.deepEqual(h.leases, { acquired: 0, released: 0 });
  zeroStats(h.runner);
});

test('a repository that cannot be fetched fails the task and releases the sandbox', async (t) => {
  const h = await setup(t, { repoUrl: () => 'file:///nonexistent/repo.git' });
  const last = terminal(await collect(await h.runner.start(await h.spec('tsk_nofetch'))));
  assert.equal(last?.type, 'failed');
  assert.match(
    last?.type === 'failed' ? last.reason : '',
    /could not fetch acme\/calc at main.*only public repositories/s,
  );
  assert.deepEqual(h.leases, { acquired: 1, released: 1 });
  zeroStats(h.runner);
});

test('ignored files stay out of the delivery; symlinks are refused and count as a failed check', async (t) => {
  const h = await setup(t);
  h.claude.script = async (turn) => {
    await fixes(turn);
    await fs.mkdir(join(turn.workspace, 'build'), { recursive: true });
    await fs.writeFile(join(turn.workspace, 'build', 'out.txt'), 'generated');
    if (turn.n === 1) await fs.symlink('/etc/passwd', join(turn.workspace, 'leak'));
    else await fs.rm(join(turn.workspace, 'leak'));
    return 'ok';
  };
  const spec = await h.spec('tsk_files');
  assert.deepEqual(terminal(await collect(await h.runner.start(spec))), { type: 'finished' });
  assert.match(h.claude.turns[1]!.prompt ?? '', /leak is a symlink; symlinks are not delivered/);
  const changes = await readJson(join(h.handoff, 'tsk_files', 'changes.json'));
  assert.deepEqual(
    changes.files.map((file: { path: string }) => file.path),
    ['lib/add.sh', 'tests/test_add.sh'],
  );
});

test('a file larger than the limit is not delivered', async (t) => {
  const h = await setup(t, { limits: { maxFileBytes: 10 } });
  h.claude.script = fixes;
  h.codex.script = fixes;
  const spec = await h.spec('tsk_big');
  assert.deepEqual(terminal(await collect(await h.runner.start(spec))), { type: 'finished' });
  const verification = await readJson(join(h.handoff, 'tsk_big', 'verification.json'));
  assert.match(verification.attempts[0].turns[0].detail, /lib\/add.sh is 31 bytes, more than 10/);
  assert.equal(verification.result, 'failed');
});

test('a check that runs past its timeout is stopped and counts as a failure', async (t) => {
  const h = await setup(t, { limits: { checkTimeoutMs: 1_000 } });
  h.claude.script = async (turn) => {
    await fixes(turn);
    // The repository's tests hang.
    await fs.writeFile(
      join(turn.workspace, 'tests', 'test_hang.sh'),
      'while :; do sleep 0.05; done\n',
    );
    return 'ok';
  };
  h.codex.script = async () => ({ failed: 'gave up' });
  const spec = await h.spec('tsk_timeout');
  assert.deepEqual(terminal(await collect(await h.runner.start(spec))), { type: 'finished' });
  const verification = await readJson(join(h.handoff, 'tsk_timeout', 'verification.json'));
  const tests = verification.attempts[0].turns[0].checks.find(
    (check: { name: string }) => check.name === 'tests',
  );
  assert.equal(tests.exitCode, 124);
  zeroStats(h.runner);
});

test('a repro.json at the task directory is not read: the agent can only write handoff/', async (t) => {
  const h = await setup(t);
  // The task directory is closed to the agent's account, so a record there can only be a stale or
  // planted one; the one in handoff/ is the agent's.
  const misplaced: AgentScript = async (turn) => {
    const result = await fixes(turn);
    await fs.rename(join(turn.dir, 'handoff', 'repro.json'), join(turn.dir, 'repro.json'));
    return result;
  };
  h.claude.script = misplaced;
  h.codex.script = misplaced;
  const events = await collect(await h.runner.start(await h.spec('tsk_oldrepro')));
  assert.ok(terminal(events), 'the task ends');
  assert.equal(await h.deliveries.get('tsk_oldrepro'), undefined);
  zeroStats(h.runner);
});
