import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudRunnersOptions } from '../fleet.js';
import { loadAgentSdk } from '../sdk-turn.js';
import { SDK_CLI } from './fake-sdk-cli.js';
import { type Harness, setup } from './harness.js';

/**
 * A `sudo` that runs the command as the current user. The fake sandbox has one user, so the agent's
 * separate account is only a name here; `agent-user.test.ts` checks the real thing where a second
 * account exists.
 */
const SUDO_DOUBLE = `#!/bin/bash
while [ $# -gt 0 ]; do
  case "$1" in
    -n|--preserve-env|-H) shift ;;
    -u) shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
exec "$@"
`;

/** The real Agent SDK, driving a scripted stand-in for `claude` that runs in the fake sandbox. */
/** The options that turn a harness's runners to the SDK, with an agent account the box check is skipped for. */
export async function sdkCloudOptions(): Promise<Partial<CloudRunnersOptions>> {
  return {
    agentSdk: await loadAgentSdk(),
    agentSdkPollMs: { minMs: 5, maxMs: 20 },
    agentChannel: { user: 'maka-agent', group: execFileSync('id', ['-gn']).toString().trim() },
  };
}

export async function sdkSetup(
  t: { after(fn: () => Promise<void>): void },
  cloud: Partial<CloudRunnersOptions> = {},
): Promise<Harness> {
  const shim = await fs.mkdtemp(join(tmpdir(), 'sudo-double-'));
  t.after(() => fs.rm(shim, { recursive: true, force: true }));
  await fs.writeFile(join(shim, 'sudo'), SUDO_DOUBLE, { mode: 0o755 });
  const h = await setup({
    fake: { execPath: `${shim}:${process.env.PATH ?? ''}` },
    cloud: {
      ...(await sdkCloudOptions()),
      ...cloud,
    },
  });
  t.after(() => h.cleanup());
  // The box check needs a second account; it has its own tests.
  h.runners.fleet.ensureAgentIsolation = async () => undefined;
  await fs.writeFile(join(h.home, '.maka-cli', 'bin', 'claude'), SDK_CLI, { mode: 0o755 });
  return h;
}
