/**
 * The citation checker without the playbook, the file system or the conductor:
 * pure functions over text, for callers that run the check somewhere else (the
 * supervisor), and the renderer, so a caller can reproduce the report a check
 * delivered instead of trusting its text. Fetching sources is the caller's job.
 */
export * from './research/check.js';
export * from './research/record.js';
export * from './research/render.js';
export * from './research/report-schema.js';
export * from './research/source-text.js';
export * from './research/summary-line.js';
