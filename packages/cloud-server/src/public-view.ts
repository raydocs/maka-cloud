import type { ResultManifest, TaskEvent, TaskView } from '@maka-cloud/orchestrator';
import { scrubSecretFields, scrubSecretShapes } from './secret-shapes.js';

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
  return scrubSecretShapes(value.normalize('NFKC').replace(/[\p{Cf}]/gu, '')).replace(
    HIDDEN_NAMES,
    'assistant',
  );
}

/**
 * Text as clients see it when only the secrets must go: what an assistant wrote, or a manifest a
 * runner returned, may name any vendor but must not carry a key. Text with nothing in it comes
 * back untouched, so an emoji joined by a zero-width joiner survives; text that hides a key behind
 * invisible characters comes back without them.
 */
export function scrubSecretText(value: string): string {
  const plain = value.normalize('NFKC').replace(/[\p{Cf}]/gu, '');
  const scrubbed = scrubSecretShapes(plain);
  return scrubbed === plain ? scrubSecretShapes(value) : scrubbed;
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
  const carries = (value: unknown) => {
    const text = JSON.stringify(value) ?? '';
    return scrubSecretText(text) !== text;
  };
  const { ask, evidence, options } = item as {
    ask?: unknown;
    evidence?: unknown;
    options?: unknown;
  };
  if (!carries(ask) && !carries(evidence)) return item;
  return {
    ...item,
    ask: WITHHELD_APPROVAL,
    evidence: [],
    ...(Array.isArray(options)
      ? { options: options.filter((option) => (option as { id?: unknown })?.id !== 'approve') }
      : {}),
  };
}

export function toPublicView(view: TaskView): PublicTaskView {
  const { runner: _runner, ...rest } = view;
  return {
    ...rest,
    ...(rest.manifest === undefined ? {} : { manifest: toPublicManifest(rest.manifest) }),
    ...(rest.kept === undefined ? {} : { kept: toPublicManifest(rest.kept) }),
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
      return {
        ...event,
        reason: scrubErrorText(event.reason),
        ...(event.kept === undefined ? {} : { kept: toPublicManifest(event.kept) }),
      };
    case 'task_cancelled':
      return event.kept === undefined ? event : { ...event, kept: toPublicManifest(event.kept) };
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
