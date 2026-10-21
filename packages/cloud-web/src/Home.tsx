import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  type CloudClient,
  type Conversation,
  ConversationStarter,
  displayText,
  doneSince,
  dollars,
  errorText,
  HomeFeed,
  type Mode,
  nextRuns,
  recentConversations,
  relativeTime,
  splitSuggestions,
  type TaskView,
  verbOf,
  type VisitStore,
} from '@maka-cloud/client';
import { InboxCard } from './Inbox';
import { ModePicker } from './ModePicker';
import { SuggestionCard } from './Suggestion';
import { submitOnEnter } from './keys';

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

const localVisits: VisitStore = { read: readVisit, write: writeVisit };

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
  const [workMode, setWorkMode] = useState<Mode | undefined>();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const starter = useMemo(() => new ConversationStarter(client), [client]);
  // `now` may be a new function each render; the feed keeps asking the latest one.
  const clock = useRef(now);
  clock.current = now;
  const feed = useMemo(() => new HomeFeed(client, localVisits, () => clock.current()), [client]);
  const { items, busy, answerError, since, done, projects } = useSyncExternalStore(
    feed.subscribe,
    feed.getSnapshot,
  );

  // The last visit is read once; it is written when the person leaves, so a reload is a visit.
  // Come back to this tab and the decisions, results and schedule are read again.
  const latestConversations = useRef(conversations);
  useEffect(() => {
    feed.start(latestConversations.current);
    const onVisible = () => {
      if (document.visibilityState === 'visible') feed.refresh();
    };
    const leave = () => feed.leave();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', leave);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', leave);
      feed.stop();
    };
  }, [feed]);
  useEffect(() => {
    latestConversations.current = conversations;
    feed.conversationsChanged(conversations);
  }, [feed, conversations]);

  const live = Object.values(items)
    .filter((item) => item.state !== 'closed')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  // What the employee only suggests is not something that "needs you".
  const { waiting: open, suggested } = splitSuggestions(live);
  const finished = since === undefined || done === undefined ? [] : doneSince(done, since);
  const spent = finished.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
  const anySpend = finished.some((entry) => entry.costUsd !== undefined);
  const schedule = projects === undefined ? undefined : nextRuns(projects, now());
  const titleOf = (conversationId: string) =>
    displayText(
      conversations.find((c) => c.conversationId === conversationId)?.title ??
        'Untitled conversation',
    );
  const recent = recentConversations(conversations);

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
                onAnswer={(optionId, text) => void feed.answer(item, optionId, text)}
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

      {suggested.length > 0 && (
        <section className="card section-card" aria-label="Suggestions">
          <h2>Noticed for you ({suggested.length})</h2>
          <p className="muted">Nothing starts until you tap its first word.</p>
          {suggested.map((item) => (
            <div key={item.itemId} className="decision">
              <SuggestionCard
                item={item}
                disabled={busy}
                onAnswer={(optionId) => void feed.answer(item, optionId)}
              />
            </div>
          ))}
          {open.length === 0 && answerError && (
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
            void starter.start(draft, workMode).then(onStarted, (failure: unknown) => {
              setStartError(errorText(failure));
              setStarting(false);
            });
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
              onKeyDown={submitOnEnter}
              value={draft}
              onChange={(e) => {
                setDraft(displayText(e.target.value));
                starter.draftEdited();
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
          <ModePicker
            value={workMode}
            onChange={setWorkMode}
            idPrefix="start"
            disabled={starting}
          />
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
