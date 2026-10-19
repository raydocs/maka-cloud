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
 * The one way every artifact name is derived: the path of a link or a local
 * path alike, without a query or fragment, percent-decoded, normalized and
 * case-folded, so that `Report.JSON`, `report.json?download=1` and
 * `out%2Freport.json` are all `report.json`. Classifying, counting and reading
 * an artifact all go through here, so they cannot disagree.
 */
export function artifactName(ref: string): string {
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

const CHANGE_NAMES = ['changes.json', 'change.patch'];
const REPORT_NAMES = ['report.json', 'report.md', 'report.html'];

function namesOf(manifest: SignalManifest): Set<string> {
  return new Set((manifest.artifacts ?? []).map(artifactName));
}

function listsAny(names: ReadonlySet<string>, wanted: readonly string[]): boolean {
  return wanted.some((name) => names.has(name));
}

/**
 * Which check applies, from the artifact names alone. Anything that names a
 * report, in any form, brings the research check into scope, and only a change
 * the coding check positively recognizes selects the coding check. Nothing
 * recognized means there is nothing to check against.
 */
export function verificationKindOf(manifest: SignalManifest): VerificationKind | undefined {
  const names = namesOf(manifest);
  if (listsAny(names, REPORT_NAMES)) return 'research';
  if (listsAny(names, CHANGE_NAMES)) return 'coding';
  return undefined;
}

/**
 * Every reference a manifest lists for an artifact name, links included: a link
 * is something the human may be shown that cannot be read here, so it must be
 * counted, never skipped.
 */
export function refsFor(manifest: SignalManifest, name: string): string[] {
  return (manifest.artifacts ?? []).filter((ref) => artifactName(ref) === name);
}

/** Whether the manifest lists artifacts of both kinds of work, links included. */
export function listsBothKinds(manifest: SignalManifest): boolean {
  const names = namesOf(manifest);
  return listsAny(names, CHANGE_NAMES) && listsAny(names, REPORT_NAMES);
}
