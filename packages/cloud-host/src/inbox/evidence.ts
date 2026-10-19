import type { SupervisorParts } from '@maka-cloud/server';
import type { EvidenceSource } from '@maka-cloud/supervisor';

/**
 * Reads the artifacts a finished task listed, through the server's artifact source: the
 * host-side handoff directory, never the sandbox. Content is decoded as text; a file that is
 * not valid UTF-8 decodes with replacement characters and fails the check that parses it.
 */
export function artifactEvidence(parts: Pick<SupervisorParts, 'artifacts'>): EvidenceSource {
  return {
    async readArtifact(task, ref, signal) {
      try {
        const read = await parts.artifacts.read(task, ref, signal);
        if (!read.ok) return { ok: false, reason: read.reason };
        return { ok: true, text: read.bytes.toString('utf8') };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    },
  };
}
