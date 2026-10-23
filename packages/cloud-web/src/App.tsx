import { useT } from './i18n';
import type { Key } from './strings';
import { ArrowUp, ArrowUpRight, FileText, Search, UserRound, Plus } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@astryxdesign/core';
import { type ModeChoice, useMode } from './theme';
import { FailureNote } from './Failure';
import {
  ApiError,
  type ArtifactContent,
  type ArtifactListing,
  BRAND,
  pullRequestName,
  CloudClient,
  type Conversation,
  ConversationFeed,
  conversationSummary,
  displayText,
  dollars,
  errorText,
  type InboxItem,
  type Mode,
  publicLink,
  type Question,
  stepsOf,
  type TaskArtifacts,
  type TaskControl,
  taskLabel,
  type TaskView,
  TERMINAL,
  totalCost,
  openWorkspace,
  questionCardModel,
  Unsupported,
} from '@maka-cloud/client';
import { GrantsPanel } from './Grants';
import { QuotaNotice, Usage } from './Quota';
import { Home } from './Home';
import { InboxPanel } from './Inbox';
import { Computer } from './Computer';
import { TaskDelivery } from './Delivery';
import { MemoryPanel } from './Memory';
import { ModePicker } from './ModePicker';
import { pendingSends } from './pending';
import { Projects } from './Projects';
import { TaskPage } from './TaskPage';
import { disablePush, enablePush } from './push';
import { submitOnEnter } from './keys';

export function QuestionCard({
  question,
  answered,
  disabled,
  onAnswer,
}: {
  question: Question;
  answered?: string;
  disabled: boolean;
  onAnswer: (option: string, text?: string) => void;
}) {
  const { t, shared, choiceLabel } = useT();
  const card = questionCardModel(question, answered);
  const [note, setNote] = useState('');
  const [noting, setNoting] = useState(false);
  // The same shape as the card on Home: the answers are the buttons, the recommended one first and
  // filled, and a note only when asked for. One tap answers.
  return (
    <section className="question" aria-label={t('Your decision')}>
      <div className="section-heading">
        <span className={`status-mark ${answered ? 'succeeded' : 'attention'}`} />
        {shared(card.heading)}
      </div>
      <h3>{card.text}</h3>
      {card.cannotApproveHere && (
        <p className="muted">
          {t('This card cannot be shown exactly, so it cannot be approved here.')}
        </p>
      )}
      {card.note && <p className="muted">{card.note}</p>}
      {card.held && (
        <p className="muted held-action">
          {t('Held until you answer:')} {card.held.tool} <code>{card.held.args}</code>
        </p>
      )}
      {answered ? (
        <p className="acknowledged">
          {t('Answer recorded:')}{' '}
          {choiceLabel(
            answered,
            question.options.find((raw) => raw.id === answered)?.label ?? t('Selected option'),
          )}
        </p>
      ) : (
        <>
          {!noting && (
            <button type="button" className="quiet-action" onClick={() => setNoting(true)}>
              {t('Add a note')}
            </button>
          )}
          {noting && (
            <label className="note-label">
              {t('Note')}
              <textarea
                rows={2}
                maxLength={4000}
                value={note}
                onChange={(e) => setNote(displayText(e.target.value))}
                disabled={disabled}
                // The person just asked to write the note.
                autoFocus
              />
            </label>
          )}
          <div className="inbox-options">
            {card.options.map((option) => (
              <Button
                key={option.id}
                label={choiceLabel(
                  option.id,
                  question.options.find((raw) => raw.id === option.id)?.label ?? option.label,
                )}
                variant={option.recommended ? 'primary' : 'secondary'}
                isDisabled={disabled}
                onClick={() => onAnswer(option.id, note.trim() || undefined)}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** The one updating line of a running task, and the steps behind it when it is opened. */
function StepLine({ notes }: { notes: readonly string[] }) {
  const { t } = useT();
  const { current, steps } = stepsOf(notes);
  if (current === undefined) return null;
  return (
    <details className="current-step">
      <summary>
        <span>{t('Current step')}</span>
        {displayText(current)}
      </summary>
      {steps.length > 1 && (
        <ol className="steps">
          {steps.map((step, i) => (
            <li key={i}>{displayText(step)}</li>
          ))}
        </ol>
      )}
    </details>
  );
}

function TaskBranch({
  task,
  client,
  tasks,
  noPause,
  busy,
  act,
  control,
  ancestors = [],
}: {
  task: TaskView;
  client: CloudClient;
  tasks: TaskView[];
  noPause: ReadonlySet<string>;
  busy: boolean;
  act: (key: string, work: () => Promise<unknown>) => Promise<boolean>;
  control: (task: string, action: 'cancel' | 'pause' | 'resume') => Promise<void>;
  ancestors?: string[];
}) {
  const { t, shared } = useT();
  // A bad parent reference cannot make rendering loop forever.
  if (ancestors.includes(task.taskId)) return null;
  const children = tasks.filter((child) => child.parentTaskId === task.taskId);
  const live = !TERMINAL.has(task.state) && !task.cancelRequested;
  const stopping = task.stopPending || task.treeStopPending;
  return (
    <li>
      <article className="task" aria-label={displayText(task.title ?? t('Task'))}>
        <div className="task-title">
          <span className={`status-mark ${task.state}`} />
          <h3>{displayText(task.title ?? t('Task'))}</h3>
        </div>
        <div className="task-meta">
          <span>{shared(taskLabel(task))}</span>
          {task.parentTaskId === undefined &&
            (task.costUsd !== undefined || task.budgetUsd !== undefined) && (
              <span>
                {task.costUsd === undefined ? t('Budget:') : live ? t('Cost so far:') : t('Cost:')}{' '}
                <span className={task.costUsd === undefined ? undefined : 'mono'}>
                  {task.costUsd !== undefined && shared(dollars(task.costUsd))}
                  {task.budgetUsd !== undefined &&
                    (task.costUsd === undefined
                      ? shared(dollars(task.budgetUsd))
                      : t(' of {p0}', { p0: dollars(task.budgetUsd) }))}
                </span>
              </span>
            )}
        </div>
        {task.quota && <QuotaNotice quota={task.quota} />}
        {task.budgetExceeded && !task.quota && (
          <p className="failure">{t('The budget was reached, so the work was stopped.')}</p>
        )}
        {stopping && (
          <p className="muted">{t('Still stopping. The cost may change until it has stopped.')}</p>
        )}
        {/* A finished task has no "current step", and a top-level result is on its own card. */}
        {task.progress.length > 0 && live && <StepLine notes={task.progress} />}
        {task.failureReason && <FailureNote reason={task.failureReason} />}
        {task.manifest && task.parentTaskId !== undefined && (
          <p>{displayText(task.manifest.summary)}</p>
        )}
        {live && <Computer client={client} task={task} />}
        {live && (
          // Quiet words, not three pills: the task is the thing to read, the controls are a glance.
          <div className="task-actions">
            {task.state === 'running' && !task.pauseRequested && !noPause.has(task.taskId) && (
              <button
                type="button"
                className="quiet-action"
                aria-label={t('Pause task')}
                disabled={busy}
                onClick={() =>
                  void act(`pause-${task.taskId}`, () => control(task.taskId, 'pause'))
                }
              >
                {t('Pause')}
              </button>
            )}
            {task.state === 'paused' && (
              <button
                type="button"
                className="quiet-action"
                aria-label={t('Resume task')}
                disabled={busy}
                onClick={() =>
                  void act(`resume-${task.taskId}`, () => control(task.taskId, 'resume'))
                }
              >
                {t('Resume')}
              </button>
            )}
            <button
              type="button"
              className="quiet-action"
              aria-label={t('Cancel task')}
              disabled={busy}
              onClick={() =>
                void act(`cancel-${task.taskId}`, () => control(task.taskId, 'cancel'))
              }
            >
              {t('Cancel')}
            </button>
          </div>
        )}
      </article>
      {children.length > 0 && (
        <ul className="task-children">
          {children.map((child) => (
            <TaskBranch
              key={child.taskId}
              {...{ task: child, client, tasks, noPause, busy, act, control }}
              ancestors={[...ancestors, task.taskId]}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Where a result link points, said in the user's words; nothing here claims the result was checked. */
function artifactKind(listing: ArtifactListing, url: string | undefined): Key {
  if (url && /\/pull\/\d+/u.test(url)) return 'Pull request';
  if (/\.(diff|patch)$/iu.test(listing.name)) return 'Changes';
  if (listing.kind === 'link') return 'Link';
  return 'Result';
}

/** A picture the server sent as one (its bytes checked); shown from a local object URL, never from a remote address. */
export function Picture({ name, blob }: { name: string; blob: Blob }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    const url = URL.createObjectURL(blob);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return src ? <img className="picture" alt={displayText(name)} src={src} /> : null;
}

function ArtifactList({
  client,
  taskId,
  title,
  entry,
  busy,
  act,
}: {
  client: CloudClient;
  taskId: string;
  title: string;
  entry: TaskArtifacts;
  busy: boolean;
  act: (key: string, work: () => Promise<unknown>) => Promise<boolean>;
}) {
  const { t, shared } = useT();
  const [content, setContent] = useState<Record<number, ArtifactContent>>({});
  return (
    <>
      {entry.listings.map((listing) => {
        const loaded = content[listing.index];
        const link = publicLink(loaded?.kind === 'link' ? loaded.url : listing.url);
        const kind = artifactKind(listing, link);
        return (
          <article className="artifact card" key={`${taskId}-${listing.index}`}>
            <div className="artifact-heading">
              <FileText aria-hidden="true" size={18} strokeWidth={1.8} className="file-symbol" />
              <h3>
                {pullRequestName(link) ? shared(pullRequestName(link)!) : displayText(listing.name)}
              </h3>
            </div>
            <span className="artifact-kind">
              {t(kind)} · {displayText(title)}
            </span>
            {link && (
              <a href={link} target="_blank" rel="noreferrer noopener">
                {kind === 'Pull request' ? t('Open pull request') : t('Open link')}{' '}
                <ArrowUpRight aria-hidden="true" size={14} className="icon-inline" />
              </a>
            )}
            {listing.kind === 'file' && !loaded && (
              <Button
                label={t('Review {p0}', { p0: displayText(listing.name) })}
                variant="secondary"
                isDisabled={busy}
                onClick={() =>
                  void act('artifact', async () => {
                    const result = await client.readArtifact(taskId, listing.index);
                    setContent((previous) => ({
                      ...previous,
                      [listing.index]: result,
                    }));
                  })
                }
              />
            )}
            {loaded?.kind === 'image' && <Picture name={loaded.name} blob={loaded.blob} />}
            {loaded?.kind === 'text' && (
              <pre className={kind === 'Changes' ? 'diff-content' : 'report-content'}>
                {displayText(loaded.text)}
              </pre>
            )}
            {listing.kind === 'link' && !link && (
              <p className="muted">{t('This link cannot be shown safely.')}</p>
            )}
          </article>
        );
      })}
      {entry.failed && (
        <p className="muted">
          {t('The results of “{title}” could not be listed.', { title: displayText(title) })}
        </p>
      )}
    </>
  );
}

export function ConversationView({
  client,
  conversation,
  picker,
  onOpenTask,
}: {
  client: CloudClient;
  conversation: Conversation;
  onOpenTask?: (task: TaskView) => void;
  /** The conversation chooser, shown in the heading (the app owns which conversation is open). */
  picker?: ReactNode;
}) {
  const { t, shared } = useT();
  const feed = useMemo(
    () => new ConversationFeed(client, conversation.conversationId, undefined, pendingSends),
    [client, conversation.conversationId],
  );
  useEffect(() => {
    feed.start();
    return () => feed.stop();
  }, [feed]);
  const snapshot = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const { state, status, error, busy, artifacts, noPause } = snapshot;
  const [draft, setDraft] = useState('');
  const [workMode, setWorkMode] = useState<Mode | undefined>();
  const act = (key: string, work: () => Promise<unknown>) => feed.act(key, work);
  const control = (taskId: string, action: TaskControl) => feed.control(taskId, action);
  const answerItem = (item: InboxItem, optionId: string, text?: string) =>
    void feed.answerItem(item, optionId, text);

  const { tasks, questions, running, withResults, openQuestions } = conversationSummary(snapshot);
  const total = totalCost(tasks);
  const topLevel = tasks.filter((task) => !task.parentTaskId || !state.tasks[task.parentTaskId]);
  // A top-level task's result card holds its outcome, so the inbox here does not announce it again.
  // The same rule as `TaskDelivery`, which draws a result card only for these.
  const shown = new Set(
    topLevel
      .filter((task) => task.state === 'succeeded' && task.manifest?.summary !== undefined)
      .map((task) => task.taskId),
  );
  const unshown = withResults.filter(
    (task) =>
      !shown.has(task.taskId) &&
      (artifacts[task.taskId]?.listings.length || artifacts[task.taskId]?.failed),
  );

  return (
    <div className="chat">
      <section className="conversation card" aria-label={t('Conversation')}>
        <div className="conversation-heading">
          <h1>{displayText(conversation.title ?? t('A fresh start'))}</h1>
          {picker}
        </div>
        <div className="messages" role="log" aria-label={t('Messages')}>
          {state.messages.length === 0 && (
            <div className="empty">
              <h2>{t('What would you like to get done?')}</h2>
              <p>
                {t('Bring a question, a project, or a plan. {name} keeps the work here.', {
                  name: BRAND.name,
                })}
              </p>
            </div>
          )}
          {state.messages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <span className="sr-only">
                {message.role === 'user'
                  ? t('You')
                  : message.role === 'notice'
                    ? t('Update')
                    : BRAND.name}
              </span>
              <p>{displayText(message.text)}</p>
            </article>
          ))}
        </div>
        {topLevel.map((task) => (
          <TaskDelivery
            key={task.taskId}
            client={client}
            task={task}
            listings={artifacts[task.taskId]?.listings ?? []}
            onOpenTask={onOpenTask}
          />
        ))}
        {questions.map((question) => (
          <QuestionCard
            key={question.questionId}
            question={question}
            answered={state.answers[question.questionId]}
            disabled={Boolean(busy)}
            onAnswer={(optionId, text) => void feed.answerQuestion(question, optionId, text)}
          />
        ))}
        {/* Proposed cards live on Home. A finished task whose result card is above is not
            announced again here; it is acknowledged on Home. */}
        <InboxPanel
          items={Object.values(state.inbox).filter(
            (item) =>
              item.kind !== 'suggestion' &&
              !(item.kind === 'finished' && item.taskId !== null && shown.has(item.taskId)),
          )}
          openQuestions={openQuestions}
          disabled={Boolean(busy)}
          onAnswer={answerItem}
          shownResults={shown}
        />
        {error && (
          <p role="alert" className="error">
            {shared(error)}
          </p>
        )}
        <aside className="work-panel" aria-label={t('Work and results')}>
          {(running > 0 || total.usd !== undefined) && (
            <section className="card section-card work-summary" aria-label={t('Running')}>
              <div className="section-heading">
                <h2>{t('Running')}</h2>
                {running > 0 && (
                  <span className="count">{t('{count} running', { count: running })}</span>
                )}
              </div>
              {total.usd !== undefined && (
                <div className="spend">
                  <span>{t('Total cost so far')}</span>
                  <strong className="mono">{shared(dollars(total.usd))}</strong>
                  {total.usd !== undefined && !total.complete && (
                    <span className="muted">{t('Not all reported')}</span>
                  )}
                </div>
              )}
            </section>
          )}
          {tasks.length > 0 && (
            <section className="card section-card" aria-label={t('Task tree')}>
              <h2 className="panel-heading">{t('Tasks')}</h2>
              <ul className="task-tree">
                {topLevel.map((task) => (
                  <TaskBranch
                    key={task.taskId}
                    {...{ task, client, tasks, noPause, act, control }}
                    busy={Boolean(busy)}
                  />
                ))}
              </ul>
            </section>
          )}
          {/* A result with its own card in the conversation is not listed again here. */}
          {unshown.length > 0 && (
            <section className="artifacts" aria-label={t('Artifacts')}>
              <h2 className="panel-heading">{t('Review')}</h2>
              {unshown.map((task) => (
                <ArtifactList
                  key={task.taskId}
                  client={client}
                  taskId={task.taskId}
                  title={task.title ?? t('Task')}
                  entry={artifacts[task.taskId] as TaskArtifacts}
                  busy={Boolean(busy)}
                  act={act}
                />
              ))}
            </section>
          )}
        </aside>
        {/* Nothing to say while connected; only a dropped connection is worth a glance. */}
        <span className="connection" role="status">
          {status === 'Connecting…' && <span className="muted">{shared(status)}</span>}
          {status !== 'Live' && status !== 'Connecting…' && (
            <>
              <span className="status-mark attention" />
              {shared(status)}
            </>
          )}
        </span>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void feed.send(draft, workMode).then((sent) => sent && setDraft(''));
          }}
        >
          <label htmlFor="message" className="sr-only">
            {t('Keep the conversation going')}
          </label>
          <div className="pill-field">
            <textarea
              id="message"
              rows={1}
              maxLength={16000}
              value={draft}
              onChange={(e) => {
                setDraft(displayText(e.target.value));
                feed.draftEdited();
              }}
              placeholder={t('What would you like to do next?')}
              onKeyDown={submitOnEnter}
            />
            <button
              type="submit"
              className="round-button"
              aria-label={busy === 'message' ? t('Sending…') : t('Send message')}
              disabled={Boolean(busy) || !draft.trim()}
            >
              <ArrowUp aria-hidden="true" size={18} strokeWidth={2.2} />
            </button>
          </div>
          <ModePicker
            value={workMode}
            onChange={setWorkMode}
            idPrefix="chat"
            disabled={Boolean(busy)}
          />
        </form>
      </section>
    </div>
  );
}

/** Step away, stay in the loop: the device's own notifications, one switch per browser. */
export function NotificationsPanel({ client }: { client: CloudClient }) {
  const { t, shared, languageChoice } = useT();
  const [on, setOn] = useState(false);
  const [hint, setHint] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  async function act(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="card section-card notifications" aria-label={t('Notifications')}>
      <h2>{t('Step away. Stay in the loop.')}</h2>
      <p className="muted">
        {t('Get a notification when background work finishes, even after you close this page.')}
      </p>
      {!client.unsupported.has('push') && !on && (
        <Button
          label={t('Enable notifications')}
          variant="secondary"
          isDisabled={busy}
          onClick={() =>
            void act(async () => {
              try {
                await enablePush(client, languageChoice);
                setOn(true);
                setHint('');
                void client.setup({ notificationsAllowed: true }).catch(() => {});
              } catch (e) {
                if (!(e instanceof ApiError) && !(e instanceof Unsupported)) {
                  setHint(
                    'Notifications could not be enabled. Check browser support and notification permissions.',
                  );
                  return;
                }
                throw e;
              }
            })
          }
        />
      )}
      {on && (
        <>
          <p role="status">{t('Background notifications enabled')}</p>
          <Button
            label={t('Turn off notifications')}
            variant="secondary"
            isDisabled={busy}
            onClick={() =>
              void act(async () => {
                await disablePush(client);
                setOn(false);
                setHint('');
              })
            }
          />
        </>
      )}
      {client.unsupported.has('push') && (
        <p className="muted">{t('Background notifications are unavailable on this server.')}</p>
      )}
      {hint && <p role="status">{shared(hint)}</p>}
      {error && (
        <p role="alert" className="error">
          {shared(error)}
        </p>
      )}
    </section>
  );
}

const MODE_CHOICES: ReadonlyArray<{ value: ModeChoice; label: Key }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** System, light or dark, kept in this browser. */
function AppearanceChoice() {
  const { t } = useT();
  const { choice, setMode } = useMode();
  return (
    <section className="card section-card" aria-label={t('Appearance')}>
      <h2>{t('Appearance')}</h2>
      <div className="mode-choice" role="group" aria-label={t('Color mode')}>
        {MODE_CHOICES.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={choice === value}
            onClick={() => setMode(value)}
          >
            {t(label)}
          </button>
        ))}
      </div>
    </section>
  );
}

function LanguageChoice() {
  const { t, languageChoice, setLanguage } = useT();
  return (
    <section className="card section-card" aria-label={t('Language')}>
      <h2>{t('Language')}</h2>
      <div className="mode-choice" role="group" aria-label={t('Language')}>
        {(['system', 'zh-Hans', 'zh-Hant', 'en'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={languageChoice === value}
            onClick={() => setLanguage(value)}
          >
            {value === 'system'
              ? t('Follow system')
              : value === 'zh-Hans'
                ? t('简体中文')
                : value === 'zh-Hant'
                  ? t('繁體中文')
                  : t('English')}
          </button>
        ))}
      </div>
    </section>
  );
}

export function Settings({
  client,
  onDisconnect,
}: {
  client: CloudClient;
  onDisconnect: () => void;
}) {
  const { t } = useT();
  return (
    <div className="page">
      <h1>{t('Me')}</h1>
      <Usage client={client} />
      <AppearanceChoice />
      <LanguageChoice />
      <section className="card section-card">
        <MemoryPanel client={client} errorText={errorText} />
      </section>
      <NotificationsPanel client={client} />
      <GrantsPanel client={client} />
      <section className="card section-card" aria-label={t('Connection')}>
        <h2>{t('This device')}</h2>
        <p className="muted">
          {t('Disconnecting forgets the invite on this device and nothing else.')}
        </p>
        <Button label={t('Disconnect')} variant="secondary" onClick={onDisconnect} />
      </section>
    </div>
  );
}

type View = 'home' | 'chat' | 'projects' | 'settings';
const VIEWS: ReadonlyArray<{ view: View; label: Key }> = [
  { view: 'home', label: 'Home' },
  { view: 'chat', label: 'Chat' },
  { view: 'projects', label: 'Projects' },
  { view: 'settings', label: 'Settings' },
];

/** The frame every signed-in screen sits in: brand and the segmented navigation. */
export function Shell({
  view,
  onView,
  children,
  onSearch,
  searching = false,
}: {
  searching?: boolean;
  onSearch?: () => void;
  view: View;
  onView: (view: View) => void;
  children: ReactNode;
}) {
  const { t } = useT();
  const shell = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = shell.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const heights = [...root.querySelectorAll('.composer, .start form')]
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => el.getBoundingClientRect().height);
      root.style.setProperty('--composer-height', `${Math.max(0, ...heights)}px`);
    };
    const resize = new ResizeObserver(update);
    const observe = () => {
      root.querySelectorAll('.composer, .start form').forEach((el) => resize.observe(el));
      update();
    };
    const mutations = new MutationObserver(observe);
    mutations.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden'],
    });
    observe();
    return () => {
      resize.disconnect();
      mutations.disconnect();
    };
  }, []);
  return (
    <div ref={shell} className="shell" data-view={view}>
      <header className="shell-top">
        <nav className="seg-nav" aria-label={t('Sections')}>
          <button
            type="button"
            className="seg-settings"
            data-testid="button-search"
            aria-expanded={searching}
            aria-label={t('Search')}
            onClick={onSearch}
          >
            <Search size={18} strokeWidth={1.5} />
            <span className="sr-only">{t('Search')}</span>
          </button>
          <div className="seg">
            {VIEWS.filter((item) => item.view !== 'settings').map((item) => (
              <button
                key={item.view}
                type="button"
                className="seg-item"
                data-testid={`tab-${item.view}`}
                aria-current={view === item.view ? 'page' : undefined}
                onClick={() => onView(item.view)}
              >
                {t(item.label)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="seg-settings"
            data-testid="button-me"
            aria-current={view === 'settings' ? 'page' : undefined}
            onClick={() => onView('settings')}
          >
            <UserRound aria-hidden="true" size={18} strokeWidth={1.5} />
            <span className="sr-only">{t('Me')}</span>
          </button>
        </nav>
      </header>
      <main>{children}</main>
    </div>
  );
}

export function App({ initialToken = '' }: { initialToken?: string }) {
  const { t, shared } = useT();
  const [invite, setInvite] = useState(initialToken);
  const [session, setSession] = useState<{
    client: CloudClient;
    conversations: Conversation[];
  } | null>(null);
  const [wide, setWide] = useState(
    () => globalThis.matchMedia?.('(min-width: 900px)').matches ?? false,
  );
  useEffect(() => {
    const media = globalThis.matchMedia?.('(min-width: 900px)');
    const update = () => setWide(media?.matches ?? false);
    media?.addEventListener('change', update);
    return () => media?.removeEventListener('change', update);
  }, []);
  const [chosen, setChosen] = useState('');
  const [searching, setSearching] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searching) searchInput.current?.focus();
  }, [searching]);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>('home');
  // The task page opens over whichever section the person came from and goes back to it.
  const [taskPage, setTaskPage] = useState<{ task: TaskView; from: View } | undefined>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const connect = async (token: string) => {
    setBusy(true);
    setError('');
    try {
      const workspace = await openWorkspace(token, {
        onRevoked: () => {
          // The invite is gone: leave the workspace and keep nothing of it.
          setSession(null);
          setInvite('');
          setChosen('');
          setView('home');
          setError('Your invite is no longer valid. Please reconnect.');
        },
      });
      setSession({ client: workspace.client, conversations: workspace.conversations });
      setChosen(workspace.chosen);
      setView(workspace.landing);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (initialToken) void connect(initialToken);
  }, [initialToken]);
  const disconnect = () => {
    setSession(null);
    setInvite('');
    setChosen('');
    setView('home');
  };
  const selected = session?.conversations.find((c) => c.conversationId === chosen);
  return session ? (
    <Shell
      searching={searching}
      onSearch={() => setSearching(!searching)}
      view={taskPage?.from ?? view}
      onView={(next) => {
        setTaskPage(undefined);
        setView(next);
      }}
    >
      {!taskPage && (wide || view !== 'settings') && (
        <details className="composer-menu">
          <summary aria-label={t('Switch conversation')}>
            <Plus size={18} strokeWidth={1.5} />
          </summary>
          <div className="composer-choices">
            <button
              type="button"
              onClick={(e) => {
                setChosen('');
                setView('chat');
                const menu = e.currentTarget.closest('details');
                menu?.removeAttribute('open');
                menu?.querySelector('summary')?.focus();
              }}
            >
              {t('New conversation')}
            </button>
            {session.conversations.map((conversation) => (
              <button
                type="button"
                key={conversation.conversationId}
                onClick={(e) => {
                  setChosen(conversation.conversationId);
                  setView('chat');
                  const menu = e.currentTarget.closest('details');
                  menu?.removeAttribute('open');
                  menu?.querySelector('summary')?.focus();
                }}
              >
                {displayText(conversation.title ?? t('Untitled conversation'))}
              </button>
            ))}
          </div>
        </details>
      )}
      {searching && (
        <section
          className="search-sheet card section-card"
          aria-label={t('Search')}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setSearching(false);
              document.querySelector<HTMLButtonElement>('[data-testid="button-search"]')?.focus();
            }
          }}
        >
          <label htmlFor="search-conversations">{t('Search conversations')}</label>
          <input
            ref={searchInput}
            id="search-conversations"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {session.conversations
            .filter((c) => (c.title ?? '').toLocaleLowerCase().includes(query.toLocaleLowerCase()))
            .map((c) => (
              <button
                className="quiet-action"
                type="button"
                key={c.conversationId}
                onClick={() => {
                  setTaskPage(undefined);
                  setChosen(c.conversationId);
                  setView('chat');
                  setSearching(false);
                  document
                    .querySelector<HTMLButtonElement>('[data-testid="button-search"]')
                    ?.focus();
                }}
              >
                {displayText(c.title ?? t('Untitled conversation'))}
              </button>
            ))}
          <button
            type="button"
            className="quiet-action"
            onClick={() => {
              setSearching(false);
              document.querySelector<HTMLButtonElement>('[data-testid="button-search"]')?.focus();
            }}
          >
            {t('Close')}
          </button>
        </section>
      )}
      {error && (
        <p className="error" role="alert">
          {shared(error)}
        </p>
      )}
      {taskPage && (
        <TaskPage
          client={session.client}
          task={taskPage.task}
          onBack={() => setTaskPage(undefined)}
        />
      )}
      {(view === 'home' || (wide && view === 'chat')) && (
        // Kept while a task page is open, so coming back is not a new visit.
        <div className="content-pane" hidden={taskPage !== undefined}>
          <Home
            onSetup={(action) => {
              if (action === 'chat') {
                setView('chat');
                requestAnimationFrame(() => {
                  const composer =
                    document.querySelector<HTMLTextAreaElement>('.chat-dock textarea');
                  composer?.focus();
                });
              } else setView(action);
            }}
            active={view === 'home'}
            hideStart={wide}
            client={session.client}
            conversations={session.conversations}
            onStarted={(conversation) => {
              setSession({
                ...session,
                conversations: [...session.conversations, conversation],
              });
              setChosen(conversation.conversationId);
              setView('chat');
            }}
            onOpen={(conversationId) => {
              setChosen(conversationId);
              setView('chat');
            }}
            onOpenTask={(task) => setTaskPage({ task, from: 'home' })}
          />
        </div>
      )}
      {(wide || view === 'chat') && (
        <div className="chat-dock" hidden={taskPage !== undefined}>
          {selected ? (
            <ConversationView
              key={chosen}
              client={session.client}
              conversation={selected}
              onOpenTask={(task) => setTaskPage({ task, from: 'chat' })}
              picker={
                session.conversations.length > 1 && (
                  <select
                    aria-label={t('Switch conversation')}
                    value=""
                    onChange={(e) => e.target.value && setChosen(e.target.value)}
                  >
                    <option value="">{t('Switch conversation')}</option>
                    {session.conversations
                      .filter((c) => c.conversationId !== chosen)
                      .map((c) => (
                        <option key={c.conversationId} value={c.conversationId}>
                          {displayText(c.title ?? t('Untitled conversation'))}
                        </option>
                      ))}
                  </select>
                )
              }
            />
          ) : (
            <Home
              startOnly
              client={session.client}
              conversations={session.conversations}
              onStarted={(conversation) => {
                setSession({ ...session, conversations: [...session.conversations, conversation] });
                setChosen(conversation.conversationId);
                setView('chat');
              }}
              onOpen={setChosen}
            />
          )}
        </div>
      )}
      {!taskPage && !wide && view === 'projects' && (
        <div className="project-starter">
          <Home
            startOnly
            client={session.client}
            conversations={session.conversations}
            onStarted={(conversation) => {
              setSession({ ...session, conversations: [...session.conversations, conversation] });
              setChosen(conversation.conversationId);
              setView('chat');
            }}
            onOpen={setChosen}
          />
        </div>
      )}
      {!taskPage && view === 'projects' && (
        <div className="content-pane">
          <Projects client={session.client} />
        </div>
      )}
      {!taskPage && view === 'settings' && (
        <div className="content-pane">
          <Settings client={session.client} onDisconnect={disconnect} />
        </div>
      )}
    </Shell>
  ) : (
    <main className="welcome">
      <span className="brand">{BRAND.wordmark}</span>
      <h1>
        {t('Your next big thing,')}
        <br />
        {t('one conversation away.')}
      </h1>
      <p>{t('A place to plan, follow the work, and bring it home.')}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void connect(invite);
        }}
      >
        <label htmlFor="invite">{t('Invite token')}</label>
        <input
          id="invite"
          type="password"
          autoComplete="off"
          value={invite}
          onChange={(e) => setInvite(e.target.value)}
          required
        />
        <Button
          label={busy ? t('Connecting…') : t('Enter your workspace')}
          type="submit"
          variant="primary"
          isDisabled={busy}
        />
      </form>
      {error && (
        <p role="alert" className="error">
          {shared(error)}
        </p>
      )}
    </main>
  );
}
