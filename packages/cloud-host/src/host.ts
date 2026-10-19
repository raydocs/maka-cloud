import {
  CODING_PLAYBOOK,
  Conductor,
  type ConductorOptions,
  FREE_PLAYBOOK,
  type Playbook,
} from '@maka-cloud/conductor';
import { researchPlaybook } from '@maka-cloud/playbooks';
import { type CloudServer, type CloudServerOptions, startCloudServer } from '@maka-cloud/server';
import { ServerOutbox } from './outbox.js';

/** The playbooks the product runs: T7's research playbook, and the conductor's own coding and free ones. */
export const PRODUCT_PLAYBOOKS: readonly Playbook[] = [
  researchPlaybook,
  CODING_PLAYBOOK,
  FREE_PLAYBOOK,
];

export interface CloudOptions extends Omit<CloudServerOptions, 'handler' | 'createHandler'> {
  /** The conductor's own storage: its database and Maka's sessions. One process owns it. */
  conductorRoot: string;
  /** Passed to the conductor; `root`, `outbox` and `orchestratorAccess` are set here. */
  conductor: Omit<ConductorOptions, 'root' | 'outbox' | 'orchestratorAccess' | 'onWarning'>;
}

export interface Cloud {
  server: CloudServer;
  conductor: Conductor;
  close(): Promise<void>;
}

/**
 * Starts the cloud server with the conductor as its conversation handler.
 * The conductor's output enters the conversation feed through the server's
 * publisher, answers reach it through the answers route, and it closes while
 * the orchestrator endpoint is still up, so it can cancel its tasks.
 */
export async function startCloud(options: CloudOptions): Promise<Cloud> {
  const { conductorRoot, conductor: conductorOptions, ...serverOptions } = options;
  const warn = options.onWarning ?? (() => undefined);
  let conductor: Conductor | undefined;
  const server = await startCloudServer({
    ...serverOptions,
    createHandler: async ({ publisher, conductorAccess }) => {
      const created = await Conductor.create({
        playbooks: PRODUCT_PLAYBOOKS,
        ...conductorOptions,
        root: conductorRoot,
        outbox: new ServerOutbox(publisher, warn),
        orchestratorAccess: conductorAccess,
        onWarning: warn,
      });
      conductor = created;
      return {
        onUserMessage: (message, access) => created.onUserMessage(message, access),
        onAnswer: (answer, access) => created.onAnswer(answer, access),
        close: () => created.close(),
      };
    },
  });
  return {
    server,
    conductor: conductor as Conductor,
    close: () => server.close(),
  };
}
