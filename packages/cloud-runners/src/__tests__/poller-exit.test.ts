import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

// A run that is still being polled when the server shuts down must not hold the process open.
test('a poller that is still watching a run does not keep the process alive', async () => {
  const poller = new URL('../poller.js', import.meta.url).href;
  const script = `
    import { MachinePoller } from ${JSON.stringify(poller)};
    const machine = { machineId: 'm', root: '/r', logRoot: '/l', execOk: async () => '' };
    const poller = new MachinePoller({ intervalMs: 50 });
    poller.watch(machine, { dir: 'd', run: 'r' }).next().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    console.log('polled', poller.pollCount > 0);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let out = '';
  child.stdout.on('data', (chunk) => {
    out += String(chunk);
  });
  const exit = await Promise.race([
    new Promise<number | null>((resolve) => child.once('exit', resolve)),
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 8000)),
  ]);
  if (exit === 'hung') child.kill('SIGKILL');
  assert.equal(exit, 0, 'the process did not exit by itself');
  assert.match(out, /polled true/u, 'the poller was polling');
});
