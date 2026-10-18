import type { WorkspaceExecutorFacts } from '@maka/runtime/workspace-executor';

/**
 * An instabox sandbox is a separate machine: nothing written there reaches the
 * user's repository until a later push or pull request, so write-back is
 * `diff_review`. The executor forwards no host environment, so `secrets` is `none`
 * unless the sandbox owner configured Vault items (pass `facts` to override).
 */
export const INSTABOX_WORKSPACE_EXECUTOR_FACTS: WorkspaceExecutorFacts = {
  isolation: 'remote',
  writesAffectHost: false,
  writeBack: 'diff_review',
  network: 'sandbox',
  secrets: 'none',
};
