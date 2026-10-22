import type { InboxService } from '@maka-cloud/server';
import {
  ITEM_KINDS,
  type ItemKind,
  OwnerSettingsPatchSchema,
  type Supervisor,
} from '@maka-cloud/supervisor';

/** The server's inbox contract over the supervisor. Validation of settings and kinds stays the supervisor's. */
export function inboxService(supervisor: Supervisor): InboxService {
  return {
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
