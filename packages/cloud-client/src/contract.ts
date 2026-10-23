/**
 * The public API of packages/cloud-server as it is on main. Every route needs
 * `Authorization: Bearer <invite>`; an object another invite owns answers 404.
 * Test against the real server: tests/integration/real-api.test.ts.
 */
/** How much care a piece of work gets; the server's strict set. */
export const MODES = ['quick', 'standard', 'deep'] as const;
export type Mode = (typeof MODES)[number];

export interface Conversation {
  conversationId: string;
  title: string | null;
  createdAt: number;
}

export interface MemoryProfile {
  facts: { id: string; text: string }[];
  summaries: { id: string; conversationId: string; text: string }[];
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

export type PanelKind = 'shell' | 'tests' | 'diff' | 'review' | 'search';
export type PanelState = 'running' | 'passed' | 'failed' | 'stopped';

export interface TaskPanel {
  panelId: string;
  kind: PanelKind;
  state: PanelState;
  title: string;
  /** A fixed shape per kind: "41 passed, 1 failed", "+12 −3 in 2 files", "0 P1, 2 P2, 0 P3". */
  summary: string;
  /** The last lines (at most 40, 4 KiB), scrubbed. */
  tail?: string;
}

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
  /** What the task is doing now, in the run's latest narration line. Built from events only. */
  narration?: string;
  /** The task's panels in the order they first appeared. Built from events only. */
  panels?: TaskPanel[];
  manifest?: Manifest;
  /** What the runner kept for the owner when the task ended without a result. */
  kept?: Manifest;
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
  /** One short present-tense line for what the task is doing now; it replaces the last. */
  | { type: 'task_narration'; taskId: string; line: string }
  /** A panel of the task's work, replaced in place by `panelId`. A reader copy, not evidence. */
  | ({ type: 'task_panel'; taskId: string } & TaskPanel)
  /** A cut-off run goes again: show `text` in place of what you had of its turn. */
  | { type: 'task_restarted'; taskId: string; epoch: number; text: string }
  | { type: 'task_succeeded'; taskId: string; manifest: Manifest }
  | { type: 'task_failed'; taskId: string; reason: string; kept?: Manifest }
  | { type: 'task_cancel_requested'; taskId: string; by: string }
  | { type: 'task_cancelled'; taskId: string; kept?: Manifest }
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
  'message.posted': {
    messageId: string;
    role: 'user' | 'assistant';
    text: string;
    at: number;
    /** On the person's own message: the id their client sent it under (older servers omit it). */
    clientMessageId?: string;
  };
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
  | 'finished'
  /** A proposed task the employee noticed (T30): a verb-first card, "Do it" or "Not now". */
  | 'suggestion';

/** What a proposed card shows beside its title. Absent on the offer to stop suggesting a kind. */
export interface SuggestionFacts {
  kind: string;
  mode: 'quick' | 'standard' | 'deep';
  estimateUsd: number;
  /** The estimate is what finished tasks of this kind typically cost. */
  typical: boolean;
  repo: string;
  detail: string;
  /** Text from outside the owner shaped the card: the task it starts runs tainted. */
  external: boolean;
}

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
  /** On `suggestion` items that are cards. */
  suggestion?: SuggestionFacts;
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

export type HomeCardKind = 'waiting' | 'suggestion' | 'finished' | 'note' | 'scheduled';

/** What a Home card points at: the client already holds or fetches the thing itself. */
export type HomeCardRef =
  | { type: 'inbox'; id: string }
  | { type: 'task'; id: string; conversationId: string }
  | { type: 'duty'; id: string; projectId: string }
  | { type: 'note'; id: string };

/**
 * One card of Home as the server keeps it: in the server's order (waiting, suggestions, finished
 * since the owner last left, notes, what runs next), with when this owner last saw it.
 */
export interface HomeCard {
  cardId: string;
  kind: HomeCardKind;
  ref: HomeCardRef;
  /** Position in the whole list, from 0. */
  rank: number;
  seenAt: number | null;
  /** The time the card is about: raised, finished, or next run. */
  at: number;
  /** On a finished card, how the task ended. */
  state?: 'succeeded' | 'failed' | 'cancelled';
  /** On a note, the server's words for it. */
  text?: string;
}

/**
 * An approval the owner chose to keep ("for this task", "for this repository"): what it lets the
 * agent do without asking again. Whose it is, and the call's exact arguments, stay on the server.
 */
export interface Grant {
  grantId: string;
  tool: string;
  repository: string;
  scope: 'task' | 'repository';
  createdAt: number;
  expiresAt: number;
  uses: number;
  lastUsedAt: number | null;
}

/** A standing duty of a project as the public API shows it (T23). Only what a page shows is typed. */
export interface DutyView {
  dutyId: string;
  name: string;
  trigger: { kind: string; everyMinutes?: number };
  authority: 'read-only' | 'open-pr' | 'merge-when-green';
  runBudgetUsd: number;
  dailyCapUsd: number;
  state: 'proposed' | 'active' | 'off';
  activatedAt: number | null;
  offReason: 'failures' | null;
  consecutiveFailures: number;
}
export interface ProjectView {
  projectId: string;
  repo: string;
  defaultBranch: string;
  duties: DutyView[];
}

/** One kind of suggestion in one project: its switch and what the owner did with its cards. */
export interface SuggestionKindView {
  kind: string;
  label: string;
  enabled: boolean;
  accepted: number;
  dismissed: number;
  ignored: number;
  ignoredInARow: number;
  backedOff: boolean;
  offer: 'none' | 'due' | 'offered' | 'off';
}
export interface SuggestionsView {
  kinds: SuggestionKindView[];
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
  /** The name says it is a picture; the server sends it as one only if its bytes agree. */
  image?: true;
}
export type ArtifactContent =
  | { kind: 'link'; url: string }
  | { kind: 'text'; name: string; text: string }
  | { kind: 'image'; name: string; blob: Blob };

/** Why a page is on a sources card; the words are the server's fixed set. */
export type SourceLabel =
  | 'source'
  | 'docs'
  | 'alternative'
  | 'pull_request'
  | 'preview'
  | 'test_report';
/** A page the task opened. The browser never contacts it: previews come through the server. */
export interface SourceListing {
  index: number;
  url: string;
  site: string;
  label: SourceLabel;
}
/** Where a message sent to a running task stands. */
export type TaskMessageState = 'pending' | 'delivered' | 'withdrawn' | 'unseen';

/** One step of a task's run. `label` is present only when the owner turned content on. */
export interface TimelineStep {
  stepId: string;
  kind: string;
  replay: 'safe' | 'never';
  state: 'running' | 'done' | 'failed' | 'interrupted';
  epoch: number;
  attempts: number;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  label?: string;
}
/** The run of a task as its log has it, the same one the task view is computed from. */
export interface RunTimeline {
  taskId: string;
  state: TaskView['state'];
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  runMs: number;
  turns: Array<{
    epoch: number;
    cause: 'start' | 'restart' | 'resume';
    startedAt: number;
    endedAt?: number;
    steps: number;
  }>;
  /** The latest turns the run has had (at most 100); `turnsTotal` counts them all. */
  turnsTotal: number;
  /** One page of the steps; `stepsTotal` counts them all and `stepsNext` is `after` of the next page. */
  steps: TimelineStep[];
  stepsTotal: number;
  stepsNext?: number;
  /** Thinned to a bounded series that keeps the first and the last point. */
  cost: Array<{ at: number; totalUsd: number }>;
  /** How many cost reports the log holds, those thinned away included. */
  costReports: number;
  messages: { sent: number; read: number; unseen: number; withdrawn: number };
  content: boolean;
  /** The server shortened the page of steps to keep the answer within its size limit. */
  truncated?: boolean;
}
export interface SourcePreview {
  site: string;
  title?: string;
  /** Whether the image route has bytes. */
  image: boolean;
}

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
  inboxItems: '/v1/inbox/items',
  grants: '/v1/inbox/grants',
  grant: (id: string) => `/v1/inbox/grants/${encodeURIComponent(id)}`,
  grantsRevoke: '/v1/inbox/grants/revoke',
  projects: '/v1/projects',
  home: '/v1/home',
  homeSeen: '/v1/home/seen',
  homeOrder: '/v1/home/order',
  inboxAnswer: (item: string) => `/v1/inbox/items/${encodeURIComponent(item)}/answer`,
  artifacts: (task: string) => `/v1/tasks/${encodeURIComponent(task)}/artifacts`,
  artifact: (task: string, index: number) => `${routes.artifacts(task)}/${index}`,
  timeline: (task: string) => `/v1/tasks/${encodeURIComponent(task)}/timeline`,
  taskMessages: (task: string) => `/v1/tasks/${encodeURIComponent(task)}/messages`,
  taskMessage: (task: string, message: string) =>
    `${routes.taskMessages(task)}/${encodeURIComponent(message)}`,
  sources: (task: string) => `/v1/tasks/${encodeURIComponent(task)}/sources`,
  sourcePreview: (task: string, index: number) => `${routes.sources(task)}/${index}/preview`,
  sourceImage: (task: string, index: number) => `${routes.sources(task)}/${index}/image`,
  // Web Push answers 404 until the server is configured with its signing key.
  pushKey: '/v1/push/key',
  pushSubscriptions: '/v1/push/subscriptions',
  // The person's own settings: `GET`, and `PATCH` with `{language}`.
  settings: '/v1/settings',
  // Who the token signs in as: `{ ownerId }`, the same for every session of an account.
  me: '/v1/me',
} as const;

/** The languages the server speaks to a person. A person who never chose reads `zh-Hans`. */
export type Language = 'zh-Hans' | 'zh-Hant' | 'en';

/** `GET /v1/settings`, and the answer to `PATCH /v1/settings`. */
export interface PersonSettings {
  /** What the server writes to this person in: mail, push words, Home notes, inbox asks, and the agent's replies in new conversations. */
  language: Language;
}

/** One device signed in to an account (`GET /v1/auth/sessions`). It never carries the token. */
export interface DeviceSession {
  sessionId: string;
  deviceLabel: string;
  createdAt: number;
  lastSeenAt: number;
  /** The device that asked. */
  current: boolean;
}

export interface SignedInDevices {
  sessions: DeviceSession[];
  identities: Array<{ provider: 'apple' | 'google' | 'email'; email?: string }>;
}
