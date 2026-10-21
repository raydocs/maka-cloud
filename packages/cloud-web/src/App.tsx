import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@astryxdesign/core';
import { ChoicePanel } from '@maka/ui';
import { useMode } from './theme';
import {
  ApiError,
  type ArtifactContent,
  type ArtifactListing,
  CloudClient,
  type Conversation,
  ConversationFeed,
  conversationSummary,
  displayText,
  dollars,
  errorText,
  type InboxItem,
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
import { Home } from './Home';
import { InboxPanel } from './Inbox';
import { Computer } from './Computer';
import { TaskDelivery } from './Delivery';
import { MemoryPanel } from './Memory';
import { Projects } from './Projects';
import { TaskPage } from './TaskPage';
import { disablePush, enablePush } from './push';

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
  const card = questionCardModel(question, answered);
  const [selected, setSelected] = useState(card.firstOption);
  const [note, setNote] = useState('');
  return (
    <section className="question" aria-label="Your decision">
      <div className="section-heading">
        <span className={`status-mark ${answered ? 'succeeded' : 'attention'}`} />
        {card.heading}
      </div>
      <h3>{card.text}</h3>
      {card.cannotApproveHere && (
        <p className="muted">This card cannot be shown exactly, so it cannot be approved here.</p>
      )}
      {card.note && <p className="muted">{card.note}</p>}
      {card.held && (
        <p className="muted held-action">
          Held until you answer: {card.held.tool} <code>{card.held.args}</code>
        </p>
      )}
      {answered ? (
        <p className="acknowledged">Answer recorded: {card.answeredLabel}</p>
      ) : (
        <>
          <ChoicePanel
            label="Choose an answer"
            value={selected}
            disabled={disabled}
            options={card.options.map((o) => ({
              value: o.id,
              label: o.label,
              description: o.recommended ? 'Recommended' : undefined,
            }))}
            onChange={setSelected}
            onConfirm={() => {
              if (selected) onAnswer(selected, note || undefined);
            }}
            onEscape={() => {}}
          />
          <label className="note-label">
            Additional context (optional)
            <textarea
              rows={2}
              maxLength={4000}
              value={note}
              onChange={(e) => setNote(displayText(e.target.value))}
              disabled={disabled}
            />
          </label>
          <Button
            label="Send answer"
            variant="primary"
            isDisabled={disabled || !selected}
            onClick={() => onAnswer(selected, note || undefined)}
          />
        </>
      )}
    </section>
  );
}

/** The one updating line of a running task, and the steps behind it when it is opened. */
function StepLine({ notes }: { notes: readonly string[] }) {
  const { current, steps } = stepsOf(notes);
  if (current === undefined) return null;
  return (
    <details className="current-step">
      <summary>
        <span>Current step</span>
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
  // A bad parent reference cannot make rendering loop forever.
  if (ancestors.includes(task.taskId)) return null;
  const children = tasks.filter((child) => child.parentTaskId === task.taskId);
  const live = !TERMINAL.has(task.state) && !task.cancelRequested;
  const stopping = task.stopPending || task.treeStopPending;
  return (
    <li>
      <article className="task" aria-label={displayText(task.title ?? 'Task')}>
        <div className="task-title">
          <span className={`status-mark ${task.state}`} />
          <h3>{displayText(task.title ?? 'Task')}</h3>
        </div>
        <div className="task-meta">
          <span>{taskLabel(task)}</span>
          {task.parentTaskId === undefined && (
            <span>
              Cost so far: {dollars(task.costUsd)}
              {task.budgetUsd !== undefined && ` of ${dollars(task.budgetUsd)}`}
            </span>
          )}
        </div>
        {task.budgetExceeded && (
          <p className="failure">The budget was reached, so the work was stopped.</p>
        )}
        {stopping && (
          <p className="muted">Still stopping. The cost may change until it has stopped.</p>
        )}
        {task.progress.length > 0 && <StepLine notes={task.progress} />}
        {task.failureReason && <p className="failure">{displayText(task.failureReason)}</p>}
        {task.manifest && <p>{displayText(task.manifest.summary)}</p>}
        {live && <Computer client={client} task={task} />}
        {live && (
          <div className="task-actions">
            {task.state === 'running' && !task.pauseRequested && !noPause.has(task.taskId) && (
              <Button
                label="Pause task"
                variant="secondary"
                isDisabled={busy}
                onClick={() =>
                  void act(`pause-${task.taskId}`, () => control(task.taskId, 'pause'))
                }
              />
            )}
            {task.state === 'paused' && (
              <Button
                label="Resume task"
                variant="secondary"
                isDisabled={busy}
                onClick={() =>
                  void act(`resume-${task.taskId}`, () => control(task.taskId, 'resume'))
                }
              />
            )}
            <Button
              label="Cancel task"
              variant="secondary"
              isDisabled={busy}
              onClick={() =>
                void act(`cancel-${task.taskId}`, () => control(task.taskId, 'cancel'))
              }
            />
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
function artifactKind(listing: ArtifactListing, url: string | undefined): string {
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
              <span className="file-symbol" aria-hidden="true">
                ▤
              </span>
              <h3>{displayText(listing.name)}</h3>
            </div>
            <span className="artifact-kind">
              {kind} · {displayText(title)}
            </span>
            {link && (
              <a href={link} target="_blank" rel="noreferrer noopener">
                {kind === 'Pull request' ? 'Open pull request' : 'Open link'} ↗
              </a>
            )}
            {listing.kind === 'file' && !loaded && (
              <Button
                label={`Review ${displayText(listing.name)}`}
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
              <p className="muted">This link cannot be shown safely.</p>
            )}
          </article>
        );
      })}
      {entry.failed && (
        <p className="muted">The results of “{displayText(title)}” could not be listed.</p>
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
  const feed = useMemo(
    () => new ConversationFeed(client, conversation.conversationId),
    [client, conversation.conversationId],
  );
  useEffect(() => {
    feed.start();
    return () => feed.stop();
  }, [feed]);
  const snapshot = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const { state, status, error, busy, artifacts, noPause } = snapshot;
  const [draft, setDraft] = useState('');
  const act = (key: string, work: () => Promise<unknown>) => feed.act(key, work);
  const control = (taskId: string, action: TaskControl) => feed.control(taskId, action);
  const answerItem = (item: InboxItem, optionId: string, text?: string) =>
    void feed.answerItem(item, optionId, text);

  const { tasks, questions, running, withResults, openQuestions } = conversationSummary(snapshot);
  const total = totalCost(tasks);

  return (
    <div className="chat">
      <section className="conversation card" aria-label="Conversation">
        <div className="conversation-heading">
          <h1>{displayText(conversation.title ?? 'A fresh start')}</h1>
          <span className="connection" role="status">
            <span className={`status-mark ${status === 'Live' ? 'succeeded' : 'attention'}`} />
            {status}
          </span>
          {picker}
        </div>
        <div className="messages" role="log" aria-label="Messages">
          {state.messages.length === 0 && (
            <div className="empty">
              <h2>What would you like to get done?</h2>
              <p>Bring a question, a project, or a plan. We’ll keep the work here.</p>
            </div>
          )}
          {state.messages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <span className="message-author">
                {message.role === 'user' ? 'You' : message.role === 'notice' ? 'Update' : 'Maka'}
              </span>
              <p>{displayText(message.text)}</p>
            </article>
          ))}
        </div>
        {tasks
          .filter((task) => !task.parentTaskId || !state.tasks[task.parentTaskId])
          .map((task) => (
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
        <InboxPanel
          items={Object.values(state.inbox)}
          openQuestions={openQuestions}
          disabled={Boolean(busy)}
          onAnswer={answerItem}
        />
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void feed.send(draft).then((sent) => sent && setDraft(''));
          }}
        >
          <label htmlFor="message" className="sr-only">
            Keep the conversation going
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
              placeholder="What would you like to do next?"
            />
            <button
              type="submit"
              className="round-button"
              aria-label={busy === 'message' ? 'Sending…' : 'Send message'}
              disabled={Boolean(busy) || !draft.trim()}
            >
              <span aria-hidden="true">↑</span>
            </button>
          </div>
        </form>
      </section>
      <aside className="work-panel" aria-label="Work and results">
        <section className="card section-card work-summary">
          <div className="section-heading">
            <h2>The work</h2>
            <span className="count">{running} running</span>
          </div>
          <div className="spend">
            <span>Total cost so far</span>
            <strong>
              {dollars(total.usd)}
              {total.usd !== undefined && !total.complete && ' (not all reported)'}
            </strong>
          </div>
        </section>
        <section className="card section-card" aria-label="Task tree">
          <h2 className="panel-heading">Live tasks</h2>
          {tasks.length ? (
            <ul className="task-tree">
              {tasks
                .filter((task) => !task.parentTaskId || !state.tasks[task.parentTaskId])
                .map((task) => (
                  <TaskBranch
                    key={task.taskId}
                    {...{ task, client, tasks, noPause, act, control }}
                    busy={Boolean(busy)}
                  />
                ))}
            </ul>
          ) : (
            <p className="muted">Tasks will appear as the plan takes shape.</p>
          )}
        </section>
        <section className="artifacts" aria-label="Artifacts">
          <h2 className="panel-heading">Ready to review</h2>
          {!withResults.some((task) => artifacts[task.taskId]?.listings.length) && (
            <p className="muted">Reports, changes, and pull requests will collect here.</p>
          )}
          {withResults.map((task) => (
            <ArtifactList
              key={task.taskId}
              client={client}
              taskId={task.taskId}
              title={task.title ?? 'Task'}
              entry={artifacts[task.taskId] as TaskArtifacts}
              busy={Boolean(busy)}
              act={act}
            />
          ))}
        </section>
      </aside>
    </div>
  );
}

/** Step away, stay in the loop: the device's own notifications, one switch per browser. */
export function NotificationsPanel({ client }: { client: CloudClient }) {
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
    <section className="card section-card notifications" aria-label="Notifications">
      <h2>Step away. Stay in the loop.</h2>
      <p className="muted">
        Get a notification when background work finishes, even after you close this page.
      </p>
      {!client.unsupported.has('push') && !on && (
        <Button
          label="Enable notifications"
          variant="secondary"
          isDisabled={busy}
          onClick={() =>
            void act(async () => {
              try {
                await enablePush(client);
                setOn(true);
                setHint('');
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
          <p role="status">Background notifications enabled</p>
          <Button
            label="Turn off notifications"
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
        <p className="muted">Background notifications are unavailable on this server.</p>
      )}
      {hint && <p role="status">{hint}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}

/** Light or dark, kept in this browser. */
function AppearanceChoice() {
  const { mode, setMode } = useMode();
  return (
    <section className="card section-card" aria-label="Appearance">
      <h2>Appearance</h2>
      <div className="mode-choice" role="group" aria-label="Color mode">
        {(['dark', 'light'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
          >
            {value === 'dark' ? 'Dark' : 'Light'}
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
  return (
    <div className="page">
      <h1>Settings</h1>
      <AppearanceChoice />
      <section className="card section-card">
        <MemoryPanel client={client} errorText={errorText} />
      </section>
      <NotificationsPanel client={client} />
      <section className="card section-card" aria-label="Connection">
        <h2>This device</h2>
        <p className="muted">Disconnecting forgets the invite on this device and nothing else.</p>
        <Button label="Disconnect" variant="secondary" onClick={onDisconnect} />
      </section>
    </div>
  );
}

type View = 'home' | 'chat' | 'projects' | 'settings';
const VIEWS: ReadonlyArray<{ view: View; label: string }> = [
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
}: {
  view: View;
  onView: (view: View) => void;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <header className="shell-top">
        <a className="brand" href="/">
          maka
        </a>
        <nav className="seg" aria-label="Sections">
          {VIEWS.map((item) => (
            <button
              key={item.view}
              type="button"
              className="seg-item"
              aria-current={view === item.view ? 'page' : undefined}
              onClick={() => onView(item.view)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>
      <main>{children}</main>
    </div>
  );
}

export function App({ initialToken = '' }: { initialToken?: string }) {
  const [invite, setInvite] = useState(initialToken);
  const [session, setSession] = useState<{
    client: CloudClient;
    conversations: Conversation[];
  } | null>(null);
  const [chosen, setChosen] = useState('');
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
      view={taskPage ? taskPage.from : view}
      onView={(next) => {
        setTaskPage(undefined);
        setView(next);
      }}
    >
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {taskPage && (
        <TaskPage
          client={session.client}
          task={taskPage.task}
          onBack={() => setTaskPage(undefined)}
        />
      )}
      {view === 'home' && (
        // Kept while a task page is open, so coming back is not a new visit.
        <div hidden={taskPage !== undefined}>
          <Home
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
      {view === 'chat' && (
        <div hidden={taskPage !== undefined}>
          {selected ? (
            <ConversationView
              key={chosen}
              client={session.client}
              conversation={selected}
              onOpenTask={(task) => setTaskPage({ task, from: 'chat' })}
              picker={
                <select
                  aria-label="Select conversation"
                  value={chosen}
                  onChange={(e) => setChosen(e.target.value)}
                >
                  {session.conversations.map((c) => (
                    <option key={c.conversationId} value={c.conversationId}>
                      {displayText(c.title ?? 'Untitled conversation')}
                    </option>
                  ))}
                </select>
              }
            />
          ) : (
            <section className="card section-card" aria-label="No conversation">
              <h2>No conversation open</h2>
              <p className="muted">Start one from Home.</p>
              <Button label="Go to Home" variant="secondary" onClick={() => setView('home')} />
            </section>
          )}
        </div>
      )}
      {!taskPage && view === 'projects' && <Projects client={session.client} />}
      {!taskPage && view === 'settings' && (
        <Settings client={session.client} onDisconnect={disconnect} />
      )}
    </Shell>
  ) : (
    <main className="welcome">
      <span className="brand">maka</span>
      <h1>
        Your next big thing,
        <br />
        one conversation away.
      </h1>
      <p>A place to plan, follow the work, and bring it home.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void connect(invite);
        }}
      >
        <label htmlFor="invite">Invite token</label>
        <input
          id="invite"
          type="password"
          autoComplete="off"
          value={invite}
          onChange={(e) => setInvite(e.target.value)}
          required
        />
        <Button
          label={busy ? 'Connecting…' : 'Enter your workspace'}
          type="submit"
          variant="primary"
          isDisabled={busy}
        />
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </main>
  );
}
