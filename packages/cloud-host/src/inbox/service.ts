import type { InboxService } from '@maka-cloud/server';
import {
  ITEM_KINDS,
  type ItemKind,
  SettingsPatchSchema,
  type Supervisor,
} from '@maka-cloud/supervisor';

/** The server's inbox contract over the supervisor. Validation of settings and kinds stays the supervisor's. */
export function inboxService(supervisor: Supervisor): InboxService {
  return {
    list: async (query) => supervisor.listItems(query),
    answer: async (request) => supervisor.answer(request),
    setMute(kind, muted) {
      if (!(ITEM_KINDS as readonly string[]).includes(kind)) return { ok: false };
      return { ok: true, settings: supervisor.setMute(kind as ItemKind, muted) };
    },
    settings: () => supervisor.getSettings(),
    updateSettings(patch) {
      const parsed = SettingsPatchSchema.safeParse(patch);
      if (!parsed.success) return { ok: false };
      return { ok: true, settings: supervisor.setSettings(parsed.data) };
    },
    digest: () => supervisor.digest(),
    stop: () => supervisor.stop(),
  };
}
