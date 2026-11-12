import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import {
  EVENT_SOURCES,
  isLiveState,
  type EventSource,
  type NormalizedEvent,
  type WorkerRecord,
} from './types.js';

/**
 * Declarative routing rules (`superagent.rules.json`). A miss falls through
 * to the existing Router. Invalid reloads keep the last good file.
 */

export const REASONING_DEPTHS = ['low', 'medium', 'high'] as const;
export type ReasoningDepth = (typeof REASONING_DEPTHS)[number];

export const NOTIFY_HUMAN = ['never', 'on_ask', 'always'] as const;
export type NotifyHuman = (typeof NOTIFY_HUMAN)[number];

export const RULES_FILE_VERSION = 1 as const;

export interface EventObject {
  kind: string;
  id: string;
  repo?: string;
  path?: string;
  tags?: string[];
  number?: number;
}

export interface EventEnvelope {
  tenantId: string;
  source: EventSource;
  type: string;
  object: EventObject;
  summary: string;
  backlink: string;
}

export interface RoutingRuleMatch {
  source?: EventSource | EventSource[];
  type?: string | string[];
  object?: { kind?: string; id?: string; repo?: string };
  tags?: string[];
  paths?: string[];
}

export interface RoutingRule {
  id: string;
  match: RoutingRuleMatch;
  model?: string;
  reasoning?: ReasoningDepth;
  skills?: string[];
  oneRunPerObject?: boolean;
  maxParallel?: number;
  notifyHuman?: NotifyHuman;
  intensity?: 'observe' | 'act';
}

export interface RulesFile {
  version: typeof RULES_FILE_VERSION;
  rules: RoutingRule[];
}

const SourceSchema = z.enum(EVENT_SOURCES);

const MatchSchema = z
  .object({
    source: z.union([SourceSchema, z.array(SourceSchema).min(1)]).optional(),
    type: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    object: z
      .object({
        kind: z.string().min(1).optional(),
        id: z.string().min(1).optional(),
        repo: z.string().min(1).optional(),
      })
      .optional(),
    tags: z.array(z.string().min(1)).max(32).optional(),
    paths: z.array(z.string().min(1)).max(32).optional(),
  })
  .optional();

export const RoutingRuleSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z][A-Za-z0-9._-]*$/u, 'rule id must be a token'),
  match: MatchSchema.default({}),
  model: z.string().min(1).max(120).optional(),
  reasoning: z.enum(REASONING_DEPTHS).optional(),
  skills: z.array(z.string().min(1).max(80)).max(16).optional(),
  oneRunPerObject: z.boolean().optional(),
  maxParallel: z.number().int().min(1).max(32).optional(),
  notifyHuman: z.enum(NOTIFY_HUMAN).optional(),
  intensity: z.enum(['observe', 'act']).optional(),
});

export const RulesFileSchema = z.object({
  version: z.literal(RULES_FILE_VERSION),
  rules: z.array(RoutingRuleSchema).max(200),
});

export function envelopeOf(event: NormalizedEvent): EventEnvelope {
  const path = field(event, 'file') || field(event, 'path') || undefined;
  const labels = field(event, 'labels')
    .split(',')
    .map((row) => row.trim())
    .filter(Boolean);
  const tag = field(event, 'label');
  const tags = [...labels, ...(tag ? [tag] : [])];
  const backlink = field(event, 'html_url') || field(event, 'url') || `event:${event.eventId}`;
  return {
    tenantId: event.tenantId,
    source: event.source,
    type: event.type,
    object: {
      kind: event.subject?.kind ?? 'none',
      id: event.subject?.key ?? event.eventId,
      ...(event.subject?.repo ? { repo: event.subject.repo } : {}),
      ...(path ? { path } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(event.subject?.number !== undefined ? { number: event.subject.number } : {}),
    },
    summary: event.summary,
    backlink,
  };
}

export function parseRulesFile(
  raw: string,
): { ok: true; file: RulesFile } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  const ids = new Set<string>();
  const result = RulesFileSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    return {
      ok: false,
      reason: first ? `${first.path.join('.')}: ${first.message}` : 'invalid_schema',
    };
  }
  for (const rule of result.data.rules) {
    if (ids.has(rule.id)) return { ok: false, reason: `duplicate_rule:${rule.id}` };
    ids.add(rule.id);
  }
  return { ok: true, file: result.data };
}

function asList<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function ruleMatches(rule: RoutingRule, envelope: EventEnvelope): boolean {
  const sources = asList(rule.match.source);
  if (sources.length > 0 && !sources.includes(envelope.source)) return false;
  const types = asList(rule.match.type);
  if (types.length > 0 && !types.includes(envelope.type)) return false;
  const object = rule.match.object;
  if (object?.kind && object.kind !== envelope.object.kind) return false;
  if (object?.id && object.id !== envelope.object.id) return false;
  if (object?.repo && !repoMatches(object.repo, envelope.object.repo ?? '')) return false;
  const wantTags = rule.match.tags ?? [];
  if (wantTags.length > 0) {
    const have = new Set((envelope.object.tags ?? []).map((tag) => tag.toLowerCase()));
    if (!wantTags.every((tag) => have.has(tag.toLowerCase()))) return false;
  }
  const wantPaths = rule.match.paths ?? [];
  if (wantPaths.length > 0) {
    const have = envelope.object.path ?? '';
    if (!wantPaths.some((path) => pathMatches(path, have))) return false;
  }
  return true;
}

export function matchRoutingRule(
  envelope: EventEnvelope,
  rules: readonly RoutingRule[],
): RoutingRule | undefined {
  return rules.find((rule) => ruleMatches(rule, envelope));
}

export function applyConcurrency(
  rule: RoutingRule,
  envelope: EventEnvelope,
  workers: readonly WorkerRecord[],
): { ok: true } | { ok: false; reason: 'one_run_per_object' | 'rule_parallel_cap' } {
  const live = workers.filter(
    (row) => row.tenantId === envelope.tenantId && isLiveState(row.state),
  );
  if (rule.oneRunPerObject) {
    const objectId = envelope.object.id;
    if (live.some((row) => row.routeRule?.objectId === objectId || row.subject.key === objectId)) {
      return { ok: false, reason: 'one_run_per_object' };
    }
  }
  if (rule.maxParallel !== undefined) {
    const count = live.filter((row) => row.routeRule?.ruleId === rule.id).length;
    if (count >= rule.maxParallel) return { ok: false, reason: 'rule_parallel_cap' };
  }
  return { ok: true };
}

export type ReloadResult = 'unchanged' | 'reloaded' | 'kept_previous' | 'empty';

export class RulesEngine {
  private current: RulesFile = { version: 1, rules: [] };
  private loaded = false;
  private lastMtime = 0;
  private lastSeenMtime = 0;
  lastError?: { at: number; message: string; path: string };

  constructor(
    private readonly options: {
      path?: string;
      readFile?: (path: string) => string;
      stat?: (path: string) => { mtimeMs: number };
      now?: () => number;
      onInvalid?: (message: string, at: number) => void;
    } = {},
  ) {}

  get path(): string | undefined {
    return this.options.path;
  }

  snapshot(): RulesFile {
    return {
      version: 1,
      rules: this.current.rules.map((rule) => ({
        ...rule,
        match: {
          ...rule.match,
          ...(rule.match.object ? { object: { ...rule.match.object } } : {}),
          ...(rule.match.tags ? { tags: [...rule.match.tags] } : {}),
          ...(rule.match.paths ? { paths: [...rule.match.paths] } : {}),
        },
        ...(rule.skills ? { skills: [...rule.skills] } : {}),
      })),
    };
  }

  maybeReload(at?: number): ReloadResult {
    const path = this.options.path;
    const when = at ?? this.options.now?.() ?? Date.now();
    if (!path) return this.loaded ? 'unchanged' : 'empty';
    let mtime = 0;
    let raw: string;
    try {
      mtime = (this.options.stat ?? defaultStat)(path).mtimeMs;
      if (this.lastSeenMtime === mtime && this.lastSeenMtime > 0) {
        return this.loaded ? 'unchanged' : 'empty';
      }
      this.lastSeenMtime = mtime;
      raw = (this.options.readFile ?? defaultRead)(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'rules_unreadable';
      if (!this.loaded) {
        this.recordInvalid(path, message, when);
        return 'empty';
      }
      this.recordInvalid(path, message, when);
      return 'kept_previous';
    }
    const parsed = parseRulesFile(raw);
    if (!parsed.ok) {
      this.recordInvalid(path, parsed.reason, when);
      return this.loaded ? 'kept_previous' : 'empty';
    }
    this.current = parsed.file;
    this.lastMtime = mtime;
    this.loaded = true;
    this.lastError = undefined;
    return 'reloaded';
  }

  match(envelope: EventEnvelope): RoutingRule | undefined {
    return matchRoutingRule(envelope, this.current.rules);
  }

  private recordInvalid(path: string, message: string, at: number): void {
    this.lastError = { at, message, path };
    this.options.onInvalid?.(message, at);
  }
}

export function rulesPathFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env.MAKA_CLOUD_SUPERAGENT_RULES?.trim();
  return path || undefined;
}

function repoMatches(rule: string, repo: string): boolean {
  const want = rule.toLowerCase();
  const have = repo.toLowerCase();
  if (want === have) return true;
  if (want.endsWith('/*')) return have.startsWith(want.slice(0, -1));
  if (want.includes('*')) {
    const escaped = want.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(have);
  }
  return false;
}

function pathMatches(rule: string, have: string): boolean {
  if (!have) return false;
  if (rule.endsWith('/**')) {
    const prefix = rule.slice(0, -3);
    return have === prefix || have.startsWith(`${prefix}/`);
  }
  if (rule.includes('*')) {
    const escaped = rule
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '§§')
      .replace(/\*/g, '[^/]*')
      .replace(/§§/g, '.*');
    return new RegExp(`^${escaped}$`).test(have);
  }
  return have === rule || have.startsWith(`${rule}/`);
}

function field(event: NormalizedEvent, label: string): string {
  return event.fields.find(([name]) => name === label)?.[1] ?? '';
}

function defaultStat(path: string): { mtimeMs: number } {
  return { mtimeMs: statSync(path).mtimeMs };
}

function defaultRead(path: string): string {
  return readFileSync(path, 'utf8');
}
