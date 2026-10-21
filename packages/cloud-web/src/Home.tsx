import { useEffect, useRef, useState } from 'react';
import { type CloudClient, Unsupported } from './client';
import type { Conversation, InboxItem, ProjectView, TaskView } from './contract';
import { TERMINAL } from './contract';
import { errorText } from './errors';
import { InboxCard } from './Inbox';
import { inboxAnswerer } from './inboxAnswer';
import { displayText, dollars, firstSentence } from './presentation';
import { mergeInboxItem } from './state';

const DAY_MS = 86_400_000;
const RECENT_CONVERSATIONS = 5;
const DONE_LINES = 8;

export interface DoneEntry {
  conversationId: string;
  taskId: string;
  title: string;
  state: TaskView['state'];
  outcome: string;
  costUsd: number | undefined;
  finishedAt: number;
  task: TaskView;
}

/** What finished since `since`: top-level tasks only (a subtask is part of its parent's story), newest first. */
export function doneSince(
  byConversation: ReadonlyMap<string, readonly TaskView[]>,
  since: number,
): DoneEntry[] {
  const entries: DoneEntry[] = [];
  for (const [conversationId, tasks] of byConversation) {
    for (const task of tasks) {
      if (task.parentTaskId !== undefined || !TERMINAL.has(task.state)) continue;
      if (task.finishedAt === undefined || task.finishedAt <= since) continue;
      const outcome =
        task.state === 'succeeded'
          ? firstSentence(task.manifest?.summary ?? 'Finished.')
          : task.state === 'cancelled'
            ? 'Stopped before it finished.'
            : firstSentence(task.failureReason ?? 'It did not finish.');
      entries.push({
        conversationId,
        taskId: task.taskId,
        title: task.title ?? 'Task',
        state: task.state,
        outcome,
        costUsd: task.costUsd,
        finishedAt: task.finishedAt,
        task,
      });
    }
  }
  return entries.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, DONE_LINES);
}

export interface NextRun {
  dutyId: string;
  name: string;
  repo: string;
  at: number;
}

/**
 * Scheduled duties that are on, soonest first. A schedule runs every `everyMinutes`, counted from the
 * moment the duty was approved; duties that wake on a GitHub event have no time, so they are counted.
 */
export function nextRuns(
  projects: readonly ProjectView[],
  now: number,
): { scheduled: NextRun[]; watching: number } {
  const scheduled: NextRun[] = [];
  let watching = 0;
  for (const project of projects) {
    for (const duty of project.duties) {
      if (duty.state !== 'active') continue;
      const period = (duty.trigger.everyMinutes ?? 0) * 60_000;
      if (duty.trigger.kind !== 'schedule' || period <= 0 || duty.activatedAt === null) {
        if (duty.trigger.kind !== 'schedule') watching += 1;
        continue;
      }
      const slots = Math.max(0, Math.floor((now - duty.activatedAt) / period)) + 1;
      scheduled.push({
        dutyId: duty.dutyId,
        name: duty.name,
        repo: project.repo,
        at: duty.activatedAt + slots * period,
      });
    }
  }
  return { scheduled: scheduled.sort((a, b) => a.at - b.at), watching };
}

/** "in 5 min", "in 3 h", "in 2 days": a time ahead, in the words a person would use. */
export function relativeTime(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  if (minutes < 1) return 'any moment now';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} days`;
}

const VERB: Record<string, string> = {
  approval: 'Approve',
  budget: 'Decide',
  decision: 'Decide',
  blocked: 'Unblock',
  verification_failed: 'Review',
  finished: 'Review',
};
export const verbOf = (kind: string) => VERB[kind] ?? 'Decide';

/** What the browser remembers about when this invite last looked at Home. Never the token. */
function visitKey(fingerprint: string) {
  return `maka.visit.${fingerprint}`;
}
function readVisit(fingerprint: string): number | undefined {
  try {
    const stored = Number(globalThis.localStorage?.getItem(visitKey(fingerprint)));
    return Number.isFinite(stored) && stored > 0 ? stored : undefined;
  } catch {
    return undefined;
  }
}
function writeVisit(fingerprint: string, at: number) {
  try {
    globalThis.localStorage?.setItem(visitKey(fingerprint), String(at));
  } catch {
    // Then every visit is a first one: the last day is shown.
  }
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-tile">
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
    </div>
  );
}

/**
 * Home: first what waits on the person (one-tap cards), then the start sentence, then what was done
 * since they were last here and what runs next. Each part fills in as its data arrives and stays
 * out of the way when the server has nothing, or no such feature.
 */
export function Home({
  client,
  conversations,
  onStarted,
  onOpen,
  onOpenTask,
  now = Date.now,
}: {
  client: CloudClient;
  conversations: Conversation[];
  onStarted: (conversation: Conversation) => void;
  onOpen: (conversationId: string) => void;
  /** Opens a finished task's own page; without it a finished line opens its conversation. */
  onOpenTask?: (task: TaskView) => void;
  now?: () => number;
}) {
  const [draft, setDraft] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  // A retry after a failed post reuses the conversation and the message id.
  const attempt = useRef<{
    conversationId: string;
    clientMessageId: string;
  } | null>(null);

  const [items, setItems] = useState<Record<string, InboxItem>>({});
  const [busy, setBusy] = useState(false);
  const [answerError, setAnswerError] = useState('');
  const pending = useRef(false);
  const answer = useRef(
    inboxAnswerer(client, (item) => setItems((held) => mergeInboxItem(held, item))),
  );

  const [since, setSince] = useState<number | undefined>();
  const [done, setDone] = useState<Map<string, readonly TaskView[]> | undefined>();
  const [projects, setProjects] = useState<ProjectView[] | undefined>();
  const [tick, setTick] = useState(0);

  // Come back to this tab and the decisions, results and schedule are read again.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setTick((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    let current = true;
    client
      .listInbox('open')
      .then((list) => {
        if (!current) return;
        setItems((held) => list.reduce((all, item) => mergeInboxItem(all, item), held));
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [client, tick]);

  useEffect(() => {
    let current = true;
    client
      .listProjects()
      .then((list) => current && setProjects(list))
      .catch((error: unknown) => {
        if (current && !(error instanceof Unsupported)) setProjects([]);
      });
    return () => {
      current = false;
    };
  }, [client, tick]);

  // The last visit is read once; it is written when the person leaves, so a reload is a visit.
  useEffect(() => {
    let current = true;
    let print: string | undefined;
    const leave = () => {
      if (print !== undefined) writeVisit(print, now());
    };
    client
      .fingerprint()
      .then((value) => {
        if (!current) return;
        print = value;
        setSince(readVisit(value) ?? now() - DAY_MS);
      })
      .catch(() => current && setSince(now() - DAY_MS));
    window.addEventListener('pagehide', leave);
    return () => {
      current = false;
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [client, now]);

  const recentIds = [...conversations]
    .reverse()
    .slice(0, RECENT_CONVERSATIONS)
    .map((c) => c.conversationId)
    .join('\u0000');
  useEffect(() => {
    let current = true;
    const ids = recentIds === '' ? [] : recentIds.split('\u0000');
    void tick;
    Promise.all(
      ids.map((id) =>
        client
          .listTasks(id)
          .then((tasks) => [id, tasks] as const)
          .catch(() => [id, [] as TaskView[]] as const),
      ),
    ).then((pairs) => current && setDone(new Map(pairs)));
    return () => {
      current = false;
    };
  }, [client, recentIds, tick]);

  async function act(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setAnswerError('');
    try {
      await work();
    } catch (e) {
      setAnswerError(errorText(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const open = Object.values(items)
    .filter((item) => item.state !== 'closed')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const finished = since === undefined || done === undefined ? [] : doneSince(done, since);
  const spent = finished.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
  const anySpend = finished.some((entry) => entry.costUsd !== undefined);
  const schedule = projects === undefined ? undefined : nextRuns(projects, now());
  const titleOf = (conversationId: string) =>
    displayText(
      conversations.find((c) => c.conversationId === conversationId)?.title ??
        'Untitled conversation',
    );
  const recent = [...conversations].reverse().slice(0, RECENT_CONVERSATIONS);

  return (
    <div className="page">
      {open.length > 0 && (
        <section className="card section-card" aria-label="Decisions waiting">
          <h2>Waiting on you ({open.length})</h2>
          {open.map((item) => (
            <div key={item.itemId} className="decision">
              <span className="chip verb">{verbOf(item.kind)}</span>
              <InboxCard
                item={item}
                disabled={busy}
                onAnswer={(optionId, text) => void act(() => answer.current(item, optionId, text))}
              />
              <button
                type="button"
                className="link-button"
                onClick={() => onOpen(item.conversationId)}
              >
                Open “{titleOf(item.conversationId)}”
              </button>
            </div>
          ))}
          {answerError && (
            <p role="alert" className="error">
              {answerError}
            </p>
          )}
        </section>
      )}

      <section className="card start" aria-label="Start something">
        <h1>Make room for your next idea.</h1>
        <p>Tell us what you’d like done, in a sentence. We’ll take it from there.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim() || starting) return;
            setStarting(true);
            setStartError('');
            void (async () => {
              try {
                attempt.current ??= {
                  conversationId: (await client.createConversation()).conversationId,
                  clientMessageId: crypto.randomUUID(),
                };
                const { conversationId, clientMessageId } = attempt.current;
                await client.postMessage(conversationId, draft.trim(), clientMessageId);
                attempt.current = null;
                onStarted({
                  conversationId,
                  title: null,
                  createdAt: Date.now(),
                });
              } catch (failure) {
                setStartError(errorText(failure));
                setStarting(false);
              }
            })();
          }}
        >
          <label htmlFor="first-message" className="sr-only">
            What would you like to get done?
          </label>
          <div className="pill-field">
            <textarea
              id="first-message"
              rows={1}
              maxLength={16000}
              placeholder="What would you like to get done?"
              value={draft}
              onChange={(e) => {
                setDraft(displayText(e.target.value));
                if (attempt.current) attempt.current.clientMessageId = crypto.randomUUID();
              }}
            />
            <button
              type="submit"
              className="round-button"
              aria-label={starting ? 'Starting…' : 'Start'}
              disabled={starting || !draft.trim()}
            >
              <span aria-hidden="true">↑</span>
            </button>
          </div>
        </form>
        {startError && (
          <p role="alert" className="error">
            {startError}
          </p>
        )}
      </section>

      {since !== undefined && done !== undefined && (finished.length > 0 || open.length > 0) && (
        <section className="card section-card" aria-label="Since you were last here">
          <h2>Since you were last here</h2>
          <div className="stat-tiles">
            <StatTile label="Done" value={String(finished.length)} />
            <StatTile label="Needs you" value={String(open.length)} />
            <StatTile label="Spent" value={anySpend ? dollars(spent) : 'Not reported'} />
          </div>
          {finished.length > 0 && (
            <ul className="done-lines">
              {finished.map((entry) => (
                <li key={entry.taskId}>
                  <button
                    type="button"
                    className="done-line"
                    onClick={() =>
                      onOpenTask ? onOpenTask(entry.task) : onOpen(entry.conversationId)
                    }
                  >
                    <span
                      className={`status-mark ${entry.state === 'succeeded' ? 'succeeded' : 'failed'}`}
                    />
                    <span className="done-text">
                      <strong>{displayText(entry.title)}</strong>
                      <span className="muted">{displayText(entry.outcome)}</span>
                    </span>
                    <span className="done-cost muted">{dollars(entry.costUsd)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {schedule && (schedule.scheduled.length > 0 || schedule.watching > 0) && (
        <section className="card section-card" aria-label="What runs next">
          <h2>What runs next</h2>
          {schedule.scheduled.length > 0 && (
            <ul className="done-lines">
              {schedule.scheduled.map((run) => (
                <li key={run.dutyId} className="next-run">
                  <span className="done-text">
                    <strong>{displayText(run.name)}</strong>
                    <span className="muted">{displayText(run.repo)}</span>
                  </span>
                  <span className="done-cost muted">{relativeTime(run.at, now())}</span>
                </li>
              ))}
            </ul>
          )}
          {schedule.watching > 0 && (
            <p className="muted">
              {schedule.watching === 1
                ? '1 more duty wakes when something happens on GitHub.'
                : `${schedule.watching} more duties wake when something happens on GitHub.`}
            </p>
          )}
        </section>
      )}

      {recent.length > 0 && (
        <section className="card section-card" aria-label="Recent conversations">
          <h2>Pick up where you left off</h2>
          <ul className="recent">
            {recent.map((c) => (
              <li key={c.conversationId}>
                <button type="button" onClick={() => onOpen(c.conversationId)}>
                  {displayText(c.title ?? 'Untitled conversation')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
