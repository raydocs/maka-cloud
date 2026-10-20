import {
  CODING_PLAYBOOK,
  Conductor,
  type ConductorOptions,
  FREE_PLAYBOOK,
  type Playbook,
} from '@maka-cloud/conductor';
import type { Orchestrator } from '@maka-cloud/orchestrator';
import { researchPlaybook } from '@maka-cloud/playbooks';
import {
  type CloudServer,
  type CloudServerOptions,
  type InboxService,
  startCloudServer,
  type SupervisorParts,
} from '@maka-cloud/server';
import { ServerOutbox } from './outbox.js';

/** The playbooks the product runs: T7's research playbook, and the conductor's own coding and free ones. */
export const PRODUCT_PLAYBOOKS: readonly Playbook[] = [
  researchPlaybook,
  CODING_PLAYBOOK,
  FREE_PLAYBOOK,
];

export interface CloudOptions
  extends Omit<CloudServerOptions, 'handler' | 'createHandler' | 'supervisor'> {
  /** The conductor's own storage: its database and Maka's sessions. One process owns it. */
  conductorRoot: string;
  /** Storage, output, memory and orchestrator access are composed here. */
  conductor: Omit<
    ConductorOptions,
    'root' | 'outbox' | 'orchestratorAccess' | 'onWarning' | 'turnContext'
  >;
  /**
   * Called with the restored orchestrator and the new conductor before the server listens, so no
   * task or tool call can reach what it sets up first.
   */
  onReady?(parts: {
    orchestrator: Orchestrator;
    conductor: Conductor;
    /** The invite that owns a task's conversation; undefined for an unknown task or an unowned conversation. */
    ownerOfTask(taskId: string): string | undefined;
    /** The invite that owns a conversation; undefined for an unknown or unowned one. */
    ownerOfConversation(conversationId: string): string | undefined;
    /** The conversation a task belongs to; undefined for an unknown task. */
    conversationOfTask(taskId: string): string | undefined;
  }): void;
  /**
   * Starts the supervisor with the server's in-process parts and the conductor, after the
   * conductor exists and before the server listens; it stops before the conductor closes.
   */
  supervisor?: (context: {
    parts: SupervisorParts;
    conductor: Conductor;
  }) => InboxService | Promise<InboxService>;
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
  const {
    conductorRoot,
    conductor: conductorOptions,
    onReady,
    supervisor,
    ...serverOptions
  } = options;
  const warn = options.onWarning ?? (() => undefined);
  let conductor: Conductor | undefined;
  const server = await startCloudServer({
    ...serverOptions,
    ...(supervisor
      ? {
          supervisor: (parts: SupervisorParts) => {
            if (!conductor) throw new Error('The supervisor started before the conductor');
            return supervisor({ parts, conductor });
          },
        }
      : {}),
    createHandler: async ({
      publisher,
      orchestrator,
      conductorAccess,
      authorized,
      ownerOfTask,
      memory,
      ownerOfConversation,
      conversationOfTask,
    }) => {
      const created = await Conductor.create({
        playbooks: PRODUCT_PLAYBOOKS,
        ...conductorOptions,
        root: conductorRoot,
        outbox: new ServerOutbox(publisher, warn, memory.remember),
        turnContext: memory.context,
        orchestratorAccess: conductorAccess,
        // An approved irreversible call runs only while its approver's invite is active and owns the conversation.
        approverAuthorized: (approvedBy, conversationId) =>
          approvedBy !== null && authorized(approvedBy, conversationId),
        onWarning: warn,
      });
      conductor = created;
      onReady?.({
        orchestrator,
        conductor: created,
        ownerOfTask,
        ownerOfConversation,
        conversationOfTask,
      });
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
