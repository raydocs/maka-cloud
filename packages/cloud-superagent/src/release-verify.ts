import type { DoneClaim } from './done.js';

export const DEFAULT_RELEASE_VERIFY_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_RELEASE_VERIFY_POLL_MS = 5_000;

export type ReleaseVerifyStatus = 'skipped' | 'pending' | 'confirmed' | 'failed';

export interface VersionProbe {
  read(url: string): Promise<{ status: number; body: string }>;
}

/** Test double. Never calls a live service. */
export class FakeVersionProbe implements VersionProbe {
  readonly reads: string[] = [];
  status = 200;
  body = '{"sha":"deadbeef01"}';
  /** Return `oldBody` for the first N reads, then `body`. */
  failUntil = 0;
  oldBody = '{"sha":"oldold01"}';

  async read(url: string): Promise<{ status: number; body: string }> {
    this.reads.push(url);
    if (this.reads.length <= this.failUntil) {
      return { status: this.status, body: this.oldBody };
    }
    return { status: this.status, body: this.body };
  }
}

export interface ReleaseVerifySettings {
  enabled: boolean;
  /** Live version endpoint (e.g. `https://app.example/version`). Missing → skip. */
  versionUrl?: string;
  timeoutMs: number;
  pollMs: number;
  probe?: VersionProbe;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Host-facing constructor helper. Does not read `process.env`.
 * `enabled` is true only when the host passes `true`.
 */
export function releaseVerifySettingsFrom(
  input: {
    enabled?: boolean;
    versionUrl?: string;
    timeoutMs?: number;
    pollMs?: number;
    probe?: VersionProbe;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): ReleaseVerifySettings {
  return {
    enabled: input.enabled === true,
    versionUrl: input.versionUrl?.trim() || undefined,
    timeoutMs: input.timeoutMs ?? DEFAULT_RELEASE_VERIFY_TIMEOUT_MS,
    pollMs: input.pollMs && input.pollMs > 0 ? input.pollMs : DEFAULT_RELEASE_VERIFY_POLL_MS,
    probe: input.probe,
    sleep: input.sleep,
  };
}

export const DEFAULT_RELEASE_VERIFY: ReleaseVerifySettings = releaseVerifySettingsFrom();

export interface ReleaseVerifyRecord {
  status: ReleaseVerifyStatus;
  reason: string;
  sha?: string;
  seen?: string;
  url?: string;
  wallMs: number;
  at: number;
}

export interface ReleaseVerifyResult {
  record: ReleaseVerifyRecord;
  /** True when Done may retire the worker. */
  complete: boolean;
  /** True when the watchdog should take over. */
  escalate: boolean;
}

export function parseVersionSha(body: string): string | undefined {
  const trimmed = body.trim();
  try {
    const parsed = JSON.parse(trimmed) as { sha?: unknown; commit?: unknown; version?: unknown };
    for (const value of [parsed.sha, parsed.commit, parsed.version]) {
      if (typeof value === 'string' && /[0-9a-f]{7,40}/i.test(value)) {
        const match = /[0-9a-f]{7,40}/i.exec(value);
        if (match) return match[0].toLowerCase();
      }
    }
  } catch {
    // Plain text.
  }
  const match = /[0-9a-f]{7,40}/i.exec(trimmed);
  return match ? match[0].toLowerCase() : undefined;
}

export function liveContainsCommit(liveSha: string | undefined, mergeSha: string): boolean {
  if (!liveSha) return false;
  const live = liveSha.toLowerCase();
  const want = mergeSha.toLowerCase();
  if (live === want) return true;
  if (live.length >= 7 && want.startsWith(live)) return true;
  if (want.length >= 7 && live.startsWith(want)) return true;
  return false;
}

export function mergeShaFromClaim(
  claim: DoneClaim,
  extras: { mergeSha?: string; lastPushSha?: string; lastLiveSha?: string } = {},
): string | undefined {
  return extras.mergeSha ?? extras.lastPushSha ?? extras.lastLiveSha;
}

/** Merge or publish signals mean there is a live version to probe. */
export function looksLikeRelease(claim: DoneClaim): boolean {
  return claim.signals.some((row) => row.kind === 'merged' || row.kind === 'published');
}

export async function verifyRelease(input: {
  settings: ReleaseVerifySettings;
  mergeSha?: string;
  now: () => number;
}): Promise<ReleaseVerifyResult> {
  const started = input.now();
  const url = input.settings.versionUrl;
  if (!input.settings.enabled) {
    return finish('skipped', 'release-verify off', started, input.now, true, false, { url });
  }
  if (!url) {
    return finish('skipped', 'no version endpoint', started, input.now, true, false, { url });
  }
  if (!input.settings.probe) {
    return finish('skipped', 'no version probe', started, input.now, true, false, { url });
  }
  const mergeSha = input.mergeSha;
  if (!mergeSha) {
    return finish('failed', 'no merge sha to match', started, input.now, false, true, { url });
  }
  const sleep = input.settings.sleep ?? (async () => undefined);
  const deadline = started + input.settings.timeoutMs;
  let seen: string | undefined;
  while (input.now() <= deadline) {
    const read = await input.settings.probe.read(url);
    seen = parseVersionSha(read.body);
    if (read.status >= 200 && read.status < 300 && liveContainsCommit(seen, mergeSha)) {
      return finish(
        'confirmed',
        'live version contains merge sha',
        started,
        input.now,
        true,
        false,
        {
          url,
          sha: mergeSha,
          seen,
        },
      );
    }
    const beforeSleep = input.now();
    if (beforeSleep + input.settings.pollMs > deadline) break;
    await sleep(input.settings.pollMs);
    // Injected clocks that do not move must not spin forever.
    if (input.now() <= beforeSleep) break;
  }
  return finish(
    'failed',
    seen ? `live sha ${seen} does not contain ${mergeSha}` : 'release-verify timeout',
    started,
    input.now,
    false,
    true,
    { url, sha: mergeSha, seen },
  );
}

function finish(
  status: ReleaseVerifyStatus,
  reason: string,
  started: number,
  now: () => number,
  complete: boolean,
  escalate: boolean,
  extra: { url?: string; sha?: string; seen?: string },
): ReleaseVerifyResult {
  const at = now();
  return {
    complete,
    escalate,
    record: {
      status,
      reason,
      sha: extra.sha,
      seen: extra.seen,
      url: extra.url,
      wallMs: Math.max(0, at - started),
      at,
    },
  };
}
