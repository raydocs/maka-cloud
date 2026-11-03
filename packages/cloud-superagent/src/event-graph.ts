import { createHash } from 'node:crypto';
import type { RouterMode } from './intake.js';
import { pathOverlaps } from './scheduler.js';
import type { SuperagentStore } from './store.js';
import type { NormalizedEvent } from './types.js';

export const GRAPH_DOCUMENT = 'graph';
export const DEFAULT_MERGE_MODE: RouterMode = 'observe';
const MAX_TICKETS = 200;
const MAX_EDGES = 400;
const MAX_COLLISIONS = 80;

const PATH_RE =
  /(?:^|[\s`'"(])((?:src|lib|app|apps|packages|docs|test|tests|bin|internal)\/[\w./-]+\.[A-Za-z][A-Za-z0-9]{0,7})/gu;
const COMMIT_RE = /\b([0-9a-f]{7,40})\b/giu;
const REF_RE =
  /\b(?:(?:fixes|closes|refs?|see)\s+)?(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#|#)(\d+)\b/giu;
const STOP = new Set([
  'about',
  'after',
  'blank',
  'error',
  'failed',
  'failure',
  'issue',
  'please',
  'should',
  'their',
  'there',
  'these',
  'this',
  'those',
  'with',
]);

export interface EventSignals {
  repo?: string;
  paths: string[];
  refs: string[];
  commits: string[];
  fingerprints: string[];
  tokens: string[];
}

export interface GraphTicket {
  ticketId: string;
  tenantId: string;
  subjectKey: string;
  workerId: string | null;
  taskId?: string;
  signals: EventSignals;
  members: string[];
  blocked: string[];
  at: number;
}

export interface GraphEdge {
  mergeId: string;
  tenantId: string;
  fromTriggerId: string;
  fromThreadId: string;
  toThreadId: string;
  toWorkerId: string | null;
  reason: string;
  layer: 'programmatic' | 'slow';
  mode: RouterMode;
  applied: boolean;
  subscriptionId?: string;
  at: number;
  splitAt?: number;
}

export interface CollisionHint {
  id: string;
  tenantId: string;
  leftId: string;
  rightId: string;
  kind: 'footprint' | 'subject';
  detail: string;
  at: number;
}

export interface GraphState {
  mode: RouterMode;
  /** True only after ensureMergeConfig / setMergeConfig. */
  modePinned?: boolean;
  tickets: GraphTicket[];
  edges: GraphEdge[];
  collisions: CollisionHint[];
}

export interface MergeHit {
  ticket: GraphTicket;
  reason: string;
  layer: 'programmatic' | 'slow';
}

export function emptyGraphState(): GraphState {
  return { mode: DEFAULT_MERGE_MODE, tickets: [], edges: [], collisions: [] };
}

export function parseGraphState(raw: string | undefined): GraphState {
  if (!raw) return emptyGraphState();
  try {
    const parsed = JSON.parse(raw) as Partial<GraphState>;
    return {
      mode:
        parsed.mode === 'auto' || parsed.mode === 'off' || parsed.mode === 'observe'
          ? parsed.mode
          : DEFAULT_MERGE_MODE,
      ...(parsed.modePinned === true ? { modePinned: true } : {}),
      tickets: Array.isArray(parsed.tickets) ? parsed.tickets.map(cloneTicket) : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges.map(cloneEdge) : [],
      collisions: Array.isArray(parsed.collisions)
        ? parsed.collisions.map((row) => ({ ...row }))
        : [],
    };
  } catch {
    return emptyGraphState();
  }
}

export function loadGraph(store: SuperagentStore, tenantId: string): GraphState {
  return parseGraphState(store.getDocument(tenantId, GRAPH_DOCUMENT));
}

export function saveGraph(
  store: SuperagentStore,
  tenantId: string,
  state: GraphState,
  at: number,
): void {
  store.putDocument(tenantId, GRAPH_DOCUMENT, JSON.stringify(state), at);
}

export function fingerprintOf(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex').slice(0, 16);
}

export function extractSignals(event: NormalizedEvent): EventSignals {
  const repo = event.subject?.repo?.toLowerCase();
  const text = [
    event.summary,
    field(event, 'text'),
    field(event, 'body'),
    field(event, 'comment'),
    field(event, 'title'),
    field(event, 'error'),
    field(event, 'stack'),
  ]
    .filter(Boolean)
    .join('\n');
  const paths = unique([
    ...csv(field(event, 'file')),
    ...csv(field(event, 'path')),
    ...csv(field(event, 'files')),
    ...pathsFromText(text),
  ]);
  const commits = unique([
    field(event, 'sha').toLowerCase(),
    field(event, 'commit').toLowerCase(),
    ...commitsFromText(text),
  ]).filter((row) => row.length >= 7);
  const fingerprints = unique([
    field(event, 'fingerprint').toLowerCase(),
    field(event, 'stack') ? fingerprintOf(field(event, 'stack')) : '',
    field(event, 'error') ? fingerprintOf(field(event, 'error')) : '',
  ]).filter(Boolean);
  const refs = refsFromText(text, repo);
  if (repo && event.subject?.number !== undefined) {
    refs.push(refKey(repo, event.subject.number));
  }
  return {
    ...(repo ? { repo } : {}),
    paths,
    refs: unique(refs),
    commits,
    fingerprints,
    tokens: [...significantTokens(text)],
  };
}

export function unionSignals(left: EventSignals, right: EventSignals): EventSignals {
  return {
    ...((left.repo ?? right.repo) ? { repo: left.repo ?? right.repo } : {}),
    paths: unique([...left.paths, ...right.paths]),
    refs: unique([...left.refs, ...right.refs]),
    commits: unique([...left.commits, ...right.commits]),
    fingerprints: unique([...left.fingerprints, ...right.fingerprints]),
    tokens: unique([...left.tokens, ...right.tokens]),
  };
}

export function programmaticHit(
  incoming: EventSignals,
  ticket: EventSignals,
): { hit: true; reason: string } | { hit: false } {
  const repoOk = !incoming.repo || !ticket.repo || incoming.repo === ticket.repo;
  const path = firstOverlap(incoming.paths, ticket.paths, pathOverlaps);
  if (path && repoOk) return { hit: true, reason: `path:${path}` };
  const fingerprint = firstEqual(incoming.fingerprints, ticket.fingerprints);
  if (fingerprint) return { hit: true, reason: `fingerprint:${fingerprint}` };
  const commit = firstEqual(incoming.commits, ticket.commits);
  if (commit && repoOk) return { hit: true, reason: `commit:${commit}` };
  const ref = firstEqual(incoming.refs, ticket.refs);
  if (ref) return { hit: true, reason: `ref:${ref}` };
  return { hit: false };
}

export function fuzzyCandidate(incoming: EventSignals, ticket: EventSignals): boolean {
  if (programmaticHit(incoming, ticket).hit) return false;
  if (incoming.repo && ticket.repo && incoming.repo !== ticket.repo) return false;
  return overlapCount(new Set(incoming.tokens), new Set(ticket.tokens)) >= 2;
}

export function findProgrammatic(
  event: NormalizedEvent,
  tickets: readonly GraphTicket[],
): MergeHit | undefined {
  const signals = extractSignals(event);
  const key = event.subject?.key;
  for (const ticket of tickets) {
    if (!key || skipsTicket(ticket, key)) continue;
    const hit = programmaticHit(signals, ticket.signals);
    if (hit.hit) return { ticket, reason: hit.reason, layer: 'programmatic' };
  }
  return undefined;
}

export function findFuzzy(event: NormalizedEvent, tickets: readonly GraphTicket[]): GraphTicket[] {
  const signals = extractSignals(event);
  const key = event.subject?.key;
  const out: GraphTicket[] = [];
  for (const ticket of tickets) {
    if (!key || skipsTicket(ticket, key)) continue;
    if (fuzzyCandidate(signals, ticket.signals)) out.push(ticket);
    if (out.length >= 3) break;
  }
  return out;
}

export function parseMergeJudgement(
  raw: string,
  tickets: readonly GraphTicket[],
): { ticketId: string; reason: string } | undefined {
  const json = extractJson(raw);
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as { merge?: unknown; ticketId?: unknown; reason?: unknown };
    if (parsed.merge !== true) return undefined;
    const ticketId = typeof parsed.ticketId === 'string' ? parsed.ticketId : '';
    const ticket = tickets.find((row) => row.ticketId === ticketId || row.subjectKey === ticketId);
    if (!ticket) return undefined;
    const reason =
      typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : 'model';
    return { ticketId: ticket.ticketId, reason: `model:${reason}` };
  } catch {
    return undefined;
  }
}

export function mergePrompt(event: NormalizedEvent, tickets: readonly GraphTicket[]): string {
  return [
    'These events may be the same ticket. Reply JSON only.',
    '{"merge":true,"ticketId":"...","reason":"..."} or {"merge":false}',
    `incoming type=${event.type} subject=${event.subject?.key ?? ''} summary=${event.summary}`,
    ...tickets.map(
      (row) =>
        `ticket ${row.ticketId} subject=${row.subjectKey} refs=${row.signals.refs.join(',')}`,
    ),
  ].join('\n');
}

export function upsertTicket(state: GraphState, ticket: GraphTicket): GraphState {
  const rest = state.tickets.filter((row) => row.ticketId !== ticket.ticketId);
  return { ...state, tickets: [...rest, ticket].slice(-MAX_TICKETS) };
}

export function applyMerge(
  state: GraphState,
  input: {
    mergeId: string;
    tenantId: string;
    event: NormalizedEvent;
    ticket: GraphTicket;
    reason: string;
    layer: 'programmatic' | 'slow';
    mode: RouterMode;
    applied: boolean;
    subscriptionId?: string;
    at: number;
  },
): GraphState {
  const fromThreadId = input.event.subject?.key ?? input.event.eventId;
  const ticket: GraphTicket = {
    ...input.ticket,
    signals: unionSignals(input.ticket.signals, extractSignals(input.event)),
    members: input.applied ? unique([...input.ticket.members, fromThreadId]) : input.ticket.members,
  };
  const edge: GraphEdge = {
    mergeId: input.mergeId,
    tenantId: input.tenantId,
    fromTriggerId: input.event.eventId,
    fromThreadId,
    toThreadId: ticket.subjectKey,
    toWorkerId: ticket.workerId,
    reason: input.reason,
    layer: input.layer,
    mode: input.mode,
    applied: input.applied,
    ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}),
    at: input.at,
  };
  return {
    ...state,
    tickets: upsertTicket(state, ticket).tickets,
    edges: [...state.edges, edge].slice(-MAX_EDGES),
  };
}

export function splitMerge(state: GraphState, mergeId: string, at: number): GraphState {
  const edge = state.edges.find((row) => row.mergeId === mergeId && row.splitAt === undefined);
  if (!edge) return state;
  const nextEdge = { ...edge, applied: false, splitAt: at };
  const tickets = state.tickets.map((ticket) => {
    if (ticket.subjectKey !== edge.toThreadId && ticket.ticketId !== edge.toThreadId) return ticket;
    return {
      ...ticket,
      members: ticket.members.filter((key) => key !== edge.fromThreadId),
      blocked: unique([...ticket.blocked, edge.fromThreadId]),
    };
  });
  return {
    ...state,
    tickets,
    edges: state.edges.map((row) => (row.mergeId === mergeId ? nextEdge : row)),
  };
}

export function noteCollision(state: GraphState, hint: CollisionHint): GraphState {
  const dup = state.collisions.some(
    (row) => row.kind === hint.kind && row.leftId === hint.leftId && row.rightId === hint.rightId,
  );
  if (dup) return state;
  return { ...state, collisions: [...state.collisions, hint].slice(-MAX_COLLISIONS) };
}

export function setGraphMode(state: GraphState, mode: RouterMode): GraphState {
  return { ...state, mode, modePinned: true };
}

export function liveTickets(state: GraphState): GraphTicket[] {
  return state.tickets.filter((row) => !row.blocked.includes(row.subjectKey));
}

function skipsTicket(ticket: GraphTicket, key: string): boolean {
  return ticket.subjectKey === key || ticket.members.includes(key) || ticket.blocked.includes(key);
}

function pathsFromText(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(PATH_RE)) {
    if (match[1]) out.push(match[1].replace(/\\/g, '/'));
  }
  return out;
}

function commitsFromText(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(COMMIT_RE)) {
    const value = (match[1] ?? '').toLowerCase();
    if (value.length >= 7 && !/^[0-9]+$/.test(value)) out.push(value);
  }
  return out;
}

function refsFromText(text: string, repo: string | undefined): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(REF_RE)) {
    const named = match[1]?.toLowerCase();
    const number = match[2];
    if (!number) continue;
    if (named) out.push(refKey(named, Number(number)));
    else if (repo) out.push(refKey(repo, Number(number)));
  }
  return out;
}

function refKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

function significantTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_./-]+/u)) {
    if (raw.length < 5 || STOP.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function overlapCount(left: Set<string>, right: Set<string>): number {
  let n = 0;
  for (const row of left) if (right.has(row)) n += 1;
  return n;
}

function firstOverlap(
  left: readonly string[],
  right: readonly string[],
  same: (a: string, b: string) => boolean,
): string | undefined {
  for (const a of left) {
    for (const b of right) {
      if (same(a, b)) return a;
    }
  }
  return undefined;
}

function firstEqual(left: readonly string[], right: readonly string[]): string | undefined {
  const have = new Set(right);
  return left.find((row) => have.has(row));
}

function field(event: NormalizedEvent, label: string): string {
  return event.fields.find(([name]) => name === label)?.[1] ?? '';
}

function csv(value: string): string[] {
  return value
    .split(',')
    .map((row) => row.trim().replace(/\\/g, '/'))
    .filter(Boolean);
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function extractJson(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return undefined;
}

function cloneTicket(row: GraphTicket): GraphTicket {
  return {
    ...row,
    signals: {
      ...(row.signals.repo ? { repo: row.signals.repo } : {}),
      paths: [...(row.signals.paths ?? [])],
      refs: [...(row.signals.refs ?? [])],
      commits: [...(row.signals.commits ?? [])],
      fingerprints: [...(row.signals.fingerprints ?? [])],
      tokens: [...(row.signals.tokens ?? [])],
    },
    members: [...(row.members ?? [])],
    blocked: [...(row.blocked ?? [])],
  };
}

function cloneEdge(row: GraphEdge): GraphEdge {
  return { ...row };
}
