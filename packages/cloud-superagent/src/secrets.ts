import type {
  OrgSecretDestination,
  OrgSecretPort,
  OrgSecretRef,
  OrgSecretResult,
} from './types.js';

/**
 * Instabox Org Secrets are not assumed. This port never returns a raw
 * secret. The product stays on this stub until the owner confirms the
 * box plan and we implement a real injector.
 */
export class UnconfiguredOrgSecrets implements OrgSecretPort {
  async has(_ref: OrgSecretRef): Promise<boolean> {
    return false;
  }

  async inject(_ref: OrgSecretRef, _dest: OrgSecretDestination): Promise<OrgSecretResult> {
    return { ok: false, reason: 'unavailable' };
  }
}
