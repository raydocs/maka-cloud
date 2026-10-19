import { readFile } from 'node:fs/promises';

/** A program for the sandbox: a single self-contained file, installed on the runner's PATH under `name`. */
export interface CiteCheckSandboxTool {
  name: 'cite-check';
  content: Buffer;
}

/**
 * The `cite-check` CLI as one file for `createCloudRunners({ sandboxTools })`. It is the bundle the
 * package build writes next to this module (`dist/cite-check.mjs`), so it needs only `node` in the
 * sandbox.
 */
export async function citeCheckSandboxTool(): Promise<CiteCheckSandboxTool> {
  const content = await readFile(new URL('./cite-check.mjs', import.meta.url));
  return { name: 'cite-check', content };
}
