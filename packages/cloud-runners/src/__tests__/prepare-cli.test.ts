import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLAUDE_CLI, CODEX_CLI } from './fake-cli.js';
import type { CloudRunnersOptions } from '../fleet.js';
import { codexAdapter } from '../vendors.js';
import { collect, type Harness, setup, terminal } from './harness.js';

// The codex install says it started, waits until the test lets it go, and fails unless allowed.
const CODEX_INSTALL = `echo started >> "$HOME/codex-install-started"
echo $BASHPID >> "$HOME/codex-install-pids"
while [ ! -e "$HOME/codex-install-go" ]; do sleep 0.05; done
[ -f "$HOME/codex-install-ok" ] || { echo "registry unreachable"; exit 3; }
mkdir -p "$HOME/.maka-cli/bin"
cat > "$HOME/.maka-cli/bin/codex" <<'FAKE_CLI_EOF'
${CODEX_CLI}
FAKE_CLI_EOF
chmod +x "$HOME/.maka-cli/bin/codex"
echo installed >> "$HOME/codex-install-count"`;

async function exists(path: string): Promise<boolean> {
  return fs.stat(path).then(
    () => true,
    () => false,
  );
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function lines(path: string): Promise<number> {
  const text = await fs.readFile(path, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).length;
}

/** Whether a process is still running (a zombie is not). */
async function running(pid: number): Promise<boolean> {
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
  return stat !== '' && !/^\d+ \(.*\) [ZX] /su.test(stat);
}

async function installPids(h: Harness): Promise<number[]> {
  const text = await fs.readFile(join(h.home, 'codex-install-pids'), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map(Number);
}

/** Claude is installed; codex is not, and installs with `CODEX_INSTALL`. */
async function claudeOnly(
  t: { after(fn: () => Promise<void>): void },
  cloud: Partial<CloudRunnersOptions> = {},
): Promise<Harness> {
  const h = await setup({
    installClis: false,
    cloud: { installCommands: { codex: CODEX_INSTALL }, ...cloud },
  });
  t.after(async () => {
    // A held install would outlive the test: let it go before the files are removed.
    await fs.writeFile(join(h.home, 'codex-install-go'), '').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await h.cleanup();
  });
  const bin = join(h.home, '.maka-cli', 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(join(bin, 'claude'), CLAUDE_CLI, { mode: 0o755 });
  await fs.mkdir(join(h.root, '.setup'), { recursive: true });
  await fs.writeFile(join(h.root, '.setup', 'claude-9.9.9.ok'), '');
  return h;
}

/** Unhandled rejections seen while the test runs. */
function watchRejections(t: { after(fn: () => void): void }): unknown[] {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => void seen.push(reason);
  process.on('unhandledRejection', listener);
  t.after(() => process.off('unhandledRejection', listener));
  return seen;
}

test('the reviewer CLI installs while the implementer works, and its failure shows only when it is needed', async (t) => {
  const rejections = watchRejections(t);
  const h = await claudeOnly(t);
  await h.setMode('wait');
  const work = collect(
    await h.runners.claude.start(await h.spec('tsk_prep_fail', { prepareRunners: ['codex'] })),
  );
  // The install starts while Claude is still working.
  await until(() => exists(join(h.home, 'fake-cli', 'waiting')), 'claude to be working');
  await until(() => exists(join(h.home, 'codex-install-started')), 'the codex install to start');

  // It fails while Claude works: the work goes on and finishes.
  await fs.writeFile(join(h.home, 'codex-install-go'), '');
  await until(
    async () => !(await exists(join(h.root, '.setup-codex'))),
    'the failed install to let go of its lock',
  );
  await fs.writeFile(join(h.home, 'fake-cli', 'go'), '');
  assert.equal(terminal(await work)?.type, 'finished');

  // The review is where the failure shows, as it did when the install only started there.
  await h.setMode('ok');
  const review = terminal(
    await collect(await h.runners.codex.start(await h.spec('tsk_prep_fail', { runner: 'codex' }))),
  );
  assert.equal(review?.type, 'failed');
  const reason = review?.type === 'failed' ? review.reason : '';
  assert.match(reason, /installing codex@9\.9\.9 in the sandbox failed/);
  assert.match(reason, /registry unreachable/);
  assert.equal(await lines(join(h.home, 'codex-install-started')), 2, 'the review tried again');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(rejections, []);
});

test('an install still going when the work ends does not hold the work, and the review shares it', async (t) => {
  const rejections = watchRejections(t);
  const h = await claudeOnly(t);
  const handle = await h.runners.claude.start(
    await h.spec('tsk_prep_share', { prepareRunners: ['codex'] }),
  );
  const work = await collect(handle);
  assert.equal(terminal(work)?.type, 'finished');
  // The coding playbook cancels every run once it is over: that is not a cancelled task.
  await handle.cancel();
  await until(() => exists(join(h.home, 'codex-install-started')), 'the codex install to start');
  assert.equal(await lines(join(h.home, 'codex-install-count')), 0, 'the install is still held');

  const review = h.runners.codex.start(await h.spec('tsk_prep_share', { runner: 'codex' }));
  await fs.writeFile(join(h.home, 'codex-install-ok'), '');
  await fs.writeFile(join(h.home, 'codex-install-go'), '');
  assert.equal(terminal(await collect(await review))?.type, 'finished');
  assert.equal(await lines(join(h.home, 'codex-install-started')), 1, 'one install, shared');
  assert.equal(await lines(join(h.home, 'codex-install-count')), 1);
  assert.deepEqual(rejections, []);
});

test('a run that names no later runner installs nothing else', async (t) => {
  const h = await claudeOnly(t);
  const work = await collect(await h.runners.claude.start(await h.spec('tsk_prep_none')));
  assert.equal(terminal(work)?.type, 'finished');
  assert.equal(await exists(join(h.home, 'codex-install-started')), false);
});

test('an install that runs out of time is killed, and what it left is not trusted', async (t) => {
  const rejections = watchRejections(t);
  // It writes a working CLI first, then hangs.
  const held = `mkdir -p "$HOME/.maka-cli/bin"
cat > "$HOME/.maka-cli/bin/codex" <<'FAKE_CLI_EOF'
${CODEX_CLI}
FAKE_CLI_EOF
chmod +x "$HOME/.maka-cli/bin/codex"
${CODEX_INSTALL}`;
  const h = await claudeOnly(t, { setupTimeoutMs: 1_000, installCommands: { codex: held } });
  // An earlier install of this version finished once; its CLI has gone since.
  const marker = join(h.root, '.setup', 'codex-9.9.9.ok');
  await fs.writeFile(marker, '');
  const failed = terminal(
    await collect(await h.runners.codex.start(await h.spec('tsk_inst_slow', { runner: 'codex' }))),
  );
  assert.equal(failed?.type, 'failed');
  const reason = failed?.type === 'failed' ? failed.reason : '';
  assert.match(reason, /installing codex@9\.9\.9 in the sandbox failed \(timed out\)/);
  const [pid] = await installPids(h);
  assert.ok(pid !== undefined);
  assert.equal(await running(pid), false, 'the install that timed out was killed');
  assert.equal(await exists(join(h.root, '.setup-codex')), false, 'its lock is gone');
  assert.equal(await exists(marker), false, 'the half-done install leaves no marker to trust');

  // The next run installs again rather than take the CLI the stopped install wrote.
  await fs.writeFile(join(h.home, 'codex-install-ok'), '');
  await fs.writeFile(join(h.home, 'codex-install-go'), '');
  const again = terminal(
    await collect(await h.runners.codex.start(await h.spec('tsk_inst_again', { runner: 'codex' }))),
  );
  assert.equal(again?.type, 'finished');
  assert.equal(await lines(join(h.home, 'codex-install-started')), 2);
  assert.equal(await lines(join(h.home, 'codex-install-count')), 1);
  assert.deepEqual(rejections, []);
});

test('the background install of a cancelled task is stopped, and a run that needs it then installs afresh', async (t) => {
  const rejections = watchRejections(t);
  const h = await claudeOnly(t);
  await h.setMode('wait');
  const handle = await h.runners.claude.start(
    await h.spec('tsk_prep_cancel', { prepareRunners: ['codex'] }),
  );
  const work = collect(handle);
  await until(() => exists(join(h.home, 'codex-install-started')), 'the codex install to start');
  const [first] = await installPids(h);
  assert.ok(first !== undefined);

  await handle.cancel();
  await work;
  // Started while the stop is under way: it waits for it, then installs again.
  await h.setMode('ok');
  const next = h.runners.codex.start(await h.spec('tsk_prep_next', { runner: 'codex' }));
  await until(
    async () => (await lines(join(h.home, 'codex-install-started'))) === 2,
    'a second install',
  );
  assert.equal(await running(first), false, 'the install nobody needs was killed');
  await fs.writeFile(join(h.home, 'codex-install-ok'), '');
  await fs.writeFile(join(h.home, 'codex-install-go'), '');
  assert.equal(terminal(await collect(await next))?.type, 'finished');
  assert.equal(await lines(join(h.home, 'codex-install-count')), 1);
  assert.deepEqual(rejections, []);
});

test('an install goes on while any caller still wants it, and stops when the last one lets go', async (t) => {
  const rejections = watchRejections(t);
  const h = await claudeOnly(t);
  const fleet = h.runners.fleet;
  const machine = fleet.machine(h.fake.machineId);
  const a = new AbortController();
  const b = new AbortController();
  const first = fleet.ensureCli(machine, codexAdapter, a.signal);
  const second = fleet.ensureCli(machine, codexAdapter, b.signal);
  await until(() => exists(join(h.home, 'codex-install-started')), 'the codex install to start');
  const [pid] = await installPids(h);
  assert.ok(pid !== undefined);

  a.abort(new Error('the first caller let go'));
  await assert.rejects(first, /the first caller let go/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await running(pid), true, 'the second caller still wants it');

  b.abort(new Error('the second caller let go'));
  await assert.rejects(second, /the second caller let go/);
  await until(async () => !(await running(pid)), 'the install to be killed');
  await until(async () => !(await exists(join(h.root, '.setup-codex'))), 'its lock to go');

  // A caller without a signal always wants it: it shares the next install to its end.
  const third = fleet.ensureCli(machine, codexAdapter);
  const c = new AbortController();
  const fourth = fleet.ensureCli(machine, codexAdapter, c.signal);
  c.abort(new Error('the fourth caller let go'));
  await assert.rejects(fourth, /the fourth caller let go/);
  await fs.writeFile(join(h.home, 'codex-install-ok'), '');
  await fs.writeFile(join(h.home, 'codex-install-go'), '');
  await third;
  assert.equal(await lines(join(h.home, 'codex-install-started')), 2);
  assert.equal(await lines(join(h.home, 'codex-install-count')), 1);
  assert.deepEqual(rejections, []);
});
