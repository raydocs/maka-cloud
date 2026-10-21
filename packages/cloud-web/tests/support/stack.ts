import { createECDH, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type FakeRun,
  FakeRunner,
  type ResultManifest,
  RunnerRegistry,
  type SessionInfo,
} from '../../../cloud-orchestrator/dist/index.js';
import { createSourceFetcher, Supervisor } from '../../../cloud-supervisor/dist/index.js';
import {
  type AnswerOutcome,
  type CloudServer,
  type InboxService,
  type ConversationHandler,
  type ConversationPublisher,
  type PushTransport,
  startCloudServer,
} from '../../../cloud-server/dist/index.js';
import { fakeComputer } from './computer.ts';

export interface AskedQuestion {
  questionId: string;
  reason?: 'taste' | 'budget_overrun' | 'irreversible';
  question: string;
  options: { id: string; label: string }[];
  recommended: string;
  note?: string;
  action?: { tool: string; args: unknown };
}

/**
 * The real cloud-server over SQLite in a temporary directory, with a fake
 * runner as the only "model" and a scripted stand-in for the conductor. Nothing
 * here calls a model, a vendor or the network beyond localhost.
 */
export interface Stack {
  /** Base URL of the public API. */
  url: string;
  token: string;
  inviteId: string;
  server: CloudServer;
  fake: FakeRunner;
  computer: Awaited<ReturnType<typeof fakeComputer>>;
  /** Every Web Push message the server tried to send, as the (fake) push service received it. */
  pushed: Array<{ endpoint: string; headers: Record<string, string>; bytes: number }>;
  /** Another invite, which owns nothing yet. */
  newInvite(): { token: string; inviteId: string };
  /** The assistant says something in a conversation. */
  say(conversationId: string, text: string): void;
  notice(conversationId: string, text: string): void;
  ask(conversationId: string, question: AskedQuestion): void;
  /** Answers received, in order, as the stand-in conductor saw them. */
  answers: Array<{ questionId: string; optionId: string; text?: string; caller: string }>;
  /** Starts a task of the conversation (a subtask when `parent` is a task id). */
  delegate(
    conversationId: string,
    input: { title: string; parent?: string; budgetUsd?: number },
  ): Promise<string>;
  /** The fake run of a task, once the orchestrator has started it. */
  run(taskId: string): Promise<FakeRun>;
  /** Puts a file where the artifact route reads this task's results. */
  writeArtifact(taskId: string, ref: string, content: string | Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export const MANIFEST: ResultManifest = {
  summary: 'The brief is ready for your review.',
  done: ['Compared the options'],
  notDone: [],
  confidence: 'high',
  knownIssues: [],
};

async function eventually<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Hosts the stack's push configuration accepts; no real push service is ever contacted. */
export const PUSH_HOST = 'push.example.test';

/** A throwaway P-256 signing pair for the test server only. */
function vapidKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    // A private key is 32 bytes, but getPrivateKey() drops leading zero bytes (1 key in 256).
    privateKey: Buffer.concat([Buffer.alloc(32), ecdh.getPrivateKey()])
      .subarray(-32)
      .toString('base64url'),
  };
}

/** A 1x1 PNG: the preview image the fake sites serve. */
export const PREVIEW_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * The preview proxy's only network, replaced: `docs.example.test` has a title and a preview image,
 * `plain.example.test` has a title and no image, anything else does not answer. No test here
 * reaches a real site.
 */
type PreviewFetch = NonNullable<
  NonNullable<Parameters<typeof startCloudServer>[0]['previews']>['fetch']
>;
export const previewFetch: PreviewFetch = async (url) => {
  const { hostname, pathname } = new URL(url);
  if (pathname === '/preview.png') {
    return { ok: true, url, contentType: 'image/png', body: PREVIEW_PNG };
  }
  const page = (title: string, image: boolean) =>
    ({
      ok: true,
      url,
      contentType: 'text/html',
      body: Buffer.from(
        `<html><head><title>${title}</title>${
          image ? `<meta property="og:image" content="https://${hostname}/preview.png">` : ''
        }</head><body></body></html>`,
      ),
    }) as const;
  if (hostname === 'docs.example.test') return page('How redirects work', true);
  if (hostname === 'plain.example.test') return page('Notes from a small site', false);
  return { ok: false, reason: 'network' };
};

export async function startStack(
  options: { pausable?: boolean; port?: number; push?: boolean; inbox?: boolean } = {},
): Promise<Stack> {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-web-stack-'));
  const fake = new FakeRunner({ pausable: options.pausable ?? true });
  const computer = await fakeComputer();
  const questions = new Map<
    string,
    { options: Set<string>; answered?: { optionId: string; text?: string } }
  >();
  const answers: Stack['answers'] = [];
  let publisher!: ConversationPublisher;
  let remember!: (message: { eventId: string; conversationId: string; text: string }) => void;
  const handlerFor = (): ConversationHandler => ({
    onUserMessage(message) {
      publisher.publish({
        kind: 'message',
        eventId: `evt_reply_${message.messageId}`,
        conversationId: message.conversationId,
        text: 'Got it. I will start on that.',
      });
    },
    async onAnswer(answer): Promise<AnswerOutcome> {
      const question = questions.get(`${answer.conversationId}/${answer.questionId}`);
      if (!question) return { accepted: false, reason: 'not_found' };
      if (!question.options.has(answer.optionId)) {
        return { accepted: false, reason: 'unknown_option' };
      }
      if (question.answered) {
        return question.answered.optionId === answer.optionId
          ? { accepted: true, duplicate: true }
          : { accepted: false, reason: 'conflict' };
      }
      question.answered = {
        optionId: answer.optionId,
        ...(answer.text === undefined ? {} : { text: answer.text }),
      };
      answers.push({
        questionId: answer.questionId,
        optionId: answer.optionId,
        ...(answer.text === undefined ? {} : { text: answer.text }),
        caller: answer.caller,
      });
      publisher.publish({
        kind: 'answered',
        eventId: `evt_answered_${answer.conversationId}_${answer.questionId}`,
        conversationId: answer.conversationId,
        questionId: answer.questionId,
        optionId: answer.optionId,
        ...(answer.text === undefined ? {} : { text: answer.text }),
      });
      return { accepted: true, duplicate: false };
    },
  });
  let access!: (conversationId: string) => { rotateToken(): string } | undefined;
  const pushed: Stack['pushed'] = [];
  const transport: PushTransport = async (request) => {
    pushed.push({
      endpoint: request.endpoint,
      headers: request.headers,
      bytes: request.body?.length ?? 0,
    });
    return { status: 201 };
  };
  const server = await startCloudServer({
    dbPath: join(dir, 'server.sqlite'),
    invitesPath: join(dir, 'invites.sqlite'),
    handoffRoot: join(dir, 'handoff'),
    runners: new RunnerRegistry([fake]),
    previews: { fetch: previewFetch },
    computer: computer.source,
    ...(options.port === undefined ? {} : { port: options.port }),
    host: '127.0.0.1',
    createHandler: (context) => {
      publisher = context.publisher;
      remember = context.memory.remember;
      access = context.conductorAccess;
      return handlerFor();
    },
    http: { messagesPerMinute: 1_000_000, controlPerMinute: 1_000_000, heartbeatMs: 1000 },
    // The real supervisor, started the way the host starts it but with no model, no key and
    // nothing to read: a result it cannot check is shown at once, as it words that itself.
    ...(options.inbox === false
      ? {}
      : {
          supervisor: async (parts): Promise<InboxService> => {
            const supervisor = await Supervisor.start({
              dbPath: join(dir, 'supervisor.sqlite'),
              host: {
                feed: parts.feed,
                publish: (event) => parts.publish(event),
                notifier: { interrupt: () => undefined },
                answers: parts.answers,
                messages: parts.messages,
              },
              // The maintenance pass publishes item changes; the host's default is 15 s.
              tickMs: 50,
              verification: {
                evidence: { readArtifact: async () => ({ ok: false, reason: 'not_found' }) },
                fetcher: createSourceFetcher(),
                budget: {
                  reserve: () => ({ ok: false, reason: 'no budget' }),
                  settle: () => undefined,
                },
                models: [],
              },
            });
            return {
              list: async (query) => supervisor.listItems(query),
              answer: async (request) => supervisor.answer(request),
              // The mutes, settings and digest are not kept per owner yet: the server never calls these.
              setMute: () => ({ ok: false }),
              settings: () => supervisor.getSettings(),
              updateSettings: () => ({ ok: false }),
              digest: () => supervisor.digest(),
              stop: () => supervisor.stop(),
            };
          },
        }),
    ...(options.push === false
      ? {}
      : {
          push: {
            ...vapidKeys(),
            subject: 'mailto:test@example.invalid',
            allowedHosts: [PUSH_HOST],
            transport,
            retryDelayMs: 1,
          },
        }),
  });
  const invite = server.invites.create('test');

  const sessionOf = (conversationId: string): SessionInfo => {
    const token = access(conversationId)?.rotateToken();
    const session = token === undefined ? undefined : server.orchestrator.authenticate(token);
    if (!session) throw new Error(`No conductor session for ${conversationId}`);
    return session;
  };
  const stack: Stack = {
    url: server.url,
    token: invite.token,
    inviteId: invite.inviteId,
    server,
    fake,
    computer,
    answers,
    pushed,
    newInvite: () => {
      const created = server.invites.create('other');
      return { token: created.token, inviteId: created.inviteId };
    },
    say: (conversationId, text) => {
      const message = {
        kind: 'message' as const,
        eventId: `evt_${randomUUID()}`,
        conversationId,
        text,
      };
      remember(message);
      publisher.publish(message);
    },
    notice: (conversationId, text) => {
      publisher.publish({ kind: 'notice', eventId: `evt_${randomUUID()}`, conversationId, text });
    },
    ask: (conversationId, question) => {
      questions.set(`${conversationId}/${question.questionId}`, {
        options: new Set(question.options.map((o) => o.id)),
      });
      const published = publisher.publish({
        kind: 'question',
        eventId: `evt_q_${conversationId}_${question.questionId}`,
        conversationId,
        questionId: question.questionId,
        reason: question.reason ?? 'taste',
        question: question.question,
        options: question.options,
        recommended: question.recommended,
        ...(question.note === undefined ? {} : { note: question.note }),
        ...(question.action === undefined ? {} : { action: question.action }),
      });
      if (!published.published)
        throw new Error(`The question was not published: ${published.reason}`);
    },
    delegate: async (conversationId, input) => {
      const root = sessionOf(conversationId);
      const session =
        input.parent === undefined
          ? root
          : (() => {
              const issued = server.orchestrator.issueSession({ parentTaskId: input.parent });
              const child = server.orchestrator.authenticate(issued.token);
              if (!child) throw new Error('No session for the parent task');
              return child;
            })();
      const view = await server.orchestrator.delegate(session, {
        runner: 'fake',
        brief: input.title,
        title: input.title,
        ...(input.budgetUsd === undefined ? {} : { budgetUsd: input.budgetUsd }),
      });
      return view.taskId;
    },
    run: (taskId) =>
      eventually(
        () => fake.runs.find((candidate) => candidate.spec.taskId === taskId),
        `the run of ${taskId}`,
      ),
    writeArtifact: async (taskId, ref, content) => {
      const path = join(dir, 'handoff', taskId, ref);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    },
    close: async () => {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
  return stack;
}
