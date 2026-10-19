import {
  startFakeAnthropic,
  type EmittedThinking,
  type RecordedRequest,
  type ScriptedReply,
  type WireBlock,
} from './fake-anthropic.js';
import { checkHistory, type HistoryCheckReport } from './checks.js';
import {
  conversationTools,
  DEFAULT_TURNS,
  runConversation,
  type ConversationHooks,
  type TurnRecord,
} from './conversation.js';
import { startHarness, type HarnessSettings } from './harness.js';

export type RunId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';

export interface RunDefinition {
  readonly id: RunId;
  readonly title: string;
  readonly settings: HarnessSettings;
  readonly docBytes: number;
  /** Before running: does this setting promise an append-only history? */
  readonly expectAppendOnly: boolean;
  readonly hooks?: (control: RunControl) => ConversationHooks;
}

export interface RunControl {
  restart(): Promise<void>;
  compact(): Promise<void>;
}

/** Small documents stay under the 7,500-byte archive threshold; large ones cross it. */
const SMALL_DOC = 1_200;
const LARGE_DOC = 12_000;
const MIDPOINT = 15;

const OVERFLOW: ScriptedReply = {
  kind: 'error',
  status: 400,
  body: {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'prompt is too long: 1000001 tokens > 1000000 maximum',
    },
  },
};

export const RUNS: readonly RunDefinition[] = [
  {
    id: 'A',
    title: 'Defaults as runtime-host wires them',
    settings: { contextBudget: 'default' },
    docBytes: SMALL_DOC,
    expectAppendOnly: true,
  },
  {
    id: 'B',
    title: 'Pruning and compaction off (no context budget policy)',
    settings: { contextBudget: 'off' },
    docBytes: SMALL_DOC,
    expectAppendOnly: true,
  },
  {
    id: 'C',
    title: 'Pruning on, tool results over 7,500 bytes, first archive write fails',
    settings: { contextBudget: 'default', archiveWriteFailures: 1 },
    docBytes: LARGE_DOC,
    expectAppendOnly: false,
  },
  {
    id: 'D',
    title: 'Proactive compaction (low compaction threshold)',
    settings: { contextBudget: 'default', compactionThreshold: 12_000 },
    docBytes: SMALL_DOC,
    expectAppendOnly: false,
  },
  {
    id: 'E',
    title: 'Reactive overflow recovery (one context-overflow 400 at turn 20)',
    settings: { contextBudget: 'default' },
    docBytes: SMALL_DOC,
    expectAppendOnly: false,
    hooks: () => ({ prefixReplies: (turn) => (turn === 20 ? [OVERFLOW] : []) }),
  },
  {
    id: 'F',
    title: `Manual compaction before turn ${MIDPOINT + 1}`,
    settings: { contextBudget: 'default' },
    docBytes: SMALL_DOC,
    expectAppendOnly: false,
    hooks: (control) => ({
      beforeTurn: async (turn) => {
        if (turn === MIDPOINT + 1) await control.compact();
      },
    }),
  },
  {
    id: 'G',
    title: `Restart after turn ${MIDPOINT} (new SessionManager and backend, same stores)`,
    settings: { contextBudget: 'default' },
    docBytes: SMALL_DOC,
    expectAppendOnly: true,
    hooks: (control) => ({
      beforeTurn: async (turn) => {
        if (turn === MIDPOINT + 1) await control.restart();
      },
    }),
  },
  {
    id: 'H',
    title: 'Defaults, but the session has no llmConnectionId',
    settings: { contextBudget: 'default', omitConnectionId: true },
    docBytes: SMALL_DOC,
    expectAppendOnly: false,
  },
];

/** The per-turn context runtime-host sends after the history (`execution-model-composition.ts`). */
export function isRuntimeEnvironmentBlock(block: WireBlock): boolean {
  return (
    block.type === 'text' &&
    typeof block.text === 'string' &&
    block.text.startsWith('Runtime Host environment for this turn:')
  );
}

export interface RunResult {
  readonly definition: RunDefinition;
  readonly turns: TurnRecord[];
  readonly requests: RecordedRequest[];
  readonly emittedThinking: EmittedThinking[];
  readonly report: HistoryCheckReport;
  readonly archiveWrites: { attempted: number; failed: number };
  readonly compactions: Array<{ errors: string[]; stopReason?: string }>;
}

export async function executeRun(
  definition: RunDefinition,
  turns = DEFAULT_TURNS,
): Promise<RunResult> {
  const fake = await startFakeAnthropic();
  const harness = await startHarness({
    baseUrl: fake.url,
    apiKey: 'sk-ant-fake-history-check',
    tools: conversationTools(definition.docBytes),
    settings: definition.settings,
  });
  const compactions: RunResult['compactions'] = [];
  try {
    const control: RunControl = {
      restart: () => harness.restart(),
      compact: async () => {
        const outcome = await harness.compact();
        compactions.push({
          errors: outcome.errors,
          ...(outcome.stopReason ? { stopReason: outcome.stopReason } : {}),
        });
      },
    };
    const records = await runConversation(harness, fake, turns, definition.hooks?.(control) ?? {});
    const report = checkHistory(fake.requests, fake.emittedThinking, {
      isRequestOnlyBlock: isRuntimeEnvironmentBlock,
    });
    return {
      definition,
      turns: records,
      requests: [...fake.requests],
      emittedThinking: [...fake.emittedThinking],
      report,
      archiveWrites: { ...harness.archiveWrites },
      compactions,
    };
  } finally {
    await harness.close();
    await fake.close();
  }
}
