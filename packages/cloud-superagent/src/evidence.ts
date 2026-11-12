import type { EvidenceBlock } from './types.js';

const MAX_BODY = 2_000;
const MAX_BLOCKS = 20;

export function clipEvidence(block: EvidenceBlock): EvidenceBlock {
  const body = block.body.length > MAX_BODY ? `${block.body.slice(0, MAX_BODY)}…` : block.body;
  return {
    kind: block.kind,
    label: block.label.slice(0, 120),
    body,
    ...(block.path ? { path: block.path.slice(0, 240) } : {}),
  };
}

export function mergeEvidence(
  current: readonly EvidenceBlock[],
  incoming: readonly EvidenceBlock[],
): EvidenceBlock[] {
  return [...current, ...incoming.map(clipEvidence)].slice(-MAX_BLOCKS);
}

/** Worker output: a short proof list for a PR body or a stuck card. */
export function formatEvidence(blocks: readonly EvidenceBlock[]): string {
  if (blocks.length === 0) return '';
  const lines = ['### Evidence'];
  for (const block of blocks) {
    const where = block.path ? ` \`${block.path}\`` : '';
    lines.push(`- **${block.kind}** ${block.label}${where}`);
    if (block.body.trim()) {
      lines.push('```');
      lines.push(block.body.trimEnd());
      lines.push('```');
    }
  }
  return lines.join('\n');
}
