/**
 * Device-daemon CLI. Pairing code and cloud URL come from the environment
 * (never argv for secrets). The credential file holds the minted device
 * secret only — not the machine's keychain or SSH keys.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { arch, platform } from 'node:os';
import type { CloudToDevice, DeviceCapabilities, DeviceToCloud } from './byom-protocol.js';
import { DeviceDaemon } from './byom.js';
import { DEFAULT_COMMAND_POLICY } from './byom-policy.js';

export interface DeviceCliEnv {
  MAKA_CLOUD_BYOM_URL?: string;
  MAKA_CLOUD_BYOM_CODE?: string;
  MAKA_CLOUD_BYOM_STATE?: string;
  MAKA_CLOUD_BYOM_ROOT?: string;
  MAKA_CLOUD_BYOM_LABELS?: string;
  MAKA_CLOUD_BYOM_TOOLS?: string;
}

export class HttpDeviceTransport {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: DeviceToCloud): Promise<CloudToDevice> {
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(message),
    });
    const text = await response.text();
    if (!response.ok) {
      return { v: 1, type: 'error', reason: `http_${response.status}` };
    }
    return JSON.parse(text) as CloudToDevice;
  }
}

export function capabilitiesFromEnv(env: DeviceCliEnv = process.env): DeviceCapabilities {
  const labels = (env.MAKA_CLOUD_BYOM_LABELS ?? '')
    .split(',')
    .map((row) => row.trim())
    .filter(Boolean);
  const toolchains = (env.MAKA_CLOUD_BYOM_TOOLS ?? 'git,node,npm')
    .split(',')
    .map((row) => row.trim())
    .filter(Boolean);
  return {
    os: platform(),
    arch: arch(),
    toolchains,
    labels,
  };
}

export async function loadCredential(
  path: string,
): Promise<{ deviceId: string; secret: string } | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      deviceId?: string;
      secret?: string;
    };
    if (raw.deviceId && raw.secret) return { deviceId: raw.deviceId, secret: raw.secret };
    return undefined;
  } catch {
    return undefined;
  }
}

export async function saveCredential(
  path: string,
  cred: { deviceId: string; secret: string },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cred, null, 2)}\n`, { mode: 0o600 });
}

export interface DeviceCliOptions {
  env?: DeviceCliEnv;
  fetch?: typeof fetch;
  once?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function runDeviceDaemonCli(
  argv: string[],
  options: DeviceCliOptions = {},
): Promise<{ ok: boolean; reason?: string; deviceId?: string }> {
  const env = options.env ?? process.env;
  const url = env.MAKA_CLOUD_BYOM_URL?.trim();
  const root = env.MAKA_CLOUD_BYOM_ROOT?.trim();
  const state = env.MAKA_CLOUD_BYOM_STATE?.trim();
  if (!url) return { ok: false, reason: 'missing_url' };
  if (!root) return { ok: false, reason: 'missing_root' };
  if (!state) return { ok: false, reason: 'missing_state' };
  if (argv.includes('--help')) {
    return { ok: true, reason: 'help' };
  }
  const transport = new HttpDeviceTransport(url, options.fetch ?? fetch);
  const stored = await loadCredential(state);
  const daemon = new DeviceDaemon({
    root,
    transport,
    capabilities: capabilitiesFromEnv(env),
    pairingCode: stored ? undefined : env.MAKA_CLOUD_BYOM_CODE?.trim(),
    credential: stored,
    policy: DEFAULT_COMMAND_POLICY,
    now: options.now,
  });
  const hello = await daemon.pairOrHello();
  if (hello.type === 'error' || hello.type === 'killed') {
    return { ok: false, reason: hello.type === 'killed' ? 'killed' : hello.reason };
  }
  if (daemon.credential) await saveCredential(state, daemon.credential);
  if (options.once || argv.includes('--once')) {
    await daemon.poll();
    return { ok: true, deviceId: daemon.credential?.deviceId };
  }
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    if (daemon.killed)
      return { ok: false, reason: 'killed', deviceId: daemon.credential?.deviceId };
    await daemon.poll();
    await sleep(1_000);
  }
}
