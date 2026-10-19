import { InstaboxClient, DEFAULT_INSTABOX_BASE_URL } from './client.js';
import { InstaboxWorkspaceExecutor } from './executor.js';

export {
  DEFAULT_INSTABOX_BASE_URL,
  InstaboxClient,
  type InstaboxClientOptions,
  type InstaboxExecRequest,
  type InstaboxExecResult,
  type InstaboxFiles,
  type InstaboxMachine,
  type InstaboxMachineState,
  type InstaboxOperation,
} from './client.js';
export {
  InstaboxApiError,
  InstaboxOperationError,
  InstaboxTransportError,
  type InstaboxErrorEnvelope,
} from './errors.js';
export {
  INSTABOX_MAX_FILE_BYTES,
  InstaboxWorkspaceExecutor,
  type InstaboxWorkspaceExecutorOptions,
} from './executor.js';
export { INSTABOX_WORKSPACE_EXECUTOR_FACTS } from './facts.js';

/** Reads `INSTABOX_API_KEY`, `INSTABOX_MACHINE_ID` and optionally `INSTABOX_API_URL`. */
export function createInstaboxWorkspaceExecutorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): InstaboxWorkspaceExecutor {
  const apiKey = env.INSTABOX_API_KEY;
  const machineId = env.INSTABOX_MACHINE_ID;
  if (!apiKey) throw new Error('INSTABOX_API_KEY is not set.');
  if (!machineId) throw new Error('INSTABOX_MACHINE_ID is not set.');
  return new InstaboxWorkspaceExecutor({
    client: new InstaboxClient({
      apiKey,
      baseUrl: env.INSTABOX_API_URL ?? DEFAULT_INSTABOX_BASE_URL,
    }),
    machineId,
  });
}
