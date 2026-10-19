/** T4 #21 wire contract. Extensions below are proposals, not claims about T4. */
export interface Conversation {
  conversationId: string;
  title: string | null;
  createdAt: number;
}

export interface Manifest {
  summary: string;
  done: string[];
  notDone: string[];
  confidence: 'low' | 'medium' | 'high';
  knownIssues: string[];
  artifacts?: string[];
}

export type TaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface TaskView {
  taskId: string;
  parentTaskId?: string;
  runner: string;
  title?: string;
  state: TaskState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  progress: string[];
  manifest?: Manifest;
  failureReason?: string;
  cancelRequested: boolean;
  waitTimedOut?: boolean;
}

export type TaskEvent =
  | {
      type: 'task_created';
      taskId: string;
      sessionId: string;
      rootSessionId?: string;
      parentTaskId?: string;
      runner: string;
      title?: string;
      mode: 'async' | 'wait';
    }
  | { type: 'task_started'; taskId: string }
  | { type: 'task_progress'; taskId: string; note: string }
  | { type: 'task_succeeded'; taskId: string; manifest: Manifest }
  | { type: 'task_failed'; taskId: string; reason: string }
  | { type: 'task_cancel_requested'; taskId: string; by: string }
  | { type: 'task_cancelled'; taskId: string };

export type BaseEvents = {
  'conversation.created': { conversationId: string; title: string | null; at: number };
  'message.posted': {
    conversationId: string;
    messageId: string;
    role: 'user';
    text: string;
    at: number;
  };
  'task.event': { conversationId: string | null; seq: number; at: number; event: TaskEvent };
};

/** Exact T5 PR A outbox fields (outbox.ts / state.ts on main). */
export interface OutboxMessage {
  conversationId: string;
  runId: string;
  text: string;
}
export interface OutboxQuestion {
  conversationId: string;
  runId: string;
  questionId: string;
  reason: 'taste' | 'budget_overrun' | 'irreversible';
  question: string;
  options: { id: string; label: string }[];
  recommended: string;
}
export interface OutboxAnswered {
  conversationId: string;
  runId: string;
  questionId: string;
  optionId: string;
  text?: string;
}
export interface OutboxNotice {
  conversationId: string;
  runId?: string;
  text: string;
}
export interface AnswerRequest {
  questionId: string;
  optionId: string;
  text?: string;
}
export type AnswerResult =
  | { accepted: true; duplicate: boolean }
  | { accepted: false; reason: string };

/**
 * Proposed wire envelopes. T5 PR B owns answers/outbox transport; no public
 * implementation was available at inspection. Retain exact outbox fields.
 * Other route/event ownership and outstanding confirmation: README table.
 */
export type ExtensionEvents = {
  'conductor.message': OutboxMessage;
  'conductor.question': OutboxQuestion;
  'conductor.answered': OutboxAnswered;
  'conductor.notice': OutboxNotice;
  'task.paused': { conversationId: string; taskId: string; paused: boolean };
  'task.cost': { conversationId: string; taskId: string; costUsd: number };
};
export type Events = BaseEvents & ExtensionEvents;
export type FeedEvent = {
  [K in keyof Events]: { id: number; kind: K; data: Events[K] };
}[keyof Events];

export interface Capabilities {
  taskCancel?: boolean;
  taskPause?: boolean;
  answers?: boolean;
  artifacts?: boolean;
  taskCost?: boolean;
  push?: boolean;
}
export type Capability = keyof Capabilities;
export interface Artifact {
  kind: 'report' | 'diff' | 'pr';
  title: string;
  content?: string;
  url?: string;
}
export interface PushRegistration {
  endpoint: string;
  expirationTime?: number | null;
  keys?: { p256dh: string; auth: string };
}

/** All paths are same-origin; encode opaque IDs, never expose session tokens. */
export const routes = {
  conversations: '/v1/conversations',
  messages: (id: string) => `/v1/conversations/${encodeURIComponent(id)}/messages`,
  tasks: (id: string) => `/v1/conversations/${encodeURIComponent(id)}/tasks`,
  events: (id: string) => `/v1/events?conversation=${encodeURIComponent(id)}`,
  // Extensions: T5 PR B (answer path specified by the task; body from UserAnswer).
  answers: (id: string) => `/v1/conversations/${encodeURIComponent(id)}/answers`,
  // Extensions: server/orchestrator owners; concrete follow-up IDs unconfirmed.
  cancel: (conversation: string, task: string) =>
    `${routes.tasks(conversation)}/${encodeURIComponent(task)}/cancel`,
  pause: (conversation: string, task: string) =>
    `${routes.tasks(conversation)}/${encodeURIComponent(task)}/pause`,
  artifact: (conversation: string, ref: string) =>
    `/v1/conversations/${encodeURIComponent(conversation)}/artifacts?ref=${encodeURIComponent(ref)}`,
  capabilities: '/v1/capabilities',
  pushConfig: '/v1/push/config',
  pushSubscriptions: '/v1/push/subscriptions',
} as const;
