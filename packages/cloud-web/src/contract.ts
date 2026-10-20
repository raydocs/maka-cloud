/**
 * The public API of packages/cloud-server as it is on main. Every route needs
 * `Authorization: Bearer <invite>`; an object another invite owns answers 404.
 * Test against the real server: tests/integration/real-api.test.ts.
 */
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

export type TaskState = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';
export const TERMINAL: ReadonlySet<TaskState> = new Set(['succeeded', 'failed', 'cancelled']);

/** A task as the public API shows it: the runner id never leaves the server. */
export interface TaskView {
  taskId: string;
  parentTaskId?: string;
  title?: string;
  state: TaskState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  progress: string[];
  manifest?: Manifest;
  failureReason?: string;
  cancelRequested: boolean;
  /** On a top-level task: what its whole tree reported spending. Absent until a run reports. */
  costUsd?: number;
  budgetUsd?: number;
  budgetExceeded?: boolean;
  pauseRequested: boolean;
  /** The run is not known to have stopped, whatever `state` says. */
  stopPending?: boolean;
  /** This task or one below it may still be running, or owes a stop. */
  treeStopPending?: boolean;
}

export type TaskEvent =
  | {
      type: 'task_created';
      taskId: string;
      sessionId: string;
      parentTaskId?: string;
      title?: string;
      mode: 'async' | 'wait';
      budgetUsd?: number;
    }
  | { type: 'task_started'; taskId: string }
  | { type: 'task_cost'; taskId: string; fromTaskId: string; costUsd: number }
  | { type: 'task_progress'; taskId: string; note: string }
  | { type: 'task_succeeded'; taskId: string; manifest: Manifest }
  | { type: 'task_failed'; taskId: string; reason: string }
  | { type: 'task_cancel_requested'; taskId: string; by: string }
  | { type: 'task_cancelled'; taskId: string }
  | { type: 'task_pause_requested'; taskId: string; by: string }
  | { type: 'task_paused'; taskId: string }
  | { type: 'task_pause_failed'; taskId: string; reason: string }
  | { type: 'task_resume_requested'; taskId: string; by: string }
  | { type: 'task_resumed'; taskId: string }
  | { type: 'task_resume_failed'; taskId: string; reason: string }
  | { type: 'task_stop_pending'; taskId: string; cause: string }
  | { type: 'task_stopped'; taskId: string };

export interface Question {
  questionId: string;
  reason: 'taste' | 'budget_overrun' | 'irreversible';
  question: string;
  options: { id: string; label: string }[];
  recommended: string;
  /** The model's own words, shown under the code-built question. */
  note?: string;
  /** For an irreversible action: the held call the user approves or rejects. */
  action?: { tool: string; args: unknown };
}

/** The payloads of `GET /v1/events`. The server adds `conversationId` to every one. */
export type Events = {
  'conversation.created': { title: string | null; at: number };
  'message.posted': { messageId: string; role: 'user' | 'assistant'; text: string; at: number };
  'task.event': {
    seq: number;
    at: number;
    event: TaskEvent;
    /** On `task_cost`: the task's total over its runs. */
    totalCostUsd?: number;
  };
  'conductor.notice': { noticeId: string; text: string; at: number };
  'conductor.question': Question & { at: number };
  'conductor.answered': { questionId: string; optionId: string; text?: string; at: number };
  /** The supervisor's inbox item, one frame per version. */
  'inbox.item': InboxItem;
};
export type FeedEvent = {
  [K in keyof Events]: { id: number; kind: K; data: Events[K] & { conversationId: string } };
}[keyof Events];

export type InboxKind =
  | 'decision'
  | 'approval'
  | 'blocked'
  | 'verification_failed'
  | 'budget'
  | 'finished';

export type InboxEvidence =
  | { kind: 'artifact'; taskId: string; name: string }
  | { kind: 'link'; url: string; label: string }
  | { kind: 'action'; tool: string; args: string };

/**
 * An item of the supervisor's "needs you" inbox as the public API shows it. `ask`
 * is the supervisor's own text, label included ("(independently checked)" or
 * "(not independently checked)" on a finished task): the app shows it and never
 * works that label out itself.
 */
export interface InboxItem {
  itemId: string;
  kind: InboxKind;
  conversationId: string;
  taskId: string | null;
  ask: string;
  options: { id: string; label: string; recommended: boolean }[];
  allowText: boolean;
  evidence: InboxEvidence[];
  state: 'open' | 'answering' | 'closed';
  closeReason: string | null;
  /** Echoed in the answer: it only applies to the state the human saw. */
  preconditionHash: string;
  version: number;
  interrupts: boolean;
  delivery: 'none' | 'sending' | 'retrying';
  createdAt: number;
  updatedAt: number;
}

export interface InboxAnswerRequest {
  /** 1 to 64 letters, digits, "_" or "-". A retry of the same answer reuses it. */
  answerId: string;
  optionId: string;
  text?: string;
  preconditionHash: string;
}
export interface InboxAnswerResult {
  duplicate: boolean;
  item: InboxItem;
}

export interface AnswerRequest {
  questionId: string;
  optionId: string;
  text?: string;
}
export interface AnswerResult {
  accepted: true;
  duplicate: boolean;
}

export interface ArtifactListing {
  index: number;
  name: string;
  kind: 'file' | 'link';
  url?: string;
}
export type ArtifactContent =
  | { kind: 'link'; url: string }
  | { kind: 'text'; name: string; text: string };

/** The body of `POST /v1/push/subscriptions`; `DELETE` takes `{endpoint}` alone. */
export interface PushRegistration {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type TaskControl = 'cancel' | 'pause' | 'resume';

export interface ComputerState {
  controller: 'human' | 'agent';
}
export interface ComputerFrame extends ComputerState {
  desktop?: { mime: 'image/png' | 'image/jpeg'; base64: string };
  terminal?: string;
}
export type ComputerInput =
  | { type: 'terminal'; text: string }
  | { type: 'key'; key: string }
  | { type: 'pointer'; x: number; y: number; button: 0 | 1 | 2 };

/** All paths are same-origin; opaque ids are URL-encoded. */
export const routes = {
  conversations: '/v1/conversations',
  messages: (id: string) => `/v1/conversations/${encodeURIComponent(id)}/messages`,
  tasks: (id: string) => `/v1/conversations/${encodeURIComponent(id)}/tasks`,
  answers: (id: string) => `/v1/conversations/${encodeURIComponent(id)}/answers`,
  events: (id: string) => `/v1/events?conversation=${encodeURIComponent(id)}`,
  control: (task: string, action: TaskControl) => `/v1/tasks/${encodeURIComponent(task)}/${action}`,
  computer: (task: string) => `/v1/tasks/${encodeURIComponent(task)}/computer`,
  inboxAnswer: (item: string) => `/v1/inbox/items/${encodeURIComponent(item)}/answer`,
  artifacts: (task: string) => `/v1/tasks/${encodeURIComponent(task)}/artifacts`,
  artifact: (task: string, index: number) => `${routes.artifacts(task)}/${index}`,
  // Web Push answers 404 until the server is configured with its signing key.
  pushKey: '/v1/push/key',
  pushSubscriptions: '/v1/push/subscriptions',
} as const;
