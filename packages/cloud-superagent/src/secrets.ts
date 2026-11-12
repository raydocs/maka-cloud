import { readFileSync } from 'node:fs';
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

export interface EnvOrgSecretsOptions {
  env?: NodeJS.ProcessEnv;
  /** JSON object `{ "NAME": "value" }` or `{ "tenantId": { "NAME": "value" } }`. */
  filePath?: string;
  values?: Record<string, string>;
}

const NAME_RE = /^[A-Z][A-Z0-9_]*$/u;

/**
 * Local / env-backed Org Secrets. Values come from
 * `MAKA_CLOUD_ORG_SECRET_<NAME>`, `MAKA_CLOUD_ORG_SECRET_<TENANT>_<NAME>`,
 * or `MAKA_CLOUD_ORG_SECRETS_FILE`. `inject` writes into the destination
 * bag and never returns the raw secret.
 */
export class EnvOrgSecrets implements OrgSecretPort {
  private readonly values = new Map<string, string>();

  constructor(options: EnvOrgSecretsOptions = {}) {
    const env = options.env ?? process.env;
    const filePath = options.filePath ?? env.MAKA_CLOUD_ORG_SECRETS_FILE?.trim();
    if (filePath) loadFile(filePath, this.values);
    if (options.values) {
      for (const [key, value] of Object.entries(options.values)) {
        if (value) this.values.set(key.toUpperCase(), value);
      }
    }
    for (const [key, value] of Object.entries(env)) {
      if (!value) continue;
      const match = /^MAKA_CLOUD_ORG_SECRET_([A-Z0-9_]+)$/u.exec(key);
      if (match) this.values.set(match[1] as string, value);
    }
  }

  async has(ref: OrgSecretRef): Promise<boolean> {
    return this.lookup(ref) !== undefined;
  }

  async inject(ref: OrgSecretRef, dest: OrgSecretDestination): Promise<OrgSecretResult> {
    const value = this.lookup(ref);
    if (value === undefined) return { ok: false, reason: 'unknown' };
    if (dest.kind === 'env') {
      if (dest.env === undefined) return { ok: false, reason: 'refused' };
      dest.env[dest.name] = value;
      return { ok: true };
    }
    if (dest.headers === undefined) return { ok: false, reason: 'refused' };
    dest.headers[dest.name] = value;
    return { ok: true };
  }

  private lookup(ref: OrgSecretRef): string | undefined {
    const name = normalizeName(ref.name);
    if (name === undefined) return undefined;
    const tenant = normalizeName(ref.tenantId.replace(/[^A-Za-z0-9_]/g, '_'));
    if (tenant) {
      const scoped = this.values.get(`${tenant}_${name}`);
      if (scoped !== undefined) return scoped;
    }
    return this.values.get(name);
  }
}

function normalizeName(name: string): string | undefined {
  const folded = name.trim().toUpperCase();
  return NAME_RE.test(folded) ? folded : undefined;
}

function loadFile(path: string, into: Map<string, string>): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `MAKA_CLOUD_ORG_SECRETS_FILE ${path} could not be read: ${
        error instanceof Error ? error.message : 'error'
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`MAKA_CLOUD_ORG_SECRETS_FILE ${path} is not JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`MAKA_CLOUD_ORG_SECRETS_FILE ${path} must be a JSON object.`);
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' && value) {
      into.set(key.toUpperCase(), value);
      continue;
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const tenant = key.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
      for (const [inner, secret] of Object.entries(value as Record<string, unknown>)) {
        if (typeof secret === 'string' && secret) {
          into.set(`${tenant}_${inner.toUpperCase()}`, secret);
        }
      }
    }
  }
}
