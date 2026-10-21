import { LaunchRefused, type RunLauncher } from '@maka-cloud/duties';
import type { CloudServer } from '@maka-cloud/server';

const MAX_TITLE = 200;

/**
 * Starts a duty run as a conversation of the project's owner. The request id is the start key, so
 * a launch that is repeated after a crash or a retry finds the conversation it made and posts
 * nothing again. A start the server will never accept (the owner was revoked, the brief is not
 * valid) is refused for good instead of retried.
 */
export function serverLauncher(server: Pick<CloudServer, 'startConversation'>): RunLauncher {
  return {
    async start(request) {
      const started = server.startConversation({
        owner: request.owner,
        key: request.requestId,
        title: `${request.dutyName} · ${request.repo}`.slice(0, MAX_TITLE),
        text: request.brief,
        meta: {
          external: request.external,
          run: {
            dutyId: request.dutyId,
            authority: request.authority,
            budgetUsd: request.runBudgetUsd,
          },
        },
      });
      if (!started.ok) {
        throw new LaunchRefused(`The server did not start the run: ${started.reason}`);
      }
      return { conversationId: started.conversationId };
    },
  };
}
