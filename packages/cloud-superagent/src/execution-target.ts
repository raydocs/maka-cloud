/**
 * ExecutionTarget: a worker runs on an Instabox box (default) or a paired
 * BYOM device chosen by capability. Default resolver never selects a device
 * unless BYOM is enabled and the need requires it.
 */

import type { DeviceCapabilities } from './byom-protocol.js';
import type { ByomHub } from './byom.js';
import type { SandboxPort } from './sandbox.js';

export type ExecutionTargetKind = 'instabox' | 'device';

export interface ExecutionTargetRef {
  kind: ExecutionTargetKind;
  id?: string;
  waitReason?: string;
  /** Per-device shell switch. Unset/false means argv-only exec. */
  allowShell?: boolean;
}

export interface ExecutionNeed {
  os?: string;
  arch?: string;
  toolchains?: string[];
  labels?: string[];
}

export interface ExecutionTarget {
  readonly kind: ExecutionTargetKind;
  readonly id: string;
  readonly capabilities: DeviceCapabilities;
  readonly online: boolean;
  asSandbox(input: { tenantId: string; workerId: string; repo?: string }): SandboxPort;
}

export type ResolveResult =
  | { ok: true; target: ExecutionTarget }
  | { ok: false; reason: string; waitReason?: string; kind?: ExecutionTargetKind };

export interface ExecutionTargetResolver {
  resolve(input: { tenantId: string; repo?: string; need?: ExecutionNeed }): Promise<ResolveResult>;
}

export function matchesNeed(caps: DeviceCapabilities, need: ExecutionNeed | undefined): boolean {
  if (!need) return true;
  if (need.os && caps.os.toLowerCase() !== need.os.toLowerCase()) return false;
  if (need.arch && caps.arch.toLowerCase() !== need.arch.toLowerCase()) return false;
  for (const tool of need.toolchains ?? []) {
    if (!caps.toolchains.map((row) => row.toLowerCase()).includes(tool.toLowerCase())) {
      return false;
    }
  }
  for (const label of need.labels ?? []) {
    if (!caps.labels.map((row) => row.toLowerCase()).includes(label.toLowerCase())) {
      return false;
    }
  }
  return true;
}

export function needsDevice(need: ExecutionNeed | undefined): boolean {
  if (!need) return false;
  if (need.os && /^(darwin|macos|osx)$/i.test(need.os)) return true;
  const tools = need.toolchains ?? [];
  return tools.some((tool) => /^(xcodebuild|xcrun|swift|fastlane|pod)$/i.test(tool));
}

export class InstaboxTarget implements ExecutionTarget {
  readonly kind = 'instabox' as const;
  readonly capabilities: DeviceCapabilities = {
    os: 'linux',
    arch: 'x64',
    toolchains: ['git', 'node', 'npm'],
    labels: ['instabox'],
  };
  readonly online = true;

  constructor(
    readonly id: string,
    private readonly sandbox: SandboxPort,
  ) {}

  asSandbox(): SandboxPort {
    return this.sandbox;
  }
}

export class DeviceTarget implements ExecutionTarget {
  readonly kind = 'device' as const;

  constructor(
    readonly id: string,
    readonly capabilities: DeviceCapabilities,
    readonly online: boolean,
    private readonly hub: ByomHub,
  ) {}

  asSandbox(input: { tenantId: string; workerId: string; repo?: string }): SandboxPort {
    return this.hub.sandboxFor(this.id, input.tenantId, input.workerId, input.repo);
  }
}

export class DefaultExecutionResolver implements ExecutionTargetResolver {
  constructor(
    private readonly sandbox: SandboxPort,
    private readonly defaultSandboxRef: string | null,
    private readonly hub?: ByomHub,
  ) {}

  async resolve(input: {
    tenantId: string;
    repo?: string;
    need?: ExecutionNeed;
  }): Promise<ResolveResult> {
    const wantDevice = needsDevice(input.need);
    if (!wantDevice || !this.hub?.enabled) {
      return {
        ok: true,
        target: new InstaboxTarget(this.defaultSandboxRef ?? 'instabox', this.sandbox),
      };
    }
    if (input.repo && !this.hub.settings.optedRepos.includes(input.repo)) {
      return { ok: false, reason: 'repo_not_opted_in', kind: 'device' };
    }
    const online = this.hub
      .onlineDevices(input.tenantId)
      .filter((row) => matchesNeed(row.capabilities, input.need));
    if (online[0]) {
      return {
        ok: true,
        target: new DeviceTarget(online[0].deviceId, online[0].capabilities, true, this.hub),
      };
    }
    const known = [...this.hub.devices.values()].filter(
      (row) =>
        row.tenantId === input.tenantId && !row.killed && matchesNeed(row.capabilities, input.need),
    );
    if (known[0]) {
      return {
        ok: false,
        reason: 'device_offline',
        waitReason: 'device_offline',
        kind: 'device',
      };
    }
    return { ok: false, reason: 'no_matching_device', kind: 'device' };
  }
}
