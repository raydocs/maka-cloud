import { createHash } from 'node:crypto';
import type { Signal, SignalManifest, SignalTaskEvent } from './events.js';
import { stableHash } from './hash.js';
import type { Settings } from './settings.js';
import type { ItemRecord, ItemSpec, Store, TaskRecord, VerificationRecord } from './store.js';
import { clip, quoted } from './text.js';
import type { CloseReason, EvidenceLink, ItemContext, ItemOption } from './types.js';
import { verificationKindOf } from './verification/kind.js';

/**
 * The escalation rules. Everything here is deterministic code over the
 * projection: no model, no clock except the timestamps it is given. Each
 * function runs inside the transaction that also advances the feed cursor, so a
 * restart repeats nothing.
 *
 * | Rule | Source |
 * | R1 conductor asked        | `conductor.question`, kind from its code-set reason |
 * | R2 same step failed twice | second `task_failed` with the same step key         |
 * | R3 failed verification    | `settleVerification`, from the verification runner   |
 * | R4 no progress            | `stallPass`, driven by the tick                      |
 * | R5 low confidence         | `task_succeeded` with `confidence: low`              |
 */

export interface RuleContext {
  settings: Settings;
  /** Signals older than this are history from before the supervisor first started: they update the projection but raise no items. */
  historyBefore: number;
  /** Finished top-level tasks are checked independently before they are shown as finished. */
  verification: boolean;
}

const MAX_ASK = 600;
const MAX_EVIDENCE = 10;

// ---------------------------------------------------------------- items

export interface OpenResult {
  item: ItemRecord;
  created: boolean;
  refreshed: boolean;
}

/** Opens an item, or refreshes the open one with the same dedupe key when what it shows changed. */
export function openItem(store: Store, spec: ItemSpec, at: number): OpenResult {
  const existing = store.openItemByDedupe(spec.dedupeKey);
  if (!existing) {
    return { item: store.insertItem(spec, at), created: true, refreshed: false };
  }
  // An answer is on its way: what the human saw is what they answered.
  if (existing.state === 'answering') return { item: existing, created: false, refreshed: false };
  const same =
    existing.ask === spec.ask &&
    existing.precondition === spec.precondition &&
    JSON.stringify(existing.options) === JSON.stringify(spec.options) &&
    JSON.stringify(existing.evidence) === JSON.stringify(spec.evidence) &&
    JSON.stringify(existing.context) === JSON.stringify(spec.context);
  if (same) return { item: existing, created: false, refreshed: false };
  store.refreshItem(existing.itemId, spec, at);
  return { item: store.item(existing.itemId) as ItemRecord, created: false, refreshed: true };
}

/** Closes the items whose dedupe key starts with `prefix`, except those with an answer on its way. */
export function closeItems(store: Store, prefix: string, reason: CloseReason, at: number): void {
  for (const item of store.activeItemsByKeyPrefix(prefix)) {
    if (item.state === 'open') store.closeItem(item.itemId, reason, at);
  }
}

// ------------------------------------------------------------ builders

function evidenceOf(taskId: string, manifest: SignalManifest | null | undefined): EvidenceLink[] {
  const links: EvidenceLink[] = [];
  for (const ref of manifest?.artifacts ?? []) {
    if (links.length >= MAX_EVIDENCE) break;
    if (/^https:\/\//iu.test(ref)) {
      try {
        const url = new URL(ref);
        if (url.username === '' && url.password === '') {
          links.push({ kind: 'link', url: url.href, label: clip(url.host, 80) });
        }
      } catch {
        // Not a URL; not evidence.
      }
    } else {
      const name = ref.split(/[\\/]/u).pop() ?? '';
      if (name !== '') links.push({ kind: 'artifact', taskId, name: clip(name, 120) });
    }
  }
  return links;
}

export function digestOf(manifest: SignalManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

/** What an item depends on, by subject. Equal fingerprints mean the item is still true. */
export function fingerprint(store: Store, context: ItemContext): unknown {
  switch (context.subject) {
    case 'question':
      return {
        subject: 'question',
        questionId: context.questionId,
        state: store.question(context.questionId ?? '')?.state ?? 'missing',
      };
    case 'stall': {
      const task = store.task(context.taskId ?? '');
      return {
        subject: 'stall',
        taskId: context.taskId,
        state: task?.state ?? 'missing',
        paused: task?.paused ?? false,
        last: task?.lastActivityAt ?? 0,
      };
    }
    case 'failed_twice':
      return {
        subject: 'failed_twice',
        stepKey: context.stepKey,
        failed: store.failedTasks(context.stepKey ?? ''),
      };
    case 'result':
      return {
        subject: 'result',
        taskId: context.taskId,
        manifestDigest: context.manifestDigest ?? null,
      };
    // A spending limit that stopped work stays true until the human acknowledges it.
    case 'cap':
      return { subject: 'cap', key: context.detail ?? null };
    case 'verification': {
      const verification = store.verification(context.taskId ?? '');
      return {
        subject: 'verification',
        verificationId: context.verificationId,
        epoch: verification?.epoch ?? -1,
        state: verification?.state ?? 'missing',
      };
    }
  }
}

export function preconditionOf(store: Store, context: ItemContext): string {
  return stableHash(fingerprint(store, context));
}

const STALL_OPTIONS: ItemOption[] = [
  {
    id: 'check',
    label: 'Ask the agent to check on it',
    recommended: true,
    effect: 'message',
    messageKey: 'check_stalled',
  },
  {
    id: 'cancel',
    label: 'Cancel it',
    recommended: false,
    effect: 'message',
    messageKey: 'cancel_stalled',
  },
  {
    id: 'wait',
    label: 'Keep waiting',
    recommended: false,
    effect: 'local',
    closeReason: 'acknowledged',
  },
];

const FAILED_TWICE_OPTIONS: ItemOption[] = [
  {
    id: 'retry',
    label: 'Ask the agent to try a different approach',
    recommended: true,
    effect: 'message',
    messageKey: 'retry_differently',
  },
  {
    id: 'stop',
    label: 'Stop this work',
    recommended: false,
    effect: 'message',
    messageKey: 'stop_work',
  },
  {
    id: 'leave',
    label: 'Leave it',
    recommended: false,
    effect: 'local',
    closeReason: 'acknowledged',
  },
];

const LOW_CONFIDENCE_OPTIONS: ItemOption[] = [
  {
    id: 'redo',
    label: 'Ask the agent to redo it',
    recommended: true,
    effect: 'message',
    messageKey: 'redo_low_confidence',
  },
  {
    id: 'accept',
    label: 'Accept it as is',
    recommended: false,
    effect: 'local',
    closeReason: 'accepted',
  },
];

const FINISHED_OPTIONS: ItemOption[] = [
  { id: 'ok', label: 'Got it', recommended: true, effect: 'local', closeReason: 'acknowledged' },
];

/** A budget item for a spending limit (an invite's or the server's) that stopped work. */
export function capSpec(
  store: Store,
  input: { conversationId: string; taskId: string | null; key: string; ask: string },
): ItemSpec {
  const context: ItemContext = { subject: 'cap', detail: input.key };
  return {
    kind: 'budget',
    conversationId: input.conversationId,
    taskId: input.taskId,
    dedupeKey: `cap:${input.key}`,
    ask: clip(input.ask, MAX_ASK),
    options: FINISHED_OPTIONS,
    allowText: false,
    evidence: [],
    context,
    precondition: preconditionOf(store, context),
  };
}

export function stallSpec(store: Store, task: TaskRecord, at: number): ItemSpec {
  const context: ItemContext = {
    subject: 'stall',
    taskId: task.taskId,
    ...(task.title === null ? {} : { taskTitle: task.title }),
    idleMinutes: Math.max(0, Math.floor((at - task.lastActivityAt) / 60_000)),
  };
  return {
    kind: 'blocked',
    conversationId: task.conversationId,
    taskId: task.taskId,
    dedupeKey: `stall:${task.taskId}`,
    ask: `The task ${quoted(task.title)} has had no progress for ${context.idleMinutes} minutes.`,
    options: STALL_OPTIONS,
    allowText: true,
    evidence: [],
    context,
    precondition: preconditionOf(store, context),
  };
}

function failedTwiceSpec(
  store: Store,
  task: TaskRecord,
  stepKey: string,
  reason: string,
  count: number,
): ItemSpec {
  const context: ItemContext = {
    subject: 'failed_twice',
    stepKey,
    taskId: task.taskId,
    count,
    detail: clip(reason, 200),
    ...(task.title === null ? {} : { taskTitle: task.title }),
  };
  return {
    kind: 'blocked',
    conversationId: task.conversationId,
    taskId: task.taskId,
    dedupeKey: `failed2:${stepKey}`,
    ask: `The step ${quoted(task.title)} has failed ${count} times. Last reason: ${quoted(reason, 200)}`,
    options: FAILED_TWICE_OPTIONS,
    allowText: true,
    evidence: [],
    context,
    precondition: preconditionOf(store, context),
  };
}

function lowConfidenceSpec(store: Store, task: TaskRecord, manifest: SignalManifest): ItemSpec {
  const context: ItemContext = {
    subject: 'result',
    taskId: task.taskId,
    manifestDigest: digestOf(manifest),
    ...(task.title === null ? {} : { taskTitle: task.title }),
  };
  return {
    kind: 'decision',
    conversationId: task.conversationId,
    taskId: task.taskId,
    dedupeKey: `lowconf:${task.taskId}`,
    ask: clip(
      `The result of ${quoted(task.title)} came back with low confidence: ${quoted(manifest.summary, 240)}`,
      MAX_ASK,
    ),
    options: LOW_CONFIDENCE_OPTIONS,
    allowText: true,
    evidence: evidenceOf(task.taskId, manifest),
    context,
    precondition: preconditionOf(store, context),
  };
}

export function finishedSpec(
  store: Store,
  task: TaskRecord,
  outcome: 'succeeded' | 'failed',
  detail: string,
  manifest?: SignalManifest,
  checked?: 'passed' | 'not_checked',
): ItemSpec {
  const context: ItemContext = {
    subject: 'result',
    taskId: task.taskId,
    outcome,
    manifestDigest: manifest ? digestOf(manifest) : stableHash(detail),
    ...(checked === undefined ? {} : { checked }),
    ...(task.title === null ? {} : { taskTitle: task.title }),
  };
  const note =
    checked === 'passed'
      ? ' (independently checked)'
      : checked === 'not_checked'
        ? ' (not independently checked)'
        : '';
  return {
    kind: 'finished',
    conversationId: task.conversationId,
    taskId: task.taskId,
    dedupeKey: `finished:${task.taskId}`,
    ask: clip(
      outcome === 'succeeded'
        ? `${quoted(task.title)} finished${note}: ${quoted(detail, 240)}`
        : `${quoted(task.title)} failed: ${quoted(detail, 240)}`,
      MAX_ASK,
    ),
    options: FINISHED_OPTIONS,
    allowText: false,
    evidence: evidenceOf(task.taskId, manifest),
    context,
    precondition: preconditionOf(store, context),
  };
}

const REASON_KIND = {
  taste: 'decision',
  irreversible: 'approval',
  budget_overrun: 'budget',
} as const;

function questionSpec(store: Store, signal: Extract<Signal, { type: 'question' }>): ItemSpec {
  const { question } = signal;
  const options: ItemOption[] = question.options
    .map((option) => ({
      id: option.id,
      label: clip(option.label, 120),
      recommended: option.id === question.recommended,
      effect: 'answer_question' as const,
    }))
    .sort((a, b) => Number(b.recommended) - Number(a.recommended));
  const context: ItemContext = { subject: 'question', questionId: question.questionId };
  const evidence: EvidenceLink[] = question.action
    ? [
        {
          kind: 'action',
          tool: clip(question.action.tool, 80),
          args: clip(JSON.stringify(question.action.args ?? null), 1500),
        },
      ]
    : [];
  return {
    kind: REASON_KIND[question.reason],
    conversationId: signal.conversationId,
    taskId: null,
    dedupeKey: `question:${question.questionId}`,
    ask: clip(question.question, MAX_ASK),
    options,
    // Approval and budget answers are an explicit option, never words the model could read as consent.
    allowText: question.reason === 'taste',
    evidence,
    context,
    precondition: preconditionOf(store, context),
  };
}

// -------------------------------------------------------------- signals

/** Reasons ending in a restart are not the step's fault. */
function isOrphan(reason: string): boolean {
  return reason.startsWith('orphaned');
}

function reasonFingerprint(reason: string): string {
  return clip(
    reason
      .toLowerCase()
      .replace(/\b[0-9a-f]{8,}\b/gu, '#')
      .replace(/\d+/gu, '#'),
    120,
  );
}

function stepKeyOf(
  conversationId: string,
  parentTaskId: string | null,
  runner: string,
  title: string,
): string {
  return stableHash({ conversationId, parent: parentTaskId ?? 'root', runner, title });
}

export function applySignal(store: Store, signal: Signal, rule: RuleContext): void {
  const history = signal.at < rule.historyBefore;
  switch (signal.type) {
    case 'task':
      applyTask(store, signal.conversationId, signal.at, signal.event, history, rule.verification);
      return;
    case 'user_message':
      // A message sent instead of an answer dismisses the conductor's open question.
      for (const question of store.openQuestions(signal.conversationId)) {
        if (question.askedFeedId >= signal.feedId) continue;
        store.setQuestionState(question.questionId, 'dismissed');
        closeItems(store, `question:${question.questionId}`, 'condition_cleared', signal.at);
      }
      return;
    case 'question': {
      store.insertQuestion({
        questionId: signal.question.questionId,
        conversationId: signal.conversationId,
        state: 'open',
        askedFeedId: signal.feedId,
      });
      openItem(store, questionSpec(store, signal), signal.at);
      return;
    }
    case 'answered':
      store.setQuestionState(signal.questionId, 'answered');
      // An item with an answer on its way is closed by that delivery, not here.
      closeItems(store, `question:${signal.questionId}`, 'handled_elsewhere', signal.at);
      return;
  }
}

function applyTask(
  store: Store,
  conversationId: string,
  at: number,
  event: SignalTaskEvent,
  history: boolean,
  checking: boolean,
): void {
  const settle = (taskId: string) => {
    for (const cleared of store.bumpActivity(taskId, at)) {
      closeItems(store, `stall:${cleared}`, 'condition_cleared', at);
    }
  };
  switch (event.type) {
    case 'task_created': {
      const parent = event.parentTaskId ?? null;
      const title = event.title ?? '';
      store.insertTask({
        taskId: event.taskId,
        conversationId,
        parentTaskId: parent,
        runner: event.runner ?? null,
        title: event.title ?? null,
        stepKey: stepKeyOf(conversationId, parent, event.runner ?? '', title),
        state: 'queued',
        paused: false,
        createdAt: at,
        lastActivityAt: at,
        stallRaised: false,
        finishedAt: null,
        manifest: null,
      });
      if (parent) settle(parent);
      return;
    }
    case 'task_started':
      if (!store.task(event.taskId)) return;
      store.setTaskState(event.taskId, 'running', at);
      settle(event.taskId);
      return;
    case 'task_paused':
      if (!store.task(event.taskId)) return;
      store.setPaused(event.taskId, true);
      settle(event.taskId);
      return;
    case 'task_resumed':
      if (!store.task(event.taskId)) return;
      store.setPaused(event.taskId, false);
      settle(event.taskId);
      return;
    case 'task_progress':
    case 'task_cost':
    case 'task_pause_requested':
    case 'task_pause_failed':
    case 'task_resume_requested':
    case 'task_cancel_requested':
      if (store.task(event.taskId)) settle(event.taskId);
      return;
    case 'task_succeeded':
      return endSucceeded(store, event.taskId, event.manifest, at, history, checking);
    case 'task_failed':
      return endFailed(store, event.taskId, event.reason, at, history);
    case 'task_cancelled': {
      if (!store.task(event.taskId)) return;
      store.setTaskState(event.taskId, 'cancelled', at);
      closeItems(store, `stall:${event.taskId}`, 'condition_cleared', at);
      return;
    }
  }
}

function endSucceeded(
  store: Store,
  taskId: string,
  manifest: SignalManifest,
  at: number,
  history: boolean,
  checking: boolean,
): void {
  const task = store.task(taskId);
  if (!task || task.state === 'succeeded') return;
  store.setTaskState(taskId, 'succeeded', at, manifest);
  closeItems(store, `stall:${taskId}`, 'condition_cleared', at);
  // A success ends the step's failure streak, for titled and untitled steps alike.
  store.clearFailures(task.stepKey);
  closeItems(store, `failed2:${task.stepKey}`, 'condition_cleared', at);
  if (history || task.parentTaskId !== null) return;
  const done = store.task(taskId) as TaskRecord;
  if (manifest.confidence === 'low') {
    // The decision already stands in for the finished item; the check runs alongside it.
    openItem(store, lowConfidenceSpec(store, done, manifest), at);
  }
  if (!checking) {
    if (manifest.confidence !== 'low') {
      openItem(store, finishedSpec(store, done, 'succeeded', manifest.summary, manifest), at);
    }
    return;
  }
  // One verification per task: a repeated event or a restart finds it claimed.
  const kind = verificationKindOf(manifest);
  store.enqueueVerification(done, kind ?? 'none', at);
  if (kind === undefined && manifest.confidence !== 'low') {
    openItem(
      store,
      finishedSpec(store, done, 'succeeded', manifest.summary, manifest, 'not_checked'),
      at,
    );
  }
}

function endFailed(
  store: Store,
  taskId: string,
  reason: string,
  at: number,
  history: boolean,
): void {
  const task = store.task(taskId);
  if (!task || task.state === 'failed') return;
  store.setTaskState(taskId, 'failed', at);
  closeItems(store, `stall:${taskId}`, 'condition_cleared', at);
  if (!isOrphan(reason)) {
    const key = task.title ? task.stepKey : `${task.stepKey}:${reasonFingerprint(reason)}`;
    store.recordFailure(key, taskId, at);
    const failed = store.failedTasks(key);
    if (failed.length >= 2 && !history) {
      openItem(store, failedTwiceSpec(store, task, key, reason, failed.length), at);
    }
  }
  if (!history && task.parentTaskId === null) {
    openItem(store, finishedSpec(store, task, 'failed', reason), at);
  }
}

// ----------------------------------------------------------------- tick

/** R4: raises one item per stalled task. Paused tasks are not stalled. */
export function stallPass(store: Store, settings: Settings, at: number): number {
  const idle = store.idleTasks(
    at - settings.stallAfterMinutes * 60_000,
    at - settings.queuedStallAfterMinutes * 60_000,
  );
  for (const task of idle) {
    store.setStallRaised(task.taskId);
    openItem(store, stallSpec(store, task, at), at);
  }
  return idle.length;
}

// ------------------------------------------------------------ reassess

export type Reassessment =
  | { action: 'keep' }
  | { action: 'close'; reason: CloseReason }
  | { action: 'refresh'; spec: ItemSpec };

/**
 * Compares what an item was based on with the state now. Equal means the item
 * is still true. The rules keep items current as events arrive, so a
 * difference after the feed was caught up means something was missed; the item
 * is refreshed or closed instead of acted on.
 */
export function reassess(store: Store, item: ItemRecord, at: number): Reassessment {
  const context = item.context;
  if (preconditionOf(store, context) === item.precondition) return { action: 'keep' };
  switch (context.subject) {
    case 'question':
      return { action: 'close', reason: 'handled_elsewhere' };
    case 'stall': {
      const task = store.task(context.taskId ?? '');
      if (!task || (task.state !== 'running' && task.state !== 'queued') || task.paused) {
        return { action: 'close', reason: 'condition_cleared' };
      }
      return task.stallRaised
        ? { action: 'refresh', spec: stallSpec(store, task, at) }
        : { action: 'close', reason: 'condition_cleared' };
    }
    case 'failed_twice': {
      const failed = store.failedTasks(context.stepKey ?? '');
      const latest = store.task(failed.at(-1) ?? '');
      if (failed.length < 2 || !latest) return { action: 'close', reason: 'condition_cleared' };
      return {
        action: 'refresh',
        spec: failedTwiceSpec(
          store,
          latest,
          context.stepKey ?? '',
          context.detail ?? '',
          failed.length,
        ),
      };
    }
    case 'result':
    case 'cap':
      return { action: 'keep' };
    case 'verification':
      // Checked again, or settled differently, since the human looked.
      return { action: 'close', reason: 'condition_cleared' };
  }
}

// --------------------------------------------------------- verification

type VerifyFailure =
  | { state: 'failed'; mismatches: Array<{ claim: string; found: string }> }
  | { state: 'could_not_check'; code: string; reason: string };

function verificationFailedOptions(couldNotCheck: boolean): ItemOption[] {
  const fix: ItemOption = {
    id: 'fix',
    label: 'Ask the agent to fix it',
    recommended: !couldNotCheck,
    effect: 'message',
    messageKey: 'fix_verification',
  };
  const accept: ItemOption = {
    id: 'accept',
    label: 'Accept it anyway',
    recommended: false,
    effect: 'local',
    closeReason: 'accepted',
  };
  if (!couldNotCheck) return [fix, accept];
  return [
    {
      id: 'again',
      label: 'Check again',
      recommended: true,
      effect: 'local',
      closeReason: 'acknowledged',
      localAction: 'recheck',
    },
    fix,
    accept,
  ];
}

export function verificationFailedSpec(
  store: Store,
  task: TaskRecord,
  verification: VerificationRecord,
  outcome: VerifyFailure,
): ItemSpec {
  const failed = outcome.state === 'failed';
  const detail = failed
    ? outcome.mismatches
        .slice(0, 3)
        .map((mismatch) => `${quoted(mismatch.claim, 100)}: ${quoted(mismatch.found, 120)}`)
        .join('; ')
    : outcome.reason;
  const more =
    failed && outcome.mismatches.length > 3 ? ` (and ${outcome.mismatches.length - 3} more)` : '';
  const context: ItemContext = {
    subject: 'verification',
    taskId: task.taskId,
    verificationId: verification.verificationId,
    verificationEpoch: verification.epoch,
    verificationState: outcome.state,
    detail: clip(detail, 300),
    ...(failed ? { count: outcome.mismatches.length } : {}),
    ...(task.title === null ? {} : { taskTitle: task.title }),
  };
  return {
    kind: 'verification_failed',
    conversationId: task.conversationId,
    taskId: task.taskId,
    dedupeKey: `verify:${task.taskId}`,
    ask: clip(
      failed
        ? `The independent check of ${quoted(task.title)} found ${outcome.mismatches.length} ${outcome.mismatches.length === 1 ? 'problem' : 'problems'}: ${detail}${more}`
        : `The independent check of ${quoted(task.title)} could not be completed, so the result is not verified: ${detail}`,
      MAX_ASK,
    ),
    options: verificationFailedOptions(!failed),
    allowText: true,
    evidence: evidenceOf(task.taskId, task.manifest),
    context,
    precondition: preconditionOf(store, context),
  };
}

/**
 * Records how a verification ended and raises what the human should see, in
 * the caller's transaction. A check that could not run for a passing reason
 * goes back in the queue until `maxAttempts`; every other end is final.
 */
export function settleVerification(
  store: Store,
  verification: VerificationRecord,
  outcome:
    | { state: 'passed' }
    | VerifyFailure
    | { state: 'retry'; reason: string; nextAttemptAt: number },
  at: number,
): void {
  const task = store.task(verification.taskId);
  if (!task) return;
  if (outcome.state === 'retry') {
    store.retryVerificationLater(
      verification.verificationId,
      outcome.reason,
      outcome.nextAttemptAt,
      at,
    );
    return;
  }
  if (outcome.state === 'passed') {
    store.finishVerification(verification.verificationId, 'passed', null, null, at);
    if (task.manifest && task.manifest.confidence !== 'low') {
      openItem(
        store,
        finishedSpec(store, task, 'succeeded', task.manifest.summary, task.manifest, 'passed'),
        at,
      );
    }
    return;
  }
  store.finishVerification(
    verification.verificationId,
    outcome.state,
    outcome.state === 'failed' ? 'mismatches' : outcome.reason,
    outcome.state === 'failed' ? { mismatches: outcome.mismatches } : { code: outcome.code },
    at,
  );
  const current = store.verification(task.taskId) as VerificationRecord;
  openItem(store, verificationFailedSpec(store, task, current, outcome), at);
}
