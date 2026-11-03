import {
  ByomHub,
  byomSettingsFromEnv,
  type PeerReviewClient,
  peerReviewSettingsFrom,
  releaseVerifySettingsFrom,
  rulesPathFromEnv,
  type SuperagentOptions,
  sweepSettingsFrom,
  type VersionProbe,
} from '@maka-cloud/superagent';

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const RULES_RELOAD_MS = 60_000;

/**
 * Host-parsed Super-agent feature flags. Default off. The Superagent
 * constructor never reads these variables; `startStack` passes the result.
 */
export interface SuperagentFeatureConfig {
  byom: boolean;
  learning: boolean;
  peerReview: boolean;
  peerReviewUrl?: string;
  peerReviewModel?: string;
  releaseVerify: boolean;
  /** Absent → post-deploy verify skips the /version probe. */
  releaseVerifyUrl?: string;
  sweep: boolean;
  sweepTenant?: string;
  sweepRepo?: string;
  sweepEveryMs: number;
  rulesPath?: string;
  rulesEveryMs: number;
}

export function readSuperagentFeatureConfig(env: NodeJS.ProcessEnv): {
  features: SuperagentFeatureConfig;
  problems: string[];
} {
  const problems: string[] = [];
  const on = (name: string): boolean => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '' || raw === '0') return false;
    if (raw === '1') return true;
    problems.push(`${name} must be 1 or 0`);
    return false;
  };
  const every = (name: string, fallback: number): number => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      problems.push(`${name} must be a whole number of milliseconds above 0`);
      return fallback;
    }
    return parsed;
  };
  const endpoint = (name: string, enabled: boolean): string | undefined => {
    if (!enabled) return undefined;
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') return undefined;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      problems.push(`${name} is not a URL`);
      return undefined;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      problems.push(`${name} must be an http or https URL`);
      return undefined;
    }
    if (parsed.username !== '' || parsed.password !== '') {
      problems.push(`${name} must not carry credentials`);
      return undefined;
    }
    return raw;
  };
  const peerReview = on('MAKA_CLOUD_PEER_REVIEW');
  const releaseVerify = on('MAKA_CLOUD_RELEASE_VERIFY');
  const sweep = on('MAKA_CLOUD_SWEEP');
  const peerReviewUrl = endpoint('MAKA_CLOUD_PEER_REVIEW_URL', peerReview);
  const releaseVerifyUrl = endpoint('MAKA_CLOUD_RELEASE_VERIFY_URL', releaseVerify);
  const model = env.MAKA_CLOUD_PEER_REVIEW_MODEL?.trim();
  const sweepTenant = env.MAKA_CLOUD_SWEEP_TENANT?.trim();
  const sweepRepo = env.MAKA_CLOUD_SWEEP_REPO?.trim();
  const rulesPath = rulesPathFromEnv(env);
  return {
    problems,
    features: {
      byom: on('MAKA_CLOUD_BYOM'),
      learning: on('MAKA_CLOUD_LEARNING'),
      peerReview,
      ...(peerReviewUrl ? { peerReviewUrl } : {}),
      ...(model ? { peerReviewModel: model } : {}),
      releaseVerify,
      ...(releaseVerifyUrl ? { releaseVerifyUrl } : {}),
      sweep,
      ...(sweepTenant ? { sweepTenant } : {}),
      ...(sweepRepo ? { sweepRepo } : {}),
      sweepEveryMs: every('MAKA_CLOUD_SWEEP_EVERY_MS', WEEK_MS),
      ...(rulesPath ? { rulesPath } : {}),
      rulesEveryMs: every('MAKA_CLOUD_RULES_EVERY_MS', RULES_RELOAD_MS),
    },
  };
}

export const SUPERAGENT_FEATURES_OFF: SuperagentFeatureConfig = {
  byom: false,
  learning: false,
  peerReview: false,
  releaseVerify: false,
  sweep: false,
  sweepEveryMs: WEEK_MS,
  rulesEveryMs: RULES_RELOAD_MS,
};

/** Fetch GET of a configured /version URL. Built only when that URL is set. */
export class HttpVersionProbe implements VersionProbe {
  constructor(private readonly fetchImpl: typeof fetch) {}

  async read(url: string): Promise<{ status: number; body: string }> {
    const response = await this.fetchImpl(url);
    return { status: response.status, body: await response.text() };
  }
}

/** Fetch POST of a review prompt. Built only when a review URL is set. */
export class HttpPeerReviewClient implements PeerReviewClient {
  constructor(
    readonly model: string,
    private readonly url: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async complete(prompt: string): Promise<{ text: string }> {
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt }),
    });
    const body = await response.text();
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`peer review ${response.status}`);
    }
    try {
      const parsed = JSON.parse(body) as { text?: unknown };
      if (typeof parsed.text === 'string') return { text: parsed.text };
    } catch {
      /* plain text body */
    }
    return { text: body };
  }
}

/**
 * Options for `new Superagent`. Reads nothing itself; the caller passes the
 * already-parsed feature config and the env bag `byomSettingsFromEnv` needs.
 */
export function superagentOptionsFromFeatures(
  features: SuperagentFeatureConfig,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = globalThis.fetch,
): Partial<SuperagentOptions> {
  const options: Partial<SuperagentOptions> = {};
  if (features.byom) {
    options.byom = new ByomHub({ settings: byomSettingsFromEnv(env) });
  }
  if (features.learning) options.learning = { enabled: true };
  if (features.peerReview) {
    const model = features.peerReviewModel || 'peer-review';
    options.peerReview = peerReviewSettingsFrom({
      enabled: true,
      model,
      ...(features.peerReviewUrl
        ? { client: new HttpPeerReviewClient(model, features.peerReviewUrl, fetchImpl) }
        : {}),
    });
  }
  if (features.releaseVerify) {
    const release: Parameters<typeof releaseVerifySettingsFrom>[0] = { enabled: true };
    if (features.releaseVerifyUrl) {
      release.versionUrl = features.releaseVerifyUrl;
      release.probe = new HttpVersionProbe(fetchImpl);
    }
    options.releaseVerify = releaseVerifySettingsFrom(release);
  }
  if (features.sweep) {
    options.sweep = sweepSettingsFrom({
      enabled: true,
      ...(features.sweepRepo ? { repo: features.sweepRepo } : {}),
    });
  }
  if (features.rulesPath) options.rulesPath = features.rulesPath;
  return options;
}

export function sweepTargets(
  features: SuperagentFeatureConfig,
  inviteIds: readonly string[],
): string[] {
  if (!features.sweep) return [];
  if (features.sweepTenant) return [features.sweepTenant];
  return [...new Set(inviteIds)];
}

/** Load the rules file now, then hot-reload it. Weekly sweep only when enabled. */
export function startSuperagentFeatureTimers(input: {
  features: SuperagentFeatureConfig;
  every: (fn: () => void, ms: number) => () => void;
  reloadRules: () => void;
  sweep: () => void;
}): () => void {
  const stops: Array<() => void> = [];
  if (input.features.rulesPath) {
    input.reloadRules();
    stops.push(input.every(() => input.reloadRules(), input.features.rulesEveryMs));
  }
  if (input.features.sweep) {
    stops.push(input.every(() => input.sweep(), input.features.sweepEveryMs));
  }
  return () => {
    for (const stop of stops) stop();
  };
}

export function releaseVerifySkipsWithoutEndpoint(
  settings: { enabled?: boolean; versionUrl?: string } | undefined,
): boolean {
  return (
    settings?.enabled === true && (settings.versionUrl === undefined || settings.versionUrl === '')
  );
}
