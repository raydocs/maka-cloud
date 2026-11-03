/**
 * P5 hi-device worker. Out of this repo: no remote unlock, no payment path.
 * Cloud-originated payment stays `approval_unavailable`. Default is off.
 */

export type HiDeviceRefusal = 'disabled' | 'approval_unavailable';

export type HiDeviceResult = { ok: true; text: string } | { ok: false; reason: HiDeviceRefusal };

export interface HiDeviceRequest {
  tenantId: string;
  workerId: string;
  prompt: string;
}

/**
 * Optional evaluation device. The product does not ship an implementation;
 * a later out-of-repo worker may satisfy this.
 */
export interface HiDevicePort {
  readonly enabled: boolean;
  evaluate(request: HiDeviceRequest): Promise<HiDeviceResult>;
  requestPayment(request: HiDeviceRequest): Promise<HiDeviceResult>;
}

/** Default: the hi device is off. Payment from the cloud is never offered. */
export class OffHiDevice implements HiDevicePort {
  readonly enabled = false;

  async evaluate(_request: HiDeviceRequest): Promise<HiDeviceResult> {
    return { ok: false, reason: 'disabled' };
  }

  async requestPayment(_request: HiDeviceRequest): Promise<HiDeviceResult> {
    return { ok: false, reason: 'approval_unavailable' };
  }
}
