import type { ResultManifest, TaskEvent, TaskView } from '@maka-cloud/orchestrator';
import { z } from 'zod';
import { type Language, messages } from './i18n.js';
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
 * The fixed sentence the supervisor built an ask from, and its parts (clipped and quote-safe there).
 * An item with one is said in the reader's language; one without (or with one this server does not
 * know) keeps the supervisor's English ask.
 */
const templateText = z.string().max(1000);
const templateCount = z.number().int().min(0).max(1_000_000);
const AskTemplate = z.discriminatedUnion('id', [
  z.object({ id: z.literal('stall'), title: templateText, minutes: templateCount }),
  z.object({
    id: z.literal('failed_twice'),
    title: templateText,
    count: templateCount,
    reason: templateText,
  }),
  z.object({ id: z.literal('low_confidence'), title: templateText, summary: templateText }),
  z.object({
    id: z.literal('finished'),
    title: templateText,
    outcome: z.enum(['succeeded', 'failed']),
    checked: z.enum(['passed', 'not_checked']).optional(),
    detail: templateText,
  }),
  z.object({
    id: z.literal('verification_failed'),
    title: templateText,
    count: templateCount,
    detail: templateText,
    more: templateCount,
  }),
  z.object({ id: z.literal('verification_incomplete'), title: templateText, detail: templateText }),
  z.object({
    id: z.literal('suggestion_offer'),
    count: templateCount,
    label: templateText,
    repo: templateText,
  }),
]);

const MAX_ASK = 600;

/** The ask of an item built from a known template, said in `language`; undefined for any other item. */
export function localizedAsk(template: unknown, language: Language): string | undefined {
  const parsed = AskTemplate.safeParse(template);
  if (!parsed.success) return undefined;
  const ask = messages(language).ask;
  const t = parsed.data;
  let said: string;
  switch (t.id) {
    case 'stall':
      said = ask.stall(t.title, t.minutes);
      break;
    case 'failed_twice':
      said = ask.failedTwice(t.title, t.count, t.reason);
      break;
    case 'low_confidence':
      said = ask.lowConfidence(t.title, t.summary);
      break;
    case 'finished':
      said =
        t.outcome === 'succeeded'
          ? ask.finished(t.title, t.checked, t.detail)
          : ask.failed(t.title, t.detail);
      break;
    case 'verification_failed':
      said = ask.verificationFailed(t.title, t.count, t.detail, t.more);
      break;
    case 'verification_incomplete':
      said = ask.verificationIncomplete(t.title, t.detail);
      break;
    case 'suggestion_offer':
      said = ask.suggestionOffer(t.count, t.label, t.repo);
      break;
  }
  const chars = [...said];
  return chars.length <= MAX_ASK ? said : `${chars.slice(0, MAX_ASK - 1).join('')}…`;
}

/**
 * An inbox item as clients see it. The supervisor builds its ask from agent-written
 * text (a failure reason, a summary), so it is scrubbed like error text. An approval's ask is the
 * conductor's card, which the approval binds word for word, so it is shown as it is (T15): the card
 * names no runner, and the rest is the owner's own call. With a `language`, an ask the supervisor
 * built from a fixed sentence is said in it; the template itself never leaves the server.
 */
export function toPublicItem(item: unknown, language?: Language): unknown {
  if (typeof item !== 'object' || item === null || !('ask' in item)) return item;
  const { askTemplate, ...rest } = item as { askTemplate?: unknown; ask: unknown; kind?: unknown };
  if (rest.kind === 'approval') return toPublicApproval(rest);
  const ask =
    (language === undefined ? undefined : localizedAsk(askTemplate, language)) ?? rest.ask;
  const scrubbed = typeof ask === 'string' ? { ...rest, ask: scrubErrorText(ask) } : rest;
  return 'suggestion' in scrubbed ? toPublicSuggestion(scrubbed) : scrubbed;
}

/**
 * A digest as clients see it: the summary is a model's text over agent-written asks, and each ask is
 * what an item shows, so both are scrubbed like error text.
 */
export function toPublicDigest(digest: unknown): unknown {
  if (typeof digest !== 'object' || digest === null) return digest;
  const record = digest as { summary?: unknown; items?: unknown };
  return {
    ...digest,
    ...(typeof record.summary === 'string' ? { summary: scrubErrorText(record.summary) } : {}),
    ...(Array.isArray(record.items)
      ? {
          items: record.items.map((item) =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as { ask?: unknown }).ask === 'string'
              ? { ...item, ask: scrubErrorText((item as { ask: string }).ask) }
              : item,
          ),
        }
      : {}),
  };
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

/** The answers that approve a held call: this once, and the two that also keep the approval as a grant. */
const APPROVING_OPTIONS: ReadonlySet<unknown> = new Set([
  'approve',
  'approve_task',
  'approve_repository',
]);

/** The options of a question with every one that approves taken out. */
function withoutApprove(options: unknown[]): unknown[] {
  return options.filter((option) => !APPROVING_OPTIONS.has((option as { id?: unknown })?.id));
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
    case 'task_narration':
      return { ...event, line: scrubErrorText(event.line) };
    case 'task_panel':
      // The summary is one of a fixed few shapes; the title and the tail are the run's own words.
      return {
        ...event,
        title: scrubErrorText(event.title),
        ...(event.tail === undefined ? {} : { tail: scrubErrorText(event.tail) }),
      };
    case 'step_intent':
    case 'step_outcome':
      // A step's label and output are one line of what a tool did or printed.
      return scrubSecretFields(event);
    default:
      return event;
  }
}
