import { SetupCards } from './SetupCards';
import { useT } from './i18n';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowUp } from 'lucide-react';
import {
  BRAND,
  type CloudClient,
  type Conversation,
  ConversationStarter,
  displayText,
  doneSince,
  dollars,
  type ErrorText,
  errorText,
  failedParts,
  finishedParts,
  HomeFeed,
  type Mode,
  type ProjectView,
  nextRuns,
  recentConversations,
  dutyTime,
  splitSuggestions,
  type TaskView,
  verbOf,
  type VisitStore,
} from '@maka-cloud/client';
import { localizedSentence } from './Failure';
import { failureWords } from '@maka-cloud/client';
import { InboxCard, ResultCard } from './Inbox';
import { ModePicker } from './ModePicker';
import { pendingSends } from './pending';
import { SuggestionCard } from './Suggestion';
import { submitOnEnter } from './keys';
import { starters, Onboarding, onboardingSkipped } from './Onboarding';

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
      <strong className={/\d/u.test(value) ? 'stat-value mono' : 'stat-value'}>{value}</strong>
    </div>
  );
}

/**
 * What stands where the decisions would be when there are none: bars while they are read, a retry
 * when they could not be (even if an earlier read was empty), a calm line when nothing waits. The
 * phone's InboxStatus, on the web.
 */
function InboxStatus({
  loaded,
  failed,
  onRetry,
}: {
  loaded: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  const { t } = useT();
  if (failed)
    return (
      <section className="card section-card" aria-label={t('Decisions could not be loaded')}>
        <p className="muted">{t('Decisions could not be loaded.')}</p>
        <button type="button" className="quiet-action" onClick={onRetry}>
          {t('Try again')}
        </button>
      </section>
    );
  if (loaded)
    return (
      <section className="section-card" aria-label={t('Nothing needs you')}>
        <p className="quiet-line">{t('Nothing needs you.')}</p>
      </section>
    );
  return (
    <section className="card section-card" aria-label={t('Loading')} aria-busy="true">
      <span className="skeleton-line" style={{ width: '60%' }} />
      <span className="skeleton-line" />
      <span className="skeleton-line" style={{ width: '80%' }} />
    </section>
  );
}

/** The day at the top of Home, large, the way a phone's lock screen opens: weekday, date, time. */
function Today({ now }: { now: () => number }) {
  const { language } = useT();
  const [at, setAt] = useState(now);
  useEffect(() => {
    const tick = setInterval(() => setAt(now()), 30_000);
    return () => clearInterval(tick);
  }, [now]);
  const locale = { en: 'en', 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW' }[language];
  const date = new Date(at);
  return (
    <header className="today">
      <p className="today-day">
        {new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric' }).format(
          date,
        )}
      </p>
      <p className="today-time">
        {new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date)}
      </p>
    </header>
  );
}

/**
 * Home: first what waits on the person (one-tap cards), then the start sentence, then what was done
 * since they were last here and what runs next. Each part fills in as its data arrives and stays
 * out of the way when the server has nothing, or no such feature.
 */
export function Home({
  client,
  startOnly = false,
  hideStart = false,
  active = true,
  conversations,
  onStarted,
  onSetup,
  onOpen,
  onOpenTask,
  now = Date.now,
}: {
  client: CloudClient;
  startOnly?: boolean;
  hideStart?: boolean;
  active?: boolean;
  conversations: Conversation[];
  onStarted: (conversation: Conversation) => void;
  onSetup?: (action: 'settings' | 'projects' | 'chat') => void;
  onOpen: (conversationId: string) => void;
  /** Opens a finished task's own page; without it a finished line opens its conversation. */
  onOpenTask?: (task: TaskView) => void;
  now?: () => number;
}) {
  const { t, shared, language } = useT();
  const [draft, setDraft] = useState('');
  const [ownProjects, setOwnProjects] = useState<ProjectView[]>([]);
  useEffect(() => {
    let current = true;
    void client.listProjects().then(
      (list) => {
        if (current) setOwnProjects(list);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [client]);
  const [onboarding, setOnboarding] = useState(() => !onboardingSkipped());
  const [workMode, setWorkMode] = useState<Mode | undefined>();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<ErrorText>('');
  const starter = useMemo(() => new ConversationStarter(client, Date.now, pendingSends), [client]);
  // `now` may be a new function each render; the feed keeps asking the latest one.
  const clock = useRef(now);
  clock.current = now;
  const feed = useMemo(() => new HomeFeed(client, localVisits, () => clock.current()), [client]);
  const { items, busy, inboxLoaded, inboxFailed, answerError, since, done, projects } =
    useSyncExternalStore(feed.subscribe, feed.getSnapshot);

  // The last visit is read once; it is written when the person leaves, so a reload is a visit.
  // Come back to this tab and the decisions, results and schedule are read again.
  const latestConversations = useRef(conversations);
  const wasActive = useRef(active);
  useEffect(() => {
    if (startOnly) return;
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
  }, [feed, startOnly]);
  useEffect(() => {
    if (active && !wasActive.current && !startOnly) feed.refresh();
    wasActive.current = active;
  }, [active, feed, startOnly]);
  useEffect(() => {
    latestConversations.current = conversations;
    if (!startOnly) feed.conversationsChanged(conversations);
  }, [feed, conversations, startOnly]);

  const live = Object.values(items)
    .filter((item) => item.state !== 'closed')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  // What Maka only suggests is not something that "needs you".
  const { waiting: open, suggested } = splitSuggestions(live);
  const finished = since === undefined || done === undefined ? [] : doneSince(done, since);
  const unfinished = finished.filter((entry) => entry.state !== 'succeeded').length;
  const spent = finished.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
  const anySpend = finished.some((entry) => entry.costUsd !== undefined);
  const schedule = projects === undefined ? undefined : nextRuns(projects, now());
  const titleOf = (conversationId: string) =>
    displayText(
      conversations.find((c) => c.conversationId === conversationId)?.title ??
        t('Untitled conversation'),
    );
  const recent = recentConversations(conversations);
  const ideas = [
    ...ownProjects.slice(0, 1).flatMap((project) =>
      starters(displayText(project.repo), { t })
        .slice(0, 2)
        .map((idea) => idea.sentence),
    ),
    ...recent
      .slice(0, 1)
      .filter((c) => c.title)
      .map((c) => t('Continue “{title}”', { title: displayText(c.title!) })),
  ];
  if (ideas.length === 0)
    ideas.push(t('Plan my next project'), t('Review my recent work'), t('Explore an idea'));

  return (
    <div className="page home">
      {!startOnly && <Today now={now} />}
      {/* Desktop: what waits on you beside the work, as Hark keeps its cards beside the chat.
          A phone reads one column, in this order: waiting, suggested, start, results. */}
      <div className="home-side" hidden={startOnly}>
        {open.length > 0 && (
          <section
            className="card section-card decisions-waiting"
            aria-label={t('Decisions waiting')}
          >
            <h2>{t('Waiting on you ({count})', { count: open.length })}</h2>
            {open.map((item) => {
              const parts = finishedParts(item);
              const task = done?.get(item.conversationId)?.find((t) => t.taskId === item.taskId);
              return parts ? (
                <ResultCard
                  key={item.itemId}
                  item={item}
                  parts={parts}
                  disabled={busy}
                  onAnswer={(optionId) => void feed.answer(item, optionId)}
                  onReview={() =>
                    task && onOpenTask ? onOpenTask(task) : onOpen(item.conversationId)
                  }
                />
              ) : (
                <div key={item.itemId} className="decision">
                  {/* A card that did not finish names that itself; a verb above it would repeat it. */}
                  {!failedParts(item) && (
                    <span className="chip verb">{shared(verbOf(item.kind))}</span>
                  )}
                  <InboxCard
                    item={item}
                    disabled={busy}
                    onAnswer={(optionId, text) => void feed.answer(item, optionId, text)}
                  />
                  <button
                    type="button"
                    className="quiet-action"
                    aria-label={t('Open “{p0}”', { p0: titleOf(item.conversationId) })}
                    onClick={() => onOpen(item.conversationId)}
                  >
                    {t('Open conversation')}
                  </button>
                </div>
              );
            })}
            {answerError && (
              <p role="alert" className="error">
                {shared(answerError)}
              </p>
            )}
          </section>
        )}

        {open.length === 0 && (
          <InboxStatus loaded={inboxLoaded} failed={inboxFailed} onRetry={() => feed.refresh()} />
        )}

        {suggested.length > 0 && (
          <section className="card section-card" aria-label={t('Suggestions')}>
            <h2>{t('Noticed for you ({count})', { count: suggested.length })}</h2>
            <p className="muted">{t('Nothing starts until you tap its first word.')}</p>
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
                {shared(answerError)}
              </p>
            )}
          </section>
        )}

        {schedule && (schedule.scheduled.length > 0 || schedule.watching > 0) && (
          <section className="card section-card runs-next" aria-label={t('What runs next')}>
            <h2>{t('What runs next')}</h2>
            {schedule.scheduled.length > 0 && (
              <ul className="done-lines">
                {schedule.scheduled.map((run) => (
                  <li key={run.dutyId} className="next-run">
                    <span className="done-text">
                      <strong>{displayText(run.name)}</strong>
                      <span className="muted">{displayText(run.repo)}</span>
                    </span>
                    <span className="done-cost muted">{dutyTime(run.at, language, now())}</span>
                  </li>
                ))}
              </ul>
            )}
            {schedule.watching > 0 && (
              <p className="muted">
                {schedule.watching === 1
                  ? t('1 more duty wakes when something happens on GitHub.')
                  : t('{p0} more duties wake when something happens on GitHub.', {
                      p0: schedule.watching,
                    })}
              </p>
            )}
          </section>
        )}
      </div>
      <div className="home-main">
        {!startOnly && onSetup && (
          <SetupCards
            client={client}
            onAction={onSetup}
            version={active ? conversations.length + 1 : -1}
          />
        )}
        {!hideStart && onboarding && conversations.length === 0 && (
          <Onboarding
            onPick={(sentence) => {
              setDraft(sentence);
              starter.draftEdited();
              document.getElementById('first-message')?.focus();
            }}
            onSkip={() => setOnboarding(false)}
          />
        )}

        {!hideStart && (
          <section className="card start" aria-label={t('Start something')}>
            <h1>{t('Make room for your next idea.')}</h1>
            <p>
              {t('Tell {name} what you’d like done, in a sentence. It takes it from there.', {
                name: BRAND.name,
              })}
            </p>
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
                {t('What would you like to get done?')}
              </label>
              <div className="pill-field">
                <textarea
                  id="first-message"
                  rows={1}
                  maxLength={16000}
                  placeholder={t('What would you like to get done?')}
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
                  aria-label={starting ? t('Starting…') : t('Start')}
                  disabled={starting || !draft.trim()}
                >
                  <ArrowUp aria-hidden="true" size={18} strokeWidth={2.2} />
                </button>
              </div>
              <ModePicker
                value={workMode}
                onChange={setWorkMode}
                idPrefix="start"
                disabled={starting}
              />
            </form>
            <div className="starter-ideas">
              {ideas.map((idea) => (
                <button
                  key={idea}
                  type="button"
                  className="chip"
                  onClick={() => {
                    setDraft(idea);
                    starter.draftEdited();
                    document.getElementById('first-message')?.focus();
                  }}
                >
                  {idea}
                </button>
              ))}
            </div>
            {startError && (
              <p role="alert" className="error">
                {shared(startError)}
              </p>
            )}
          </section>
        )}

        {!startOnly && since !== undefined && done !== undefined && finished.length > 0 && (
          <section className="card section-card" aria-label={t('Since you were last here')}>
            <h2>{t('Since you were last here')}</h2>
            <div className="stat-tiles">
              {/* What did not finish is counted apart, so "Done" never claims it. */}
              <StatTile label={t('Done')} value={String(finished.length - unfinished)} />
              {unfinished > 0 && (
                <StatTile label={t('Did not finish')} value={String(unfinished)} />
              )}
              {anySpend && <StatTile label={t('Spent')} value={dollars(spent)} />}
            </div>
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
                      <strong>{displayText(entry.task.title ?? t('Task'))}</strong>
                      <span className="muted">
                        {entry.state === 'succeeded' && entry.task.manifest?.summary !== undefined
                          ? displayText(entry.outcome)
                          : entry.task.failureReason
                            ? localizedSentence(
                                failureWords(entry.task.failureReason),
                                entry.task.failureReason,
                                shared,
                              )
                            : shared(displayText(entry.outcome))}
                      </span>
                    </span>
                    {entry.costUsd !== undefined && (
                      <span className="done-cost muted">{dollars(entry.costUsd)}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {!startOnly && recent.length > 0 && (
          <section className="card section-card" aria-label={t('Recent conversations')}>
            <h2>{t('Pick up where you left off')}</h2>
            <ul className="recent">
              {recent.map((c) => (
                <li key={c.conversationId}>
                  <button type="button" onClick={() => onOpen(c.conversationId)}>
                    {displayText(c.title ?? t('Untitled conversation'))}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
