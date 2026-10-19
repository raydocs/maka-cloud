import { createHash } from 'node:crypto';
import {
  type CheckResult,
  type Claim,
  type Judgment,
  type Report,
  ReportSchema,
  type SourceText,
  checkCitations,
  claimsOf,
  htmlToText,
  passed,
  type VerificationRecord,
  VerificationRecordSchema,
  renderFromRecord,
} from '@maka-cloud/playbooks/citations';
import { z } from 'zod';
import type { SignalManifest } from '../events.js';
import { clip } from '../text.js';
import { raceAbort } from './abort.js';
import type { FetchOutcome, SourceFetcher } from './fetcher.js';
import type { ArtifactRead, Mismatch } from './ports.js';

/**
 * The checks that need no model, and the claims that are left for one. Each
 * `prepare*` reads the task's artifacts and returns:
 *
 * - `failures`: what the evidence contradicts. Final: no model output can undo them.
 * - `unavailable`: what could not be read, so the check is incomplete.
 * - `claims` and `evidence`: what a model is asked about, when nothing failed.
 * - `mismatches`: turns the model's verdicts into failures.
 */

export interface ModelClaim {
  id: string;
  text: string;
}

export interface ModelEvidence {
  ref: string;
  text: string;
}

export type Verdict = 'supported' | 'unsupported' | 'contradicted';

export interface Unavailable {
  reason: string;
  /** A later attempt may succeed. */
  transient: boolean;
}

export interface Prepared {
  failures: Mismatch[];
  unavailable: Unavailable[];
  /**
   * What stops the delivered work from being tied to what was checked: a file
   * that is ambiguous, missing or not what the trusted renderer makes. Nothing
   * is checked past it, and the result is never shown as independently checked.
   */
  unverified: string[];
  claims: ModelClaim[];
  evidence: ModelEvidence[];
  mismatches(verdicts: ReadonlyMap<string, { verdict: Verdict; reason: string }>): Mismatch[];
}

export type ReadArtifact = (
  name: string,
) => Promise<ArtifactRead | { ok: false; reason: 'not_listed' | 'ambiguous' }>;

const MAX_CLAIMS = 150;
const MAX_PATCH_CHARS = 40_000;
const MAX_RECORD_CHARS = 4_000;
const MAX_CHANGED_FILES = 200;

function gitBlobSha(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

function unreadable(
  name: string,
  read: Exclude<Awaited<ReturnType<ReadArtifact>>, { ok: true }>,
): {
  failure?: Mismatch;
  unavailable?: Unavailable;
  unverified?: string;
} {
  if (read.reason === 'ambiguous') {
    return {
      unverified: `${name} is listed more than once or as a link, so which one was delivered is unknown`,
    };
  }
  if (read.reason === 'not_found' || read.reason === 'not_listed') {
    return {
      failure: {
        claim: `${name} was delivered`,
        found:
          read.reason === 'not_listed'
            ? `${name} is not among the task's artifacts`
            : `${name} does not exist`,
      },
    };
  }
  return {
    unavailable: {
      reason:
        read.reason === 'too_large' ? `${name} is too large to check` : `${name} could not be read`,
      transient: read.reason === 'unavailable',
    },
  };
}

// ---------------------------------------------------------------- coding

const TestRecord = z
  .object({ result: z.enum(['verified', 'failed']), testCommand: z.string().optional() })
  .passthrough();

const ChangedFile = z.discriminatedUnion('status', [
  z.object({
    path: z.string(),
    status: z.enum(['added', 'modified']),
    mode: z.string(),
    blobSha: z.string(),
    contentBase64: z.string(),
  }),
  z.object({ path: z.string(), status: z.literal('deleted') }),
]);
const ChangeSet = z
  .object({ repo: z.string(), baseSha: z.string(), files: z.array(ChangedFile).max(5000) })
  .passthrough();

export async function prepareCoding(input: {
  manifest: SignalManifest;
  read: ReadArtifact;
}): Promise<Prepared> {
  const { manifest, read } = input;
  const failures: Mismatch[] = [];
  const unavailable: Unavailable[] = [];
  const unverified: string[] = [];
  const evidence: ModelEvidence[] = [];

  const record = await read('verification.json');
  if (!record.ok) {
    const problem = unreadable('verification.json', record);
    if (problem.failure) {
      failures.push({ claim: 'the change was tested', found: 'there is no record of a test run' });
    }
    if (problem.unavailable) unavailable.push(problem.unavailable);
    if (problem.unverified) unverified.push(problem.unverified);
  } else {
    const parsed = parseJson(record.text, TestRecord);
    if (!parsed) {
      failures.push({
        claim: 'the change was tested',
        found: 'the record of the test run cannot be read',
      });
    } else {
      if (parsed.result !== 'verified') {
        failures.push({
          claim: 'the change passes its tests',
          found: `the test run is recorded as "${parsed.result}"${parsed.testCommand ? ` (command: ${clip(parsed.testCommand, 120)})` : ''}`,
        });
      }
      evidence.push({ ref: 'verification.json', text: clip(record.text, MAX_RECORD_CHARS) });
    }
  }

  const changes = await read('changes.json');
  if (!changes.ok) {
    const problem = unreadable('changes.json', changes);
    if (problem.failure) failures.push(problem.failure);
    if (problem.unavailable) unavailable.push(problem.unavailable);
    if (problem.unverified) unverified.push(problem.unverified);
  } else {
    const parsed = parseJson(changes.text, ChangeSet);
    if (!parsed) {
      failures.push({
        claim: 'the change set is well formed',
        found: 'changes.json cannot be read',
      });
    } else if (parsed.files.length === 0) {
      failures.push({ claim: 'the task made a change', found: 'the change set has no files' });
    } else {
      for (const file of parsed.files) {
        if (file.status === 'deleted') continue;
        const bytes = Buffer.from(file.contentBase64, 'base64');
        if (gitBlobSha(bytes) !== file.blobSha) {
          failures.push({
            claim: `${clip(file.path, 120)} is part of the change`,
            found: 'its content does not match the recorded hash',
          });
        }
      }
      const listed = parsed.files
        .slice(0, MAX_CHANGED_FILES)
        .map((file) => `${file.status} ${file.path}`);
      evidence.push({
        ref: 'changes.json',
        text: clip(
          `${parsed.files.length} files changed in ${parsed.repo}:\n${listed.join('\n')}`,
          MAX_RECORD_CHARS,
        ),
      });
    }
  }

  const patch = await read('change.patch');
  if (!patch.ok) {
    const problem = unreadable('change.patch', patch);
    if (problem.failure) failures.push(problem.failure);
    if (problem.unavailable) unavailable.push(problem.unavailable);
    if (problem.unverified) unverified.push(problem.unverified);
  } else if (patch.text.trim() === '') {
    failures.push({ claim: 'the task made a change', found: 'change.patch is empty' });
  } else {
    evidence.push({ ref: 'change.patch', text: patch.text.slice(0, MAX_PATCH_CHARS) });
  }

  const claims: ModelClaim[] = [
    { id: 'summary', text: clip(manifest.summary, 400) },
    ...manifest.done
      .slice(0, MAX_CLAIMS)
      .map((text, index) => ({ id: `done${index + 1}`, text: clip(text, 400) })),
  ];
  if (manifest.done.length > MAX_CLAIMS) {
    unavailable.push({ reason: `more than ${MAX_CLAIMS} claims to check`, transient: false });
  }
  return {
    failures,
    unavailable,
    unverified,
    claims,
    evidence,
    mismatches: (verdicts) =>
      claims.flatMap((claim) => {
        const verdict = verdicts.get(claim.id);
        return verdict && verdict.verdict !== 'supported'
          ? [{ claim: claim.text, found: clip(verdict.reason, 240) }]
          : [];
      }),
  };
}

// -------------------------------------------------------------- research

const FETCH_PARALLEL = 4;

const RENDERINGS = ['report.md', 'report.html'] as const;

/**
 * The renderings the task delivered. A name listed twice, a listed file that is
 * missing, or one that is too large is a problem; one that could not be read
 * right now is worth another attempt.
 */
async function deliveredRenderings(read: ReadArtifact): Promise<{
  delivered: Map<(typeof RENDERINGS)[number], Uint8Array>;
  problems: string[];
  unavailable: Unavailable[];
}> {
  const delivered = new Map<(typeof RENDERINGS)[number], Uint8Array>();
  const problems: string[] = [];
  const unavailable: Unavailable[] = [];
  for (const name of RENDERINGS) {
    const file = await read(name);
    if (file.ok) {
      delivered.set(name, file.bytes);
    } else if (file.reason === 'ambiguous') {
      problems.push(
        `${name} is listed more than once or as a link, so which one was delivered is unknown`,
      );
    } else if (file.reason === 'unavailable') {
      unavailable.push({ reason: `${name} could not be read`, transient: true });
    } else if (file.reason !== 'not_listed') {
      problems.push(
        `${name} is ${file.reason === 'not_found' ? 'listed but does not exist' : 'too large to check'}`,
      );
    }
  }
  return { delivered, problems, unavailable };
}

/**
 * Ties the delivered renderings to the report data. The record is written by
 * the agent, so it is only believed as far as it reproduces: the trusted
 * renderer, given report.json and the statuses the record states, must make
 * every delivered rendering exactly, byte for byte. The claims it returns as
 * removed are the ones the human is not shown, not ones that go unchecked.
 */
function reproduceDelivery(
  report: Report,
  all: readonly Claim[],
  record: VerificationRecord | undefined,
  delivered: ReadonlyMap<(typeof RENDERINGS)[number], Uint8Array>,
): { removed: Set<string> } | { problem: string } {
  if (!record) return { problem: 'verification.json is missing or unreadable' };
  const ids = new Set(all.map((claim) => claim.id));
  const stated = new Set(record.claims.map((claim) => claim.id));
  if (
    stated.size !== record.claims.length ||
    stated.size !== ids.size ||
    ![...ids].every((id) => stated.has(id))
  ) {
    return { problem: 'verification.json does not list exactly the claims of report.json' };
  }
  const drop = record.mode === 'drop_unsupported';
  if (record.claims.some((claim) => claim.removed !== (drop && !passed(claim.status)))) {
    return { problem: 'verification.json removes claims that its own statuses do not fail' };
  }
  let rendered: ReturnType<typeof renderFromRecord>;
  try {
    rendered = renderFromRecord(report, record);
  } catch {
    return { problem: 'report.json cannot be rendered' };
  }
  const expected = { 'report.md': rendered.markdown, 'report.html': rendered.html };
  for (const [name, bytes] of delivered) {
    // Raw bytes: decoded text would equate an invalid byte with the replacement character.
    if (Buffer.compare(Buffer.from(bytes), Buffer.from(expected[name], 'utf8')) !== 0) {
      return { problem: `${name} is not what the renderer makes from report.json` };
    }
  }
  return {
    removed: new Set(record.claims.filter((claim) => claim.removed).map((claim) => claim.id)),
  };
}

export async function prepareResearch(input: {
  read: ReadArtifact;
  fetcher: SourceFetcher;
  signal: AbortSignal;
  maxSources: number;
}): Promise<Prepared> {
  const { read, fetcher, signal, maxSources } = input;
  const failures: Mismatch[] = [];
  const unavailable: Unavailable[] = [];
  const unverified: string[] = [];
  const empty = (): Prepared => ({
    failures,
    unavailable,
    unverified,
    claims: [],
    evidence: [],
    mismatches: () => [],
  });

  const reportFile = await read('report.json');
  if (!reportFile.ok) {
    // The research check is in scope only because a report artifact is listed: without report.json
    // there is nothing to reproduce it from.
    if (reportFile.reason === 'not_listed') {
      unverified.push('a report is listed without report.json, so it cannot be reproduced');
      return empty();
    }
    const problem = unreadable('report.json', reportFile);
    if (problem.failure) failures.push(problem.failure);
    if (problem.unavailable) unavailable.push(problem.unavailable);
    if (problem.unverified) unverified.push(problem.unverified);
    return empty();
  }
  const parsedJson = parseJson(reportFile.text, ReportSchema);
  if (!parsedJson) {
    failures.push({ claim: 'the report data is well formed', found: 'report.json cannot be read' });
    return empty();
  }
  const report: Report = parsedJson;

  // report.json is the source of truth and every claim in it is checked.
  // verification.json and the renderings are written by the agent, so the
  // renderings count only when the trusted renderer reproduces them from
  // report.json and the record, exactly.
  const all = claimsOf(report);
  if (all.length === 0) {
    failures.push({ claim: 'the report makes claims', found: 'the report has no claims to check' });
    return empty();
  }
  const seen = new Set<string>();
  for (const claim of all) {
    if (seen.has(claim.id)) {
      failures.push({
        claim: 'every claim has its own id',
        found: `the claim id "${clip(claim.id, 64)}" is used more than once`,
      });
      return empty();
    }
    seen.add(claim.id);
  }

  let removed = new Set<string>();
  const delivery = await deliveredRenderings(read);
  unverified.push(...delivery.problems);
  unavailable.push(...delivery.unavailable);
  if (delivery.delivered.size > 0 && unverified.length === 0 && unavailable.length === 0) {
    const exported = await read('verification.json');
    if (!exported.ok && exported.reason === 'unavailable') {
      unavailable.push({ reason: 'verification.json could not be read', transient: true });
    } else {
      const proven = reproduceDelivery(
        report,
        all,
        exported.ok ? parseJson(exported.text, VerificationRecordSchema) : undefined,
        delivery.delivered,
      );
      if ('problem' in proven) unverified.push(proven.problem);
      else removed = proven.removed;
    }
  }
  if (unverified.length > 0 || unavailable.length > 0) return empty();

  // The checked set is exactly the claims of report.json. The record only says what the
  // playbook left out of the renderings: it can never take a claim out of the check.
  const claims: Claim[] = all;
  if (removed.size >= all.length) {
    failures.push({
      claim: 'the report keeps claims',
      found: 'no claim is left in the delivered report',
    });
    return empty();
  }
  if (claims.length > MAX_CLAIMS) {
    unavailable.push({ reason: `more than ${MAX_CLAIMS} claims to check`, transient: false });
    return empty();
  }

  // Fetch each cited source once.
  const cited = [
    ...new Set(claims.flatMap((claim) => claim.citations.map((citation) => citation.sourceId))),
  ];
  const sourceById = new Map(report.sources.map((source) => [source.id, source]));
  const texts: SourceText[] = [];
  const skipped = new Set<string>();
  const toFetch = cited.slice(0, maxSources);
  for (const id of cited.slice(maxSources)) skipped.add(id);
  if (skipped.size > 0) {
    unavailable.push({
      reason: `more than ${maxSources} cited sources to fetch`,
      transient: false,
    });
  }
  let next = 0;
  const worker = async () => {
    while (next < toFetch.length && !signal.aborted) {
      const id = toFetch[next++] as string;
      const source = sourceById.get(id);
      if (!source) continue; // reported below as source_missing by the citation check
      let outcome: FetchOutcome;
      try {
        // A fetcher that ignores the signal still cannot hold the check past it.
        outcome = await raceAbort(fetcher.fetchText(source.url, signal), signal);
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      if (outcome.ok) {
        const text = outcome.contentType === 'text/plain' ? outcome.text : htmlToText(outcome.text);
        texts.push({ id, text });
        continue;
      }
      skipped.add(id);
      const host = hostOf(source.url);
      if (
        outcome.reason === 'http_status' &&
        outcome.status !== undefined &&
        outcome.status >= 400 &&
        outcome.status < 500 &&
        outcome.status !== 429 &&
        outcome.status !== 408
      ) {
        failures.push({
          claim: `the source ${host} can be opened`,
          found: `the cited page answered ${outcome.status}`,
        });
      } else if (outcome.reason === 'blocked' || outcome.reason === 'bad_url') {
        failures.push({
          claim: `the source ${host} can be opened`,
          found: 'the cited address cannot be fetched safely',
        });
      } else {
        unavailable.push({
          reason: `the source ${host} could not be fetched (${outcome.reason})`,
          transient: !['unsupported_type', 'too_large'].includes(outcome.reason),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_PARALLEL, toFetch.length) }, worker));
  if (signal.aborted) {
    unavailable.push({ reason: 'the check was stopped', transient: true });
    return empty();
  }

  // Claims that rest on a source that was not fetched are neither passed nor failed here.
  const checkable = claims.filter(
    (claim) => !claim.citations.some((citation) => skipped.has(citation.sourceId)),
  );
  const blocked = claims.length - checkable.length;
  if (blocked > 0 && failures.length === 0 && unavailable.length === 0) {
    unavailable.push({
      reason: `${blocked} claims rest on sources that were not fetched`,
      transient: true,
    });
  }
  const mechanical = checkCitations({ claims: checkable, sources: texts });
  const byId = new Map(checkable.map((claim) => [claim.id, claim]));
  for (const result of mechanical.claims) {
    if (passed(result.status)) continue;
    failures.push({
      claim: clip(byId.get(result.id)?.text ?? result.id, 240),
      found: clip(result.reasons.join('; ') || result.status, 240),
    });
  }

  const toJudge = mechanical.claims
    .filter((result) => passed(result.status))
    .map((result) => byId.get(result.id) as Claim);
  const modelClaims: ModelClaim[] = toJudge.map((claim) => ({
    id: claim.id,
    text: clip(claim.text, 500),
  }));
  const evidence: ModelEvidence[] = toJudge.map((claim) => ({
    ref: claim.id,
    text: claim.citations.map((citation) => clip(citation.quote, 1000)).join('\n---\n'),
  }));
  return {
    failures,
    unavailable,
    unverified,
    claims: modelClaims,
    evidence,
    mismatches: (verdicts) => {
      const judgments: Judgment[] = [];
      for (const claim of toJudge) {
        const verdict = verdicts.get(claim.id);
        if (verdict) {
          judgments.push({
            claimId: claim.id,
            entailed: verdict.verdict === 'supported',
            reason: clip(verdict.reason, 900) || 'the quote does not support the claim',
          });
        }
      }
      const judged: CheckResult = checkCitations({ claims: toJudge, sources: texts, judgments });
      return judged.claims
        .filter((result) => !passed(result.status))
        .map((result) => ({
          claim: clip(byId.get(result.id)?.text ?? result.id, 240),
          found: clip(result.reasons.join('; ') || result.status, 240),
        }));
    },
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'a cited source';
  }
}

function parseJson<T extends z.ZodTypeAny>(text: string, schema: T): z.infer<T> | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
