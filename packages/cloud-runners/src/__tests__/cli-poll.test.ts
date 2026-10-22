import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { collect, setup, terminal } from './harness.js';

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// The machine's own interval is slow (10 s here, 2 s by default); the CLI's run is watched with a
// backoff that starts at 150 ms and grows to 1 s, so its end is seen long before the next slow tick.
test('a CLI run that ends after a short quiet spell is noticed long before the slow machine poll', async (t) => {
  const h = await setup({ cloud: { pollIntervalMs: 10_000 } });
  t.after(() => h.cleanup());
  await h.setMode('wait');
  const handle = await h.runners.claude.start(await h.spec('tsk_poll_fast'));
  const events = collect(handle);
  const ctl = join(h.home, 'fake-cli');
  await until(
    () =>
      fs.stat(join(ctl, 'waiting')).then(
        () => true,
        () => false,
      ),
    'the CLI to wait',
  );
  // Quiet for a moment: the run is polled, nothing new comes.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const go = Date.now();
  await fs.writeFile(join(ctl, 'go'), '');
  assert.equal(terminal(await events)?.type, 'finished');
  const noticed = Date.now() - go;
  assert.ok(noticed < 4_000, `the end was noticed ${noticed} ms after the CLI was let go`);
});
