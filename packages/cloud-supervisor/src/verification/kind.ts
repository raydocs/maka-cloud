import type { SignalManifest } from '../events.js';

export type VerificationKind = 'coding' | 'research';

function basename(ref: string): string {
  return ref.split(/[\\/]/u).pop() ?? '';
}

function isLink(ref: string): boolean {
  return /^https?:\/\//iu.test(ref);
}

/** Which check applies, from the artifact names alone. Nothing recognized means there is nothing to check against. */
export function verificationKindOf(manifest: SignalManifest): VerificationKind | undefined {
  const names = new Set((manifest.artifacts ?? []).filter((ref) => !isLink(ref)).map(basename));
  if (names.has('changes.json') || names.has('change.patch')) return 'coding';
  if (names.has('report.json')) return 'research';
  return undefined;
}

/** Every reference a manifest lists for an artifact name. Links are never read. */
export function refsFor(manifest: SignalManifest, name: string): string[] {
  return (manifest.artifacts ?? []).filter((ref) => !isLink(ref) && basename(ref) === name);
}
