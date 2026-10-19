import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import {
  FakeRunner,
  MemoryTaskStore,
  Orchestrator,
  OrchestratorServer,
  RunnerRegistry,
} from '@maka-cloud/orchestrator';
import { Conductor, type ConductorOptions } from '../conductor.js';
import type { ConductorAccess } from '../orchestrator-link.js';
import { MemoryOutbox } from '../outbox.js';
import { type FakeModel, startFakeModel } from './fake-model.js';

export interface Harness {
  dir: string;
  model: FakeModel;
  orchestrator: Orchestrator;
  claude: FakeRunner;
  codex: FakeRunner;
  outbox: MemoryOutbox;
  conductor: Conductor;
  warnings: Array<{ message: string; detail?: unknown }>;
  /** The access the cloud server would pass for this conversation. */
  access(conversationId: string): ConductorAccess;
  /** Rotations each conversation's token went through. */
  rotations: Map<string, number>;
  send(conversationId: string, text: string, messageId?: string): Promise<string>;
  answer(
    conversationId: string,
    questionId: string,
    optionId: string,
  ): ReturnType<Conductor['onAnswer']>;
  /** Builds a new conductor over the same root, as after a restart. */
  restart(options?: Partial<ConductorOptions>): Promise<Conductor>;
}

export interface HarnessOptions {
  conductor?: Partial<ConductorOptions>;
  /** Runners finish every task they start with the default manifest. Default true. */
  autoComplete?: boolean;
}

export async function makeHarness(t: TestContext, options: HarnessOptions = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-test-'));
  const model = await startFakeModel();
  const autoComplete = options.autoComplete ?? true;
  const onStart = autoComplete
    ? (run: { complete(): Promise<void> }) => {
        setImmediate(() => void run.complete());
      }
    : undefined;
  const claude = new FakeRunner({ name: 'claude-agent-sdk', ...(onStart ? { onStart } : {}) });
  const codex = new FakeRunner({ name: 'codex', ...(onStart ? { onStart } : {}) });
  const orchestrator = await Orchestrator.create({
    store: new MemoryTaskStore(),
    runners: new RunnerRegistry([claude, codex]),
    handoffRoot: join(dir, 'handoff'),
  });
  const server = new OrchestratorServer(orchestrator);
  const mcpUrl = await server.listen();
  const outbox = new MemoryOutbox();
  const warnings: Array<{ message: string; detail?: unknown }> = [];
  const sessions = new Map<string, string>();
  const rotations = new Map<string, number>();
  const access = (conversationId: string): ConductorAccess => {
    let sessionId = sessions.get(conversationId);
    if (!sessionId) {
      sessionId = orchestrator.issueSession().sessionId;
      sessions.set(conversationId, sessionId);
    }
    const id = sessionId;
    return {
      mcpUrl,
      rotateToken: () => {
        rotations.set(conversationId, (rotations.get(conversationId) ?? 0) + 1);
        const rotated = orchestrator.rotateSession(id);
        if (!rotated) throw new Error('no session');
        return rotated.token;
      },
    };
  };
  const conductorOptions = (overrides: Partial<ConductorOptions> = {}): ConductorOptions => ({
    root: join(dir, 'conductor'),
    access: { apiKey: 'sk-test-not-a-key', baseUrl: model.url },
    outbox,
    onWarning: (message, detail) => warnings.push({ message, detail }),
    ...options.conductor,
    ...overrides,
  });
  const harness: Harness = {
    dir,
    model,
    orchestrator,
    claude,
    codex,
    outbox,
    warnings,
    rotations,
    conductor: await Conductor.create(conductorOptions()),
    access,
    send: async (conversationId, text, messageId = `msg_${randomUUID()}`) => {
      await harness.conductor.onUserMessage(
        { conversationId, messageId, text },
        harness.access(conversationId),
      );
      return messageId;
    },
    answer: (conversationId, questionId, optionId) =>
      harness.conductor.onAnswer(
        { conversationId, questionId, optionId },
        harness.access(conversationId),
      ),
    restart: async (overrides) => {
      await harness.conductor.close();
      harness.conductor = await Conductor.create(conductorOptions(overrides));
      return harness.conductor;
    },
  };
  t.after(async () => {
    const [failure] = model.failures;
    if (failure) {
      process.stderr.write(
        `notices: ${JSON.stringify(outbox.notices)}\nwarnings: ${JSON.stringify(warnings.map((w) => [w.message, String(w.detail)]))}\n`,
      );
    }
    await harness.conductor.close();
    await server.close();
    await model.close();
    await rm(dir, { recursive: true, force: true });
    if (failure) throw failure;
  });
  return harness;
}

/** A promise and the function that settles it: the handshake tests use instead of sleeps. */
export function gate<T = void>(): { promise: Promise<T>; open: (value: T) => void } {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
