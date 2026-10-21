import type { SignalManifest } from '../events.js';

export type VerificationKind = 'coding' | 'research';

export function isLink(ref: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(ref) || ref.startsWith('//');
}

function decoded(text: string): string {
  let current = text;
  // An encoding inside an encoding (%2572) is still one name.
  for (let pass = 0; pass < 4; pass++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return current;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}

/**
 * A loose reading of an artifact's name: the path of a link or a local path,
 * without a query or fragment, percent-decoded, normalized and case-folded. It
 * is only ever used to notice that something might be a change or a report; it
 * never accepts one. What is accepted is decided by the allowlists below.
 */
function looseName(ref: string): string {
  let path = ref.replace(/[?#].*$/su, '');
  if (isLink(ref)) {
    try {
      path = new URL(ref.startsWith('//') ? `https:${ref}` : ref).pathname;
    } catch {
      // keep the path as cut above
    }
  }
  const last = decoded(path)
    .split(/[\\/]/u)
    .filter((part) => part !== '')
    .pop();
  return (last ?? '')
    .normalize('NFKC')
    .replace(/[.\s]+$/u, '')
    .toLowerCase();
}

const CODING_FILES: ReadonlySet<string> = new Set([
  'changes.json',
  'change.patch',
  'verification.json',
  // The review of the change. The coding check ties it to the runner's record by its hash.
  'review.md',
]);
const RESEARCH_FILES: ReadonlySet<string> = new Set([
  'report.json',
  'report.md',
  'report.html',
  'verification.json',
]);
const CODING_TRIGGERS = ['changes.json', 'change.patch'];
/** Everything either check could take for a change or a report, in any spelling. */
const RELATED = [
  ...CODING_TRIGGERS,
  'report.json',
  'report.md',
  'report.html',
  'verification.json',
];

/**
 * The file name of a reference that is a plain local path, or undefined for
 * anything else: a link, or a reference with any character beyond ASCII letters,
 * digits, `.`, `_`, `-` and `/` (so no encoding, query, fragment, backslash,
 * control character or look-alike letter), or with an empty, `.` or `..` part.
 * The name is exact: the checks read these files by this spelling and no other.
 */
function plainName(ref: string): string | undefined {
  if (!/^\/?[A-Za-z0-9._/-]+$/u.test(ref)) return undefined;
  const parts = ref.replace(/^\//u, '').split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return undefined;
  return parts[parts.length - 1];
}

function everyRefIn(manifest: SignalManifest, allowed: ReadonlySet<string>): boolean {
  return (manifest.artifacts ?? []).every((ref) => {
    const name = plainName(ref);
    return name !== undefined && allowed.has(name);
  });
}

/**
 * The check a manifest may be given, by allowlist: coding only if every
 * artifact is one of the files the coding check reads and a change is among
 * them, research only if every artifact is one of the files the research check
 * reads and reproduces and `report.json` is among them. A link, a name that is
 * not spelled exactly, or one file of the other kind beside them leaves no
 * check that can stand for the task.
 */
export function acceptedKindOf(manifest: SignalManifest): VerificationKind | undefined {
  const plain = (manifest.artifacts ?? []).map(plainName);
  const hasChange = plain.some((name) => name !== undefined && CODING_TRIGGERS.includes(name));
  const hasReport = plain.includes('report.json');
  if (hasChange && !hasReport && everyRefIn(manifest, CODING_FILES)) return 'coding';
  if (hasReport && !hasChange && everyRefIn(manifest, RESEARCH_FILES)) return 'research';
  return undefined;
}

/**
 * Which check applies. A manifest that names a change or a report in any
 * spelling is checked, never skipped: if no check can stand for it exactly, it
 * is given the research check, which ends it as "checks reported by agent
 * (unverified)" before anything is read. Nothing resembling either kind means
 * there is nothing to check against.
 */
export function verificationKindOf(manifest: SignalManifest): VerificationKind | undefined {
  const accepted = acceptedKindOf(manifest);
  if (accepted !== undefined) return accepted;
  const related = (manifest.artifacts ?? []).some(
    (ref) => RELATED.includes(plainName(ref) ?? '') || RELATED.includes(looseName(ref)),
  );
  return related ? 'research' : undefined;
}

/**
 * Every reference to the file a check reads by this exact name. The check reads
 * only after `acceptedKindOf` has accepted the whole manifest, so every
 * reference here is a plain local path.
 */
export function refsFor(manifest: SignalManifest, name: string): string[] {
  return (manifest.artifacts ?? []).filter((ref) => plainName(ref) === name);
}
