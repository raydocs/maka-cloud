import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLAUDE_CLI, CODEX_CLI } from './fake-cli.js';
import { collect, type Harness, setup, terminal } from './harness.js';

// The codex install says it started, waits until the test lets it go, and fails unless allowed.
const CODEX_INSTALL = `echo started >> "$HOME/codex-install-started"
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

/** Claude is installed; codex is not, and installs with `CODEX_INSTALL`. */
async function claudeOnly(t: { after(fn: () => Promise<void>): void }): Promise<Harness> {
  const h = await setup({
    installClis: false,
    cloud: { installCommands: { codex: CODEX_INSTALL } },
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
  const work = await collect(
    await h.runners.claude.start(await h.spec('tsk_prep_share', { prepareRunners: ['codex'] })),
  );
  assert.equal(terminal(work)?.type, 'finished');
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
