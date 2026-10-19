import { z } from 'zod';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import type { FakeAnthropicServer, ScriptedReply, ThinkingMode } from './fake-anthropic.js';
import type { Harness, TurnOutcome } from './harness.js';

export const DEFAULT_TURNS = 30;

export interface ConversationTools {
  readonly tools: MakaTool[];
}

/**
 * Two deterministic tools: `lookup` returns a small JSON record, `fetch_doc`
 * returns a document of `docBytes` characters (over 7,500 bytes it crosses
 * Maka's tool-result archive threshold, `read-page.ts` READ_PAGE_MAX_BYTES).
 */
export function conversationTools(docBytes: number): MakaTool[] {
  const lookup: MakaTool<{ topic: string }> = {
    name: 'lookup',
    description: 'Look up short facts about a topic.',
    parameters: z.object({ topic: z.string() }),
    impl: ({ topic }) => ({
      topic,
      facts: [`${topic} was first described in a fixture`, `${topic} has 3 known variants`],
    }),
  };
  const fetchDoc: MakaTool<{ id: string }> = {
    name: 'fetch_doc',
    description: 'Fetch the full text of a document by id.',
    parameters: z.object({ id: z.string() }),
    impl: ({ id }) => documentText(id, docBytes),
  };
  return [lookup, fetchDoc];
}

function documentText(id: string, bytes: number): string {
  const line = `Document ${id}: deterministic fixture text for the history check.\n`;
  return line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes);
}

/** The model's replies for one user turn: tool steps, then a final answer. */
export function turnScript(turn: number): ScriptedReply[] {
  const topic = `topic-${turn}`;
  const signed: ThinkingMode = 'signed';
  switch (turn % 3) {
    case 0:
      return [
        { kind: 'tool', thinking: signed, name: 'lookup', input: { topic } },
        { kind: 'text', thinking: signed, text: `Turn ${turn}: ${topic} summarized.` },
      ];
    case 1:
      return [
        { kind: 'tool', thinking: signed, name: 'lookup', input: { topic } },
        { kind: 'tool', thinking: signed, name: 'fetch_doc', input: { id: `doc-${turn}` } },
        { kind: 'text', thinking: signed, text: `Turn ${turn}: read doc-${turn}.` },
      ];
    default:
      return [
        { kind: 'tool', thinking: 'redacted', name: 'fetch_doc', input: { id: `doc-${turn}` } },
        { kind: 'text', thinking: signed, text: `Turn ${turn}: done.` },
      ];
  }
}

export interface ConversationHooks {
  /** Runs before turn `turn` is sent, e.g. to restart or compact. */
  readonly beforeTurn?: (turn: number) => Promise<void>;
  /** Replies queued ahead of the turn's own script, e.g. an injected error. */
  readonly prefixReplies?: (turn: number) => ScriptedReply[];
}

export interface TurnRecord {
  readonly turn: number;
  readonly outcome: TurnOutcome;
  /** Scripted replies the runtime never asked for; non-zero means the turn ended early. */
  readonly unconsumedReplies: number;
}

/** Drive `turns` user turns through the harness, tagging every request with its turn. */
export async function runConversation(
  harness: Harness,
  fake: FakeAnthropicServer,
  turns: number,
  hooks: ConversationHooks = {},
): Promise<TurnRecord[]> {
  const records: TurnRecord[] = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    const firstRequest = fake.requests.length;
    await hooks.beforeTurn?.(turn);
    tagRequests(fake, firstRequest, turn);
    const startRequest = fake.requests.length;
    fake.enqueue(...(hooks.prefixReplies?.(turn) ?? []), ...turnScript(turn));
    const outcome = await harness.send(`turn-${turn}`, `Turn ${turn}: research topic-${turn}.`);
    tagRequests(fake, startRequest, turn);
    // A turn that ends early leaves replies behind; drop them so the next
    // turn starts clean, and keep the count as part of the record.
    const unconsumedReplies = fake.clear();
    records.push({ turn, outcome, unconsumedReplies });
  }
  return records;
}

function tagRequests(fake: FakeAnthropicServer, from: number, turn: number): void {
  for (const request of fake.requests.slice(from)) request.turn ??= turn;
}
