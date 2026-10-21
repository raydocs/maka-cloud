import type { ResultManifest, TaskEvent, TaskView } from '@maka-cloud/orchestrator';
import {
  containsSecret,
  scrubSecretFields,
  scrubSecretShapes,
  scrubSecretText,
  scrubReading,
} from './secret-shapes.js';

export { scrubSecretText };

/**
 * What the public API shows of a task. The runner id names the vendor behind a
 * run, so it never leaves the server. `costUsd` comes from the view: the
 * orchestrator's `task_cost` events add up there, and it is absent until the
 * first one.
 */
export type PublicTaskView = Omit<TaskView, 'runner'>;

/** The names cloud-web hides (packages/cloud-web/src/presentation.ts); error text a runner wrote can carry them. */
const HIDDEN_NAMES =
  /claude|codex|gpt|anthropic|open[\s_-]*ai|gemini|deepseek|grok|llama|mistral|qwen|google|meta\b|xai|cohere|sonnet|haiku|opus/giu;

/**
 * Error text as clients see it: no keys or bearer tokens (a failed request often echoes its own
 * headers), and no model or vendor names, by the rule cloud-web applies. Hidden characters go
 * first so one cannot split a token past the patterns.
 */
export function scrubErrorText(value: string): string {
  return scrubReading(value, (text) => scrubSecretShapes(text).replace(HIDDEN_NAMES, 'assistant'));
}

/** A result manifest as clients see it. Every line of it is the runner's own words. */
function toPublicManifest(manifest: ResultManifest): ResultManifest {
  const lines = (values: string[]) => values.map(scrubSecretText);
  return {
    ...manifest,
    summary: scrubSecretText(manifest.summary),
    done: lines(manifest.done),
    notDone: lines(manifest.notDone),
    knownIssues: lines(manifest.knownIssues),
    ...(manifest.artifacts === undefined ? {} : { artifacts: lines(manifest.artifacts) }),
  };
}

/**
 * An inbox item as clients see it. The supervisor builds its ask from agent-written
 * text (a failure reason, a summary), so it is scrubbed like error text. An approval's ask is the
 * conductor's card, which the approval binds word for word, so it is shown as it is (T15): the card
 * names no runner, and the rest is the owner's own call.
 */
export function toPublicItem(item: unknown): unknown {
  if (typeof item !== 'object' || item === null || !('ask' in item)) return item;
  if ('kind' in item && item.kind === 'approval') return toPublicApproval(item);
  const scrubbed = typeof item.ask === 'string' ? { ...item, ask: scrubErrorText(item.ask) } : item;
  return 'suggestion' in scrubbed ? toPublicSuggestion(scrubbed) : scrubbed;
}

/** A proposed card's facts: its detail quotes a pull request or an issue, so it is scrubbed like the ask. */
function toPublicSuggestion(item: object): unknown {
  const suggestion = (item as { suggestion?: unknown }).suggestion;
  if (typeof suggestion !== 'object' || suggestion === null) return item;
  const facts = suggestion as Record<string, unknown>;
  return {
    ...item,
    suggestion: {
      ...facts,
      ...(typeof facts.detail === 'string' ? { detail: scrubErrorText(facts.detail) } : {}),
      ...(typeof facts.repo === 'string' ? { repo: scrubErrorText(facts.repo) } : {}),
    },
  };
}

/** What an approval shows when its card carries a secret: the owner cannot approve what they were not shown. */
export const WITHHELD_APPROVAL =
  'This approval cannot be shown: the action it would run carries a key or token. Decline it.';

/**
 * An approval binds its card word for word (T15), so the text is never edited. The conductor does
 * not ask for an approval whose card carries a secret; one that is stored anyway (from before that
 * rule) is withheld whole and offers no way to approve.
 */
function toPublicApproval(item: object): unknown {
  const { ask, evidence, options } = item as {
    ask?: unknown;
    evidence?: unknown;
    options?: unknown;
  };
  if (!containsSecret({ ask, evidence, options })) return item;
  return {
    ...item,
    ask: WITHHELD_APPROVAL,
    evidence: [],
    ...(Array.isArray(options) ? { options: withoutApprove(options) } : {}),
  };
}

/** The options of a question with the one that approves taken out. */
function withoutApprove(options: unknown[]): unknown[] {
  return options.filter((option) => (option as { id?: unknown })?.id !== 'approve');
}

export function toPublicView(view: TaskView): PublicTaskView {
  const { runner: _runner, ...rest } = view;
  return {
    ...rest,
    ...(rest.manifest === undefined ? {} : { manifest: toPublicManifest(rest.manifest) }),
    // The runner's progress notes carry whatever its tools printed.
    ...(Array.isArray(rest.progress) ? { progress: rest.progress.map(scrubErrorText) } : {}),
    ...(rest.failureReason === undefined
      ? {}
      : { failureReason: scrubErrorText(rest.failureReason) }),
  };
}

/**
 * What the conductor published into a conversation, as clients see it. A notice is the conductor's
 * own words about a run, which can quote what a tool printed; a question's note is the model's.
 * The held call of an irreversible question is the one thing shown as it is, because the approval
 * binds it word for word (T15).
 */
export function toPublicConductorData(kind: string, data: unknown): unknown {
  if (typeof data !== 'object' || data === null) return data;
  const record = data as Record<string, unknown>;
  const text = (value: unknown): unknown =>
    typeof value === 'string' ? scrubErrorText(value) : value;
  if (kind === 'conductor.notice') return { ...record, text: text(record.text) };
  if (kind === 'conductor.question') {
    // A question that was stored with a key in it (before the conductor stopped asking those) is
    // withheld whole, the call it would run included, and offers no way to approve: the card binds
    // the call word for word, so it cannot be shown edited, and the backend refuses to run it.
    if (
      record.action !== undefined &&
      containsSecret({ question: record.question, action: record.action })
    ) {
      return {
        ...record,
        question: WITHHELD_APPROVAL,
        note: null,
        action: undefined,
        options: Array.isArray(record.options) ? withoutApprove(record.options) : record.options,
      };
    }
    return {
      ...record,
      question: text(record.question),
      note: text(record.note),
      options: Array.isArray(record.options)
        ? record.options.map((option) =>
            typeof option === 'object' && option !== null
              ? { ...option, label: text((option as { label?: unknown }).label) }
              : option,
          )
        : record.options,
    };
  }
  return record;
}

/** A logged event as clients see it: without the runner id, and with error text scrubbed. */
export function toPublicEvent(event: TaskEvent): unknown {
  switch (event.type) {
    case 'task_created': {
      const { runner: _runner, ...rest } = event;
      return rest;
    }
    case 'task_failed':
    case 'task_pause_failed':
    case 'task_resume_failed':
      return { ...event, reason: scrubErrorText(event.reason) };
    case 'task_succeeded':
      return { ...event, manifest: toPublicManifest(event.manifest) };
    case 'task_progress':
      return { ...event, note: scrubErrorText(event.note) };
    case 'step_intent':
    case 'step_outcome':
      // A step's label and output are one line of what a tool did or printed.
      return scrubSecretFields(event);
    default:
      return event;
  }
}
