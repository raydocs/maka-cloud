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
  normalizeText,
  passed,
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
  claims: ModelClaim[];
  evidence: ModelEvidence[];
  mismatches(verdicts: ReadonlyMap<string, { verdict: Verdict; reason: string }>): Mismatch[];
}

export type ReadArtifact = (
  name: string,
) => Promise<ArtifactRead | { ok: false; reason: 'not_listed' }>;

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
} {
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
  const evidence: ModelEvidence[] = [];

  const record = await read('verification.json');
  if (!record.ok) {
    const problem = unreadable('verification.json', record);
    if (problem.failure) {
      failures.push({ claim: 'the change was tested', found: 'there is no record of a test run' });
    }
    if (problem.unavailable) unavailable.push(problem.unavailable);
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

const RemovedRecord = z
  .object({
    claims: z.array(
      z
        .object({
          id: z.string(),
          status: z.string().optional(),
          removed: z.boolean().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const FETCH_PARALLEL = 4;

/** The statuses a claim has when it failed the cite-check, the only ones a removal can rest on. */
const FAILING = new Set([
  'unsupported',
  'quote_not_found',
  'number_mismatch',
  'source_missing',
  'quote_too_short',
  'no_citation',
]);

export async function prepareResearch(input: {
  read: ReadArtifact;
  fetcher: SourceFetcher;
  signal: AbortSignal;
  maxSources: number;
}): Promise<Prepared> {
  const { read, fetcher, signal, maxSources } = input;
  const failures: Mismatch[] = [];
  const unavailable: Unavailable[] = [];
  const empty = (): Prepared => ({
    failures,
    unavailable,
    claims: [],
    evidence: [],
    mismatches: () => [],
  });

  const reportFile = await read('report.json');
  if (!reportFile.ok) {
    const problem = unreadable('report.json', reportFile);
    if (problem.failure) failures.push(problem.failure);
    if (problem.unavailable) unavailable.push(problem.unavailable);
    return empty();
  }
  const parsedJson = parseJson(reportFile.text, ReportSchema);
  if (!parsedJson) {
    failures.push({ claim: 'the report data is well formed', found: 'report.json cannot be read' });
    return empty();
  }
  const report: Report = parsedJson;

  // Claims the playbook already dropped are not in the report the human reads.
  // verification.json is written by the agent, so it never narrows the check by
  // itself: a removal counts only when the record shows the claim failing and the
  // delivered report, which the human reads, does not show it in its body.
  const all = claimsOf(report);
  if (all.length === 0) {
    failures.push({ claim: 'the report makes claims', found: 'the report has no claims to check' });
    return empty();
  }
  const inReport = new Map(all.map((claim) => [claim.id, claim]));
  const removed = new Set<string>();
  const candidates: Claim[] = [];
  const exported = await read('verification.json');
  if (exported.ok) {
    const record = parseJson(exported.text, RemovedRecord);
    for (const entry of record?.claims ?? []) {
      if (!entry.removed) continue;
      const claim = inReport.get(entry.id);
      if (!claim) {
        failures.push({
          claim: 'the record only removes claims of the report',
          found: `the record removes "${clip(entry.id, 64)}", which is not in the report`,
        });
      } else if (!FAILING.has(entry.status ?? '')) {
        failures.push({
          claim: clip(claim.text, 240),
          found: 'it was removed from the check, but the record does not show it failing',
        });
      } else {
        candidates.push(claim);
        continue;
      }
      removed.add(entry.id);
    }
  }
  if (candidates.length > 0) {
    // Without a rendering that can be read in full, nothing shows a claim is gone: all stay checked.
    const shown = await shownInDelivery(read, candidates);
    if (shown) {
      for (const claim of candidates) if (!shown.has(claim.id)) removed.add(claim.id);
    }
  }
  const claims: Claim[] = all.filter((claim) => !removed.has(claim.id));
  if (claims.length === 0) {
    failures.push({
      claim: 'the report keeps claims',
      found: 'no claim is left after the removals',
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

/**
 * The ids of `claims` that a delivered rendering (report.md, report.html) shows
 * in its body, above the "Not verified" list that names what was left out. Or
 * undefined when no rendering is listed, or a listed one cannot be read: then
 * the delivered text proves nothing about what the human reads.
 */
async function shownInDelivery(
  read: ReadArtifact,
  claims: readonly Claim[],
): Promise<Set<string> | undefined> {
  const bodies: string[] = [];
  for (const [name, cutAt, toText] of [
    ['report.md', /^##\s+Not verified\s*$/mu, (text: string) => text],
    ['report.html', /<h2>\s*Not verified\s*<\/h2>/iu, htmlToText],
  ] as const) {
    const file = await read(name);
    if (!file.ok) {
      if (file.reason === 'not_listed') continue;
      return undefined;
    }
    const cut = file.text.search(cutAt);
    bodies.push(normalizeText(toText(cut < 0 ? file.text : file.text.slice(0, cut))));
  }
  if (bodies.length === 0) return undefined;
  const shown = new Set<string>();
  for (const claim of claims) {
    // Markdown escapes angle brackets; HTML text is decoded, so it matches the plain form.
    const forms = [claim.text, claim.text.replace(/</gu, '&lt;').replace(/>/gu, '&gt;')].map(
      normalizeText,
    );
    if (bodies.some((body) => forms.some((form) => body.includes(form)))) shown.add(claim.id);
  }
  return shown;
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
