import type { Conductor } from '@maka-cloud/conductor';
import type { InboxService } from '@maka-cloud/server';
import {
  ITEM_KINDS,
  type ItemKind,
  OwnerSettingsPatchSchema,
  type Supervisor,
} from '@maka-cloud/supervisor';

/**
 * The server's inbox contract over the supervisor. Validation of settings and kinds stays the
 * supervisor's. The approvals an owner kept are the conductor's, listed and revoked through it.
 */
export function inboxService(supervisor: Supervisor, conductor?: Conductor): InboxService {
  const grants = conductor?.state;
  return {
    ...(grants === undefined
      ? {}
      : {
          grants: {
            list: (owner) =>
              grants.grantsOf(owner).map((grant) => {
                const uses = grants.grantUses(grant.grantId);
                return {
                  grantId: grant.grantId,
                  tool: grant.tool,
                  repository: grant.repository,
                  scope: grant.scope,
                  createdAt: grant.createdAt,
                  expiresAt: grant.expiresAt,
                  uses: uses.length,
                  lastUsedAt: uses.at(-1)?.at ?? null,
                };
              }),
            revoke: (owner, grantId) => grants.revokeGrant(owner, grantId),
            revokeAll: (owner, filter) => grants.revokeGrants(owner, filter),
          },
        }),
    list: async (query) => supervisor.listItems(query),
    answer: async (request) => supervisor.answer(request),
    setMute(owner, kind, muted) {
      if (!(ITEM_KINDS as readonly string[]).includes(kind)) return { ok: false };
      return { ok: true, settings: supervisor.setOwnerMute(owner, kind as ItemKind, muted) };
    },
    settings: (owner) => supervisor.getOwnerSettings(owner),
    updateSettings(owner, patch) {
      const parsed = OwnerSettingsPatchSchema.safeParse(patch);
      if (!parsed.success) return { ok: false };
      return { ok: true, settings: supervisor.setOwnerSettings(owner, parsed.data) };
    },
    digest: (owner) => supervisor.digest(owner),
    stop: () => supervisor.stop(),
  };
}
