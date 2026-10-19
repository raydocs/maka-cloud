import { z } from 'zod';
import type { FeedEntry } from './host.js';

/**
 * Turns feed entries into the few things the supervisor reacts to. This is the
 * only file that knows the shapes the server and the conductor publish; a change
 * there is fixed here. An entry that does not parse is ignored, never guessed at.
 */

const Manifest = z
  .object({
    summary: z.string(),
    done: z.array(z.string()),
    notDone: z.array(z.string()),
    confidence: z.enum(['low', 'medium', 'high']),
    knownIssues: z.array(z.string()),
    artifacts: z.array(z.string()).optional(),
  })
  .passthrough();
export type SignalManifest = z.infer<typeof Manifest>;

const TaskEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('task_created'),
      taskId: z.string(),
      parentTaskId: z.string().optional(),
      /** Absent on the public feed; the supervisor reads the feed without that filter. */
      runner: z.string().optional(),
      title: z.string().optional(),
    })
    .passthrough(),
  z.object({ type: z.literal('task_started'), taskId: z.string() }).passthrough(),
  z.object({ type: z.literal('task_progress'), taskId: z.string() }).passthrough(),
  z.object({ type: z.literal('task_cost'), taskId: z.string() }).passthrough(),
  z.object({ type: z.literal('task_pause_requested'), taskId: z.string() }).passthrough(),
  z.object({ type: z.literal('task_paused'), taskId: z.string() }).passthrough(),
  z.object({ type: z.literal('task_pause_failed'), taskId: z.string() }).passthrough(),
  z.object({ type: z.literal('task_resume_requested'), taskId: z.string() }).passthrough(),
  z.object({ type: z.literal('task_resumed'), taskId: z.string() }).passthrough(),
  z.object({ type: z.literal('task_cancel_requested'), taskId: z.string() }).passthrough(),
  z
    .object({ type: z.literal('task_succeeded'), taskId: z.string(), manifest: Manifest })
    .passthrough(),
  z
    .object({ type: z.literal('task_failed'), taskId: z.string(), reason: z.string() })
    .passthrough(),
  z.object({ type: z.literal('task_cancelled'), taskId: z.string() }).passthrough(),
]);
export type SignalTaskEvent = z.infer<typeof TaskEventSchema>;

const QuestionData = z
  .object({
    questionId: z.string().min(1),
    reason: z.enum(['taste', 'budget_overrun', 'irreversible']),
    question: z.string(),
    options: z.array(z.object({ id: z.string().min(1), label: z.string() }).passthrough()).min(1),
    recommended: z.string(),
    action: z.object({ tool: z.string(), args: z.unknown() }).passthrough().optional(),
  })
  .passthrough();

const AnsweredData = z.object({ questionId: z.string().min(1) }).passthrough();
const TaskEntryData = z.object({ event: TaskEventSchema }).passthrough();
const MessageData = z.object({ role: z.string() }).passthrough();

export type Signal =
  | {
      type: 'task';
      feedId: number;
      at: number;
      conversationId: string;
      event: SignalTaskEvent;
    }
  | { type: 'user_message'; feedId: number; at: number; conversationId: string }
  | {
      type: 'question';
      feedId: number;
      at: number;
      conversationId: string;
      question: z.infer<typeof QuestionData>;
    }
  | { type: 'answered'; feedId: number; at: number; conversationId: string; questionId: string };

export function signalOf(entry: FeedEntry): Signal | undefined {
  const conversationId = entry.conversationId;
  if (conversationId === null) return undefined;
  const base = { feedId: entry.id, at: entry.at, conversationId };
  switch (entry.kind) {
    case 'task.event': {
      const data = TaskEntryData.safeParse(entry.data);
      return data.success ? { type: 'task', ...base, event: data.data.event } : undefined;
    }
    case 'message.posted': {
      const data = MessageData.safeParse(entry.data);
      return data.success && data.data.role === 'user'
        ? { type: 'user_message', ...base }
        : undefined;
    }
    case 'conductor.question': {
      const data = QuestionData.safeParse(entry.data);
      return data.success ? { type: 'question', ...base, question: data.data } : undefined;
    }
    case 'conductor.answered': {
      const data = AnsweredData.safeParse(entry.data);
      return data.success
        ? { type: 'answered', ...base, questionId: data.data.questionId }
        : undefined;
    }
    default:
      return undefined;
  }
}
