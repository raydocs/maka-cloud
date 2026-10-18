import { renderMarkdown } from './report.js';
import { executeRun, RUNS, type RunResult } from './runs.js';

/** Run every setting against the fake endpoint and print the Markdown report. */
const results: RunResult[] = [];
for (const definition of RUNS) results.push(await executeRun(definition));
process.stdout.write(`${renderMarkdown(results)}\n`);
