import type { InstaboxClient } from './client.js';

/**
 * The part of a sandbox client that the runners, the workspace executor and the egress guard use.
 * `InstaboxClient` has it; another provider's adapter (boat.dev, `docs/fork/go-live-plan.md`
 * Phase 3.1) gives the same methods and throws the same error classes. The box pool's wider
 * `BoxApi` (`@maka-cloud/boxes`) stays instabox's for now.
 */
export type SandboxApi = Pick<
  InstaboxClient,
  | 'createSnapshot'
  | 'deleteActivityLease'
  | 'deleteSnapshot'
  | 'ensureRunning'
  | 'exec'
  | 'getFile'
  | 'getMachine'
  | 'putActivityLease'
  | 'waitForSnapshot'
>;
