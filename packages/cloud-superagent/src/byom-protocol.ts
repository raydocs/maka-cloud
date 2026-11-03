/**
 * BYOM wire protocol. The device always dials out (no inbound ports).
 * Keep the daemon package (`@maka-cloud/superagent-device`) aligned with this
 * file: same `v: 1` envelopes and field names.
 */

export const BYOM_PROTOCOL_VERSION = 1 as const;

export interface DeviceCapabilities {
  os: string;
  arch: string;
  cpu?: number;
  toolchains: string[];
  labels: string[];
}

export interface DeviceJob {
  jobId: string;
  tenantId: string;
  workerId: string;
  repo?: string;
  cmd: string;
  cwd?: string;
  stdin?: string;
  timeoutSeconds: number;
  /** Cloud is the source of truth. Missing means false. */
  allowShell?: boolean;
}

export interface DeviceExecResult {
  jobId: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type DeviceToCloud =
  | {
      v: typeof BYOM_PROTOCOL_VERSION;
      type: 'pair';
      pairingCode: string;
      capabilities: DeviceCapabilities;
      nonce: string;
    }
  | {
      v: typeof BYOM_PROTOCOL_VERSION;
      type: 'hello';
      deviceId: string;
      ts: number;
      nonce: string;
      hmac: string;
      capabilities: DeviceCapabilities;
    }
  | {
      v: typeof BYOM_PROTOCOL_VERSION;
      type: 'poll';
      deviceId: string;
      ts: number;
      nonce: string;
      hmac: string;
    }
  | {
      v: typeof BYOM_PROTOCOL_VERSION;
      type: 'result';
      deviceId: string;
      ts: number;
      nonce: string;
      hmac: string;
      jobId: string;
      stdout: string;
      stderr: string;
      exitCode: number;
    };

export type CloudToDevice =
  | {
      v: typeof BYOM_PROTOCOL_VERSION;
      type: 'paired';
      deviceId: string;
      secret: string;
      serverMac: string;
      allowShell: boolean;
    }
  | {
      v: typeof BYOM_PROTOCOL_VERSION;
      type: 'welcome';
      serverMac: string;
      allowShell: boolean;
    }
  | { v: typeof BYOM_PROTOCOL_VERSION; type: 'jobs'; jobs: DeviceJob[] }
  | { v: typeof BYOM_PROTOCOL_VERSION; type: 'ack'; jobId: string }
  | { v: typeof BYOM_PROTOCOL_VERSION; type: 'killed' }
  | { v: typeof BYOM_PROTOCOL_VERSION; type: 'error'; reason: string };

export interface DeviceTransport {
  send(message: DeviceToCloud): Promise<CloudToDevice>;
}

export function authPayload(
  deviceId: string,
  ts: number,
  nonce: string,
  type: DeviceToCloud['type'],
): string {
  return `${deviceId}\n${ts}\n${nonce}\n${type}`;
}

export function welcomePayload(nonce: string, ts: number): string {
  return `welcome\n${nonce}\n${ts}`;
}
