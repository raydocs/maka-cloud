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

/** The `web-search` program for the sandbox. */
export interface WebSearchSandboxTool {
  name: 'web-search';
  content: Buffer;
}

/**
 * The `web-search` CLI as one file (`dist/web-search.mjs`), for runs whose model access carries
 * a search URL (`MAKA_SEARCH_URL`, `MAKA_SEARCH_TOKEN`). Each search goes through the model
 * gateway and is paid from the task's budget; its results are printed as web text, framed so
 * the agent reads them as data.
 */
export async function webSearchSandboxTool(): Promise<WebSearchSandboxTool> {
  const content = await readFile(new URL('./web-search.mjs', import.meta.url));
  return { name: 'web-search', content };
}
