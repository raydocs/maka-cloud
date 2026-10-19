/**
 * The citation checker without the playbook, the file system or the conductor:
 * pure functions over text, for callers that run the check somewhere else (the
 * supervisor). Fetching sources is the caller's job.
 */
export * from './research/check.js';
export * from './research/report-schema.js';
export * from './research/source-text.js';
export * from './research/summary-line.js';
