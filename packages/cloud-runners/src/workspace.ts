import {
  createWorkspaceStore,
  type WorkspaceHandle,
  type WorkspaceSpec,
  type WorkspaceStore,
} from '@maka-cloud/superagent';

export {
  createWorkspaceStore,
  GitCloneStore,
  initLocalRepo,
  LayerFsDisabledError,
  LayerFsMountUnsupportedError,
  LayerFsStore,
  type SnapshotRef,
  type WorkspaceHandle,
  type WorkspaceSpec,
  type WorkspaceStore,
} from '@maka-cloud/superagent';

/** `MAKA_CLOUD_LAYERFS=1` selects the metadata LayerFS adapter. Default: GitCloneStore. */
export function workspaceStoreFromEnv(env: NodeJS.ProcessEnv = process.env): WorkspaceStore {
  return createWorkspaceStore({ layerfs: env.MAKA_CLOUD_LAYERFS === '1' });
}

export async function prepareWorkspace(
  store: WorkspaceStore,
  spec: WorkspaceSpec,
): Promise<WorkspaceHandle> {
  return store.prepare(spec);
}
