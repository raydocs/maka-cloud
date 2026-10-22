import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FakeInstaboxOptions } from './fake-instabox.js';
import { type Harness, setup } from './harness.js';

/** What the stand-in's `sudo` does with a command, with a recording `sudo` as the real one behind it. */
describe('the sandbox stand-in sudo', () => {
  let h: Harness;
  let real: string;

  beforeEach(async () => {
    real = await fs.mkdtemp(join(tmpdir(), 'real-sudo-'));
    await fs.writeFile(join(real, 'sudo'), '#!/bin/bash\necho "real sudo: $*"\n', { mode: 0o755 });
  });
  afterEach(async () => {
    await h.cleanup();
    await fs.rm(real, { recursive: true, force: true });
  });

  const make = async (options: FakeInstaboxOptions = {}) => {
    h = await setup({ execPath: `${real}:${process.env.PATH ?? ''}`, ...options });
  };
  const run = async (cmd: string) => (await h.client.exec(h.fake.machineId, { cmd })).stdout;

  it('runs a command as the sandbox user, and a change of account by the real sudo, by default', async () => {
    await make();
    assert.equal((await run('sudo -n echo hello')).trim(), 'hello');
    assert.match(await run('sudo -n -u agent id'), /^real sudo: -n -u agent id/u);
  });

  it('with rootSudo leaves only the firewall tools to the stand-in and hands the rest to the real sudo', async () => {
    await make({ rootSudo: true });
    assert.match(await run('sudo -n kill 1234'), /^real sudo: -n kill 1234/u);
    assert.match(await run('sudo -n env A=1 bash -c true'), /^real sudo: -n env A=1 bash -c true/u);
    assert.match(await run('sudo -n -u agent id'), /^real sudo: -n -u agent id/u);
    const listed = await run('sudo -n iptables -w -S');
    assert.doesNotMatch(listed, /real sudo/u);
    assert.deepEqual(h.fake.firewall.calls().at(-1), 'iptables -w -S');
    await run('sudo -n ip6tables -w -S');
    assert.deepEqual(h.fake.firewall.calls().at(-1), 'ip6tables -w -S');
  });
});
