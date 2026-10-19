import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CitationInputError,
  type CheckResult,
  type SourceText,
  checkCitations,
  passed,
} from './check.js';
import { renderReport } from './render.js';
import {
  type Judgment,
  JudgmentsSchema,
  type Report,
  ReportSchema,
  claimsOf,
} from './report-schema.js';
import { htmlToText } from './source-text.js';
import { formatCiteCheckLine } from './summary-line.js';

export const MAX_REPORT_BYTES = 2 * 1024 * 1024;
export const MAX_JUDGMENTS_BYTES = 1024 * 1024;
export const MAX_SOURCE_BYTES = 5 * 1024 * 1024;

const USAGE =
  'usage: cite-check --report <report.json> --sources <dir> --out <dir> [--judgments <judgments.json>] [--drop-unsupported]';

export interface RunOutcome {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

class InputError extends Error {}

interface Args {
  report: string;
  sources: string;
  out: string;
  judgments?: string;
  dropUnsupported: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  let dropUnsupported = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] as string;
    if (flag === '--drop-unsupported') {
      dropUnsupported = true;
    } else if (['--report', '--sources', '--out', '--judgments'].includes(flag)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--'))
        throw new InputError(`${flag} needs a value`);
      values.set(flag, value);
      i += 1;
    } else {
      throw new InputError(`unknown argument "${flag}"`);
    }
  }
  const report = values.get('--report');
  const sources = values.get('--sources');
  const out = values.get('--out');
  if (!report || !sources || !out)
    throw new InputError('--report, --sources and --out are required');
  const judgments = values.get('--judgments');
  return { report, sources, out, ...(judgments ? { judgments } : {}), dropUnsupported };
}

/**
 * Reads a regular file without following a symbolic link, up to `maxBytes`.
 * Resolves to undefined when the file does not exist.
 */
async function readRegularFile(path: string, maxBytes: number): Promise<Buffer | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ELOOP') throw new InputError(`${path} is a symbolic link`);
    throw new InputError(`${path} could not be opened`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new InputError(`${path} is not a regular file`);
    if (stat.size > maxBytes) throw new InputError(`${path} is larger than ${maxBytes} bytes`);
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) throw new InputError(`${path} is larger than ${maxBytes} bytes`);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readJson<T>(
  path: string,
  maxBytes: number,
  parse: (
    value: unknown,
  ) => { success: true; data: T } | { success: false; error: { message: string } },
): Promise<T> {
  const bytes = await readRegularFile(path, maxBytes);
  if (!bytes) throw new InputError(`${path} does not exist`);
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new InputError(`${path} is not valid JSON`);
  }
  const parsed = parse(json);
  if (!parsed.success) throw new InputError(`${path} is invalid: ${parsed.error.message}`);
  return parsed.data;
}

interface LoadedSource extends SourceText {
  file: string;
  sha256: string;
  bytes: number;
}

/** Source texts are `<dir>/<id>.txt`, or `.html`/`.htm` converted to text. Ids are validated names, never paths. */
async function loadSources(dir: string, report: Report): Promise<LoadedSource[]> {
  const loaded: LoadedSource[] = [];
  for (const source of report.sources) {
    for (const extension of ['.txt', '.html', '.htm']) {
      const file = `${source.id}${extension}`;
      const bytes = await readRegularFile(join(dir, file), MAX_SOURCE_BYTES);
      if (!bytes) continue;
      const raw = bytes.toString('utf8');
      loaded.push({
        id: source.id,
        text: extension === '.txt' ? raw : htmlToText(raw),
        file,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
      });
      break;
    }
  }
  return loaded;
}

/** Writes through a temporary name and a rename, so a link planted at the target is replaced, never followed. */
async function writeOutput(dir: string, name: string, content: string): Promise<void> {
  const temporary = join(dir, `.${name}.${process.pid}.tmp`);
  await writeFile(temporary, content, { flag: 'w', mode: 0o644 });
  await rename(temporary, join(dir, name));
}

function verificationRecord(
  result: CheckResult,
  sources: readonly LoadedSource[],
  dropUnsupported: boolean,
  removed: readonly string[],
) {
  return {
    version: 1,
    mode: dropUnsupported ? 'drop_unsupported' : 'keep',
    counts: { ...result.counts, removed: removed.length },
    entailment:
      result.counts.judged === 0
        ? 'not_judged'
        : result.counts.judged === result.counts.total
          ? 'judged_all'
          : 'judged_some',
    claims: result.claims.map((claim) => ({
      id: claim.id,
      status: claim.status,
      reasons: claim.reasons,
      judged: claim.judged,
      removed: removed.includes(claim.id),
    })),
    unknownJudgments: result.unknownJudgments,
    sources: sources.map(({ id, file, sha256, bytes }) => ({ id, file, sha256, bytes })),
  };
}

/**
 * The `cite-check` command. Exit 0: every claim left in the report passed.
 * Exit 1: the check ran and a failed claim remains (or nothing is left).
 * Exit 2: the inputs were unusable and nothing was written.
 */
export async function runCiteCheck(argv: readonly string[]): Promise<RunOutcome> {
  try {
    const args = parseArgs(argv);
    const report = await readJson(args.report, MAX_REPORT_BYTES, (value) =>
      ReportSchema.safeParse(value),
    );
    const judgments: Judgment[] = args.judgments
      ? await readJson(args.judgments, MAX_JUDGMENTS_BYTES, (value) =>
          JudgmentsSchema.safeParse(value),
        )
      : [];
    const sources = await loadSources(args.sources, report);
    const result = checkCitations({ claims: claimsOf(report), sources, judgments });
    const rendered = renderReport(report, result, { dropFailed: args.dropUnsupported });

    await mkdir(args.out, { recursive: true });
    if ((await realpath(args.report)) === join(await realpath(args.out), 'report.json')) {
      throw new InputError('--out would overwrite --report');
    }
    await writeOutput(args.out, 'report.md', rendered.markdown);
    await writeOutput(args.out, 'report.html', rendered.html);
    // The report that was checked, whole: the claims a check of the delivery reads, dropped ones included.
    await writeOutput(args.out, 'report.json', `${JSON.stringify(report, null, 2)}\n`);
    await writeOutput(
      args.out,
      'verification.json',
      `${JSON.stringify(verificationRecord(result, sources, args.dropUnsupported, rendered.removed), null, 2)}\n`,
    );

    const lines: string[] = [];
    for (const claim of result.claims.filter((entry) => !passed(entry.status))) {
      lines.push(`claim ${claim.id}: ${claim.status}: ${claim.reasons.join('; ')}`);
    }
    for (const id of result.unknownJudgments)
      lines.push(`judgment for unknown claim ${id} ignored`);
    const { counts } = result;
    lines.push(
      formatCiteCheckLine({
        claims: counts.total,
        verified: counts.verified,
        quoteVerified: counts.quoteVerified,
        failed: counts.failed,
        removed: rendered.removed.length,
        judged: counts.judged,
      }),
    );
    const remaining = counts.total - rendered.removed.length;
    const clean = counts.failed - rendered.removed.length === 0 && remaining > 0;
    return { exitCode: clean ? 0 : 1, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (error) {
    if (error instanceof InputError || error instanceof CitationInputError) {
      return { exitCode: 2, stdout: '', stderr: `cite-check: ${error.message}\n${USAGE}\n` };
    }
    throw error;
  }
}
