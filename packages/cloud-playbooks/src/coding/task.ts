import { z } from 'zod';

export const VENDORS = ['claude-agent-sdk', 'codex'] as const;
export type Vendor = (typeof VENDORS)[number];

export function otherVendor(vendor: Vendor): Vendor {
  return vendor === 'claude-agent-sdk' ? 'codex' : 'claude-agent-sdk';
}

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;
/** Branch, tag or commit sha. No option-like or range-like names. */
const REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/u;

export const CodingTaskSchema = z
  .object({
    /** `owner/name` on GitHub. */
    repo: z.string().regex(REPO, 'repo must be "owner/name"'),
    /** Branch, tag or commit to start from. */
    baseRef: z.string().regex(REF, 'baseRef must be a branch, tag or commit sha'),
    /** The repository's own test command, run from the repository root. */
    testCommand: z.string().trim().min(1).max(2_000),
    /** What to change, in one or two sentences. */
    goal: z.string().trim().min(1).max(4_000),
    /** The vendor that tries first; the other one gets the task once if it fails. */
    runner: z.enum(VENDORS).optional(),
  })
  .strict();

export type CodingTask = z.infer<typeof CodingTaskSchema>;

const BLOCK = /```coding-task[ \t]*\r?\n([\s\S]*?)\r?\n```/gu;

export type ParsedBrief = { ok: true; task: CodingTask } | { ok: false; reason: string };

/** Reads the one fenced `coding-task` JSON block of a brief. */
export function parseCodingBrief(brief: string): ParsedBrief {
  const blocks = [...brief.matchAll(BLOCK)];
  if (blocks.length === 0) return { ok: false, reason: 'the brief has no ```coding-task block' };
  if (blocks.length > 1)
    return { ok: false, reason: 'the brief has more than one ```coding-task block' };
  let value: unknown;
  try {
    value = JSON.parse(blocks[0]?.[1] ?? '');
  } catch {
    return { ok: false, reason: 'the ```coding-task block is not valid JSON' };
  }
  const parsed = CodingTaskSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || 'block'}: ${issue.message}`,
    );
    return { ok: false, reason: `the \`\`\`coding-task block is invalid (${issues.join('; ')})` };
  }
  return { ok: true, task: parsed.data };
}

/** What the agent records about its reproduction test, in `repro.json` next to the workspace. */
export const ReproSchema = z
  .object({
    /** Runs only the reproduction test, from the repository root. */
    command: z.string().trim().min(1).max(2_000),
    /** The test files, relative to the repository root. */
    files: z.array(z.string().min(1).max(500)).min(1).max(20),
  })
  .strict();

export type Repro = z.infer<typeof ReproSchema>;

/** A path inside the repository: relative, no `..`, no `.git`. */
export function isRepoPath(path: string): boolean {
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.includes('\n'))
    return false;
  const parts = path.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..') && parts[0] !== '.git';
}
