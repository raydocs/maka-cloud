import { rulesPathFromEnv, type SuperagentOptions } from '@maka-cloud/superagent';

export const RULES_RELOAD_MS = 60_000;

/**
 * Host-parsed Super-agent settings. The Superagent constructor never reads
 * these variables; `startStack` passes the result.
 */
export interface SuperagentFeatureConfig {
  rulesPath?: string;
  rulesEveryMs: number;
}

export function readSuperagentFeatureConfig(env: NodeJS.ProcessEnv): {
  features: SuperagentFeatureConfig;
  problems: string[];
} {
  const problems: string[] = [];
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
  const rulesPath = rulesPathFromEnv(env);
  return {
    problems,
    features: {
      ...(rulesPath ? { rulesPath } : {}),
      rulesEveryMs: every('MAKA_CLOUD_RULES_EVERY_MS', RULES_RELOAD_MS),
    },
  };
}

export const SUPERAGENT_FEATURES_OFF: SuperagentFeatureConfig = {
  rulesEveryMs: RULES_RELOAD_MS,
};

/** Options for `new Superagent`. Reads nothing itself; the caller passes the already-parsed config. */
export function superagentOptionsFromFeatures(
  features: SuperagentFeatureConfig,
): Partial<SuperagentOptions> {
  return features.rulesPath ? { rulesPath: features.rulesPath } : {};
}

/** Load the rules file now, then hot-reload it. */
export function startSuperagentFeatureTimers(input: {
  features: SuperagentFeatureConfig;
  every: (fn: () => void, ms: number) => () => void;
  reloadRules: () => void;
}): () => void {
  if (!input.features.rulesPath) return () => undefined;
  input.reloadRules();
  return input.every(() => input.reloadRules(), input.features.rulesEveryMs);
}
