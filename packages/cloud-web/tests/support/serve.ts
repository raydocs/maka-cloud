import { createServer } from 'node:http';
import { MANIFEST, startStack } from './stack.ts';

/**
 * Starts the real cloud-server with a fake runner for the Playwright suite and
 * serves a small control API next to it, so a test can play the part of the
 * conductor and of the runners. Local only; no keys, no model, no network.
 */
const apiPort = Number(process.env.CLOUD_WEB_API_PORT ?? 4174);
const controlPort = Number(process.env.CLOUD_WEB_CONTROL_PORT ?? 4175);
const stack = await startStack({ port: apiPort });

type Body = Record<string, unknown> & { op: string };

async function run(body: Body): Promise<unknown> {
  const text = (key: string) => String(body[key] ?? '');
  switch (body.op) {
    case 'invite':
      return stack.newInvite();
    case 'mail-code':
      return { code: stack.mailCode(text('address')) };
    case 'revoke':
      return { revoked: stack.server.invites.revoke(text('inviteId')) };
    case 'say':
      return stack.say(text('conversationId'), text('text'));
    case 'notice':
      return stack.notice(text('conversationId'), text('text'));
    case 'ask':
      return stack.ask(text('conversationId'), body.question as never);
    case 'answers':
      return stack.answers;
    case 'suggest':
      return stack.suggest(body.choice as never);
    case 'suggest-offer':
      return stack.suggestOffer(body.offer as never);
    case 'suggestion-decisions':
      return stack.suggestionDecisions;
    case 'suggestion-moves':
      return stack.moveSuggestion(text('cardId'), body.next as never);
    case 'pushed':
      return stack.pushed;
    case 'computer-inputs':
      return stack.computer.inputs.filter((entry) => entry.taskId === text('taskId'));
    case 'computer-disconnect':
      return stack.computer.disconnected.add(text('taskId'));
    case 'delegate':
      return {
        taskId: await stack.delegate(text('conversationId'), {
          title: text('title'),
          ...(body.parent === undefined ? {} : { parent: text('parent') }),
          ...(body.budgetUsd === undefined ? {} : { budgetUsd: Number(body.budgetUsd) }),
        }),
      };
    case 'progress':
      return (await stack.run(text('taskId'))).progress(text('note'));
    case 'usage':
      return (await stack.run(text('taskId'))).usage(Number(body.usd));
    case 'complete':
      return (await stack.run(text('taskId'))).complete({
        ...MANIFEST,
        ...(body.manifest as object | undefined),
      });
    case 'fail':
      return (await stack.run(text('taskId'))).fail(text('reason'));
    case 'opened':
      // The pages a task opened, as trusted code would record them; returns how many were new.
      return {
        recorded: stack.server.recordOpenedPages(
          text('taskId'),
          body.pages as { url: string; label?: never }[],
        ),
      };
    case 'artifact':
      return stack.writeArtifact(
        text('taskId'),
        text('ref'),
        typeof body.base64 === 'string' ? Buffer.from(body.base64, 'base64') : text('content'),
      );
    default:
      throw new Error(`Unknown op ${body.op}`);
  }
}

createServer((req, res) => {
  if (req.url === '/health') return void res.writeHead(200).end('ok');
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    run(JSON.parse(Buffer.concat(chunks).toString() || '{}') as Body).then(
      (result) =>
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(result ?? {})),
      (error: unknown) => res.writeHead(500).end(String(error)),
    );
  });
}).listen(controlPort, '127.0.0.1', () => {
  console.log(`cloud-web test stack: api ${stack.url}, control ${controlPort}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void stack.close().finally(() => process.exit(0)));
}
