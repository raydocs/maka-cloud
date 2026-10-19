import { useEffect, useRef, useState } from 'react';
import { Button } from '@astryxdesign/core';
import { ChoicePanel } from '@maka/ui';
import { ApiError, CloudClient, Unsupported } from './client';
import {
  type ArtifactContent,
  type ArtifactListing,
  type Conversation,
  type Question,
  TERMINAL,
  type TaskView,
} from './contract';
import { displayText, dollars, publicLink } from './presentation';
import { disablePush, enablePush } from './push';
import { applyEvent, type ConversationState, emptyState, mergeViews, totalCost } from './state';

const ERROR_TEXT: Record<string, string> = {
  pause_unsupported: 'This task cannot be paused.',
  invalid_state: 'The task is not in a state where that can be done.',
  not_open: 'This question is no longer open.',
  closed: 'This question is no longer open.',
  conflict: 'A different answer was already recorded for this question.',
  unknown_option: 'That answer is not one of the options.',
  text_too_long: 'The additional context is too long.',
  artifact_too_large: 'This result is too large to show here.',
  invalid_endpoint: 'This browser’s notification service is not accepted by this server.',
  invalid_keys: 'This browser’s notification keys were not accepted.',
  too_many_subscriptions: 'Notifications are already on for as many devices as are allowed.',
};

function errorText(error: unknown): string {
  if (error instanceof Unsupported)
    return 'This action is unavailable on this server. No change was made.';
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Your invite is no longer valid. Please reconnect.';
    const known = error.code === undefined ? undefined : ERROR_TEXT[error.code];
    if (known) return known;
    if (error.status === 429) return 'Too many requests. Try again in a moment.';
    if (error.status === 404) return 'That is no longer available.';
    return `Could not complete the request (${error.status}). Try again.`;
  }
  return 'Could not complete the request. Check your connection and try again.';
}

const REASON_HEADING = {
  taste: 'Needs your decision',
  budget_overrun: 'Needs your decision on the budget',
  irreversible: 'Needs your approval',
} as const;

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
  const options = [...question.options].sort(
    (a, b) => Number(b.id === question.recommended) - Number(a.id === question.recommended),
  );
  const [selected, setSelected] = useState(options[0]?.id ?? '');
  const [note, setNote] = useState('');
  return (
    <section className="question" aria-label="Your decision">
      <div className="section-heading">
        <span className={`status-mark ${answered ? 'succeeded' : 'attention'}`} />
        {answered ? 'Decision recorded' : (REASON_HEADING[question.reason] ?? REASON_HEADING.taste)}
      </div>
      <h3>{displayText(question.question)}</h3>
      {question.note && <p className="muted">{displayText(question.note)}</p>}
      {question.action && !answered && (
        <p className="muted held-action">
          Held until you answer: {displayText(question.action.tool)}{' '}
          <code>{displayText(JSON.stringify(question.action.args) ?? '')}</code>
        </p>
      )}
      {answered ? (
        <p className="acknowledged">
          Answer recorded:{' '}
          {displayText(question.options.find((o) => o.id === answered)?.label ?? 'Selected option')}
        </p>
      ) : (
        <>
          <ChoicePanel
            label="Choose an answer"
            value={selected}
            disabled={disabled}
            options={options.map((o) => ({
              value: o.id,
              label: displayText(o.label),
              description: o.id === question.recommended ? 'Recommended' : undefined,
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

function taskLabel(task: TaskView): string {
  if (task.cancelRequested && !TERMINAL.has(task.state)) return 'Cancelling…';
  if (task.state === 'running' && task.pauseRequested) return 'Pausing…';
  return {
    queued: 'Queued',
    running: 'In progress',
    paused: 'Paused',
    succeeded: 'Finished',
    failed: 'Failed',
    cancelled: 'Cancelled',
  }[task.state];
}

function TaskBranch({
  task,
  tasks,
  noPause,
  busy,
  act,
  control,
  ancestors = [],
}: {
  task: TaskView;
  tasks: TaskView[];
  noPause: ReadonlySet<string>;
  busy: boolean;
  act: (key: string, work: () => Promise<unknown>) => Promise<void>;
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
        {task.progress.length > 0 && (
          <p className="current-step">
            <span>Current step</span>
            {displayText(task.progress.at(-1) ?? '')}
          </p>
        )}
        {task.failureReason && <p className="failure">{displayText(task.failureReason)}</p>}
        {task.manifest && <p>{displayText(task.manifest.summary)}</p>}
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
              {...{ task: child, tasks, noPause, busy, act, control }}
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

interface TaskArtifacts {
  listings: ArtifactListing[];
  failed?: boolean;
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
  act: (key: string, work: () => Promise<unknown>) => Promise<void>;
}) {
  const [content, setContent] = useState<Record<number, ArtifactContent>>({});
  return (
    <>
      {entry.listings.map((listing) => {
        const loaded = content[listing.index];
        const link = publicLink(loaded?.kind === 'link' ? loaded.url : listing.url);
        const kind = artifactKind(listing, link);
        return (
          <article className="artifact" key={`${taskId}-${listing.index}`}>
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
                    setContent((previous) => ({ ...previous, [listing.index]: result }));
                  })
                }
              />
            )}
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

const REFRESH_AFTER = new Set([
  'task_succeeded',
  'task_failed',
  'task_cancelled',
  'task_cancel_requested',
  'task_stop_pending',
  'task_stopped',
]);

export function ConversationView({
  client,
  conversation,
  onDisconnect,
}: {
  client: CloudClient;
  conversation: Conversation;
  onDisconnect: () => void;
}) {
  const [state, setState] = useState<ConversationState>(emptyState);
  const [status, setStatus] = useState('Connecting…');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const pending = useRef(false);
  const [draft, setDraft] = useState('');
  const messageId = useRef<string | null>(null);
  const [artifacts, setArtifacts] = useState<Record<string, TaskArtifacts>>({});
  const [noPause, setNoPause] = useState<ReadonlySet<string>>(new Set());
  const [notifications, setNotifications] = useState(false);
  const [notificationHint, setNotificationHint] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let refresh: ReturnType<typeof setTimeout> | undefined;
    // The stream replays the conversation from the start; the task list adds
    // what only the server works out (cost, budget, stops still owed).
    const reconcile = () => {
      clearTimeout(refresh);
      refresh = setTimeout(() => {
        client
          .listTasks(conversation.conversationId)
          .then((views) => {
            if (!controller.signal.aborted) setState((previous) => mergeViews(previous, views));
          })
          .catch(() => {});
      }, 250);
    };
    client
      .subscribe(
        conversation.conversationId,
        (event) => {
          if (event.data.conversationId !== conversation.conversationId) return;
          setState((previous) => applyEvent(previous, event));
          if (event.kind === 'task.event' && REFRESH_AFTER.has(event.data.event.type)) reconcile();
        },
        setStatus,
        controller.signal,
      )
      .catch(() => {
        if (!controller.signal.aborted) {
          setError(errorText(undefined));
          setStatus('Disconnected');
        }
      });
    return () => {
      controller.abort();
      clearTimeout(refresh);
    };
  }, [client, conversation.conversationId]);

  // A finished task with results: ask the server what they are, once.
  const listed = useRef(new Set<string>());
  useEffect(() => {
    for (const task of Object.values(state.tasks)) {
      if (
        task.state !== 'succeeded' ||
        !task.manifest?.artifacts?.length ||
        listed.current.has(task.taskId)
      )
        continue;
      listed.current.add(task.taskId);
      client
        .listArtifacts(task.taskId)
        .then(({ artifacts: listings }) =>
          setArtifacts((previous) => ({ ...previous, [task.taskId]: { listings } })),
        )
        .catch(() => {
          setArtifacts((previous) => ({
            ...previous,
            [task.taskId]: { listings: [], failed: true },
          }));
        });
    }
  }, [client, state.tasks]);

  async function act(key: string, work: () => Promise<unknown>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(key);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      pending.current = false;
      setBusy('');
    }
  }

  async function control(taskId: string, action: 'cancel' | 'pause' | 'resume') {
    try {
      await client.control(taskId, action);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'pause_unsupported')
        setNoPause((previous) => new Set(previous).add(taskId));
      throw e;
    }
  }

  const tasks = Object.values(state.tasks);
  const running = tasks.filter((task) => task.state === 'running').length;
  const total = totalCost(tasks);
  const withResults = tasks.filter((task) => artifacts[task.taskId]);
  const questions = Object.values(state.questions);

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/">
          maka<span>Personal workspace</span>
        </a>
        <div className="header-actions">
          <span className="connection" role="status">
            <span className={`status-mark ${status === 'Live' ? 'succeeded' : 'attention'}`} />
            {status}
          </span>
          <Button label="Disconnect" variant="secondary" onClick={onDisconnect} />
        </div>
      </header>
      <main className="workspace">
        <section className="conversation" aria-label="Conversation">
          <div className="conversation-heading">
            <span className="muted">Your workspace / Conversation</span>
            <h1>{displayText(conversation.title ?? 'A fresh start')}</h1>
            <p className="muted">One place for the plan, the work, and the result.</p>
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
          {questions.map((question) => (
            <QuestionCard
              key={question.questionId}
              question={question}
              answered={state.answers[question.questionId]}
              disabled={Boolean(busy)}
              onAnswer={(optionId, text) =>
                void act('answer', async () => {
                  // 200 means the server recorded it (a repeat of the same answer is a duplicate).
                  await client.answer(conversation.conversationId, {
                    questionId: question.questionId,
                    optionId,
                    ...(text ? { text } : {}),
                  });
                  setState((previous) => ({
                    ...previous,
                    answers: { ...previous.answers, [question.questionId]: optionId },
                  }));
                })
              }
            />
          ))}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              if (!draft.trim()) return;
              void act('message', async () => {
                messageId.current ??= crypto.randomUUID();
                await client.postMessage(
                  conversation.conversationId,
                  draft.trim(),
                  messageId.current,
                );
                setDraft('');
                messageId.current = null;
              });
            }}
          >
            <label htmlFor="message">Keep the conversation going</label>
            <textarea
              id="message"
              rows={3}
              maxLength={16000}
              value={draft}
              onChange={(e) => {
                setDraft(displayText(e.target.value));
                messageId.current = null;
              }}
              placeholder="What would you like to do next?"
            />
            <div className="composer-footer">
              <span className="muted">You’re in control, at every step.</span>
              <Button
                label={busy === 'message' ? 'Sending…' : 'Send message'}
                type="submit"
                variant="primary"
                isDisabled={Boolean(busy) || !draft.trim()}
              />
            </div>
          </form>
        </section>
        <aside className="work-panel" aria-label="Work and results">
          <section className="work-summary">
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
          <section aria-label="Task tree">
            <h2 className="panel-heading">Live tasks</h2>
            {tasks.length ? (
              <ul className="task-tree">
                {tasks
                  .filter((task) => !task.parentTaskId || !state.tasks[task.parentTaskId])
                  .map((task) => (
                    <TaskBranch
                      key={task.taskId}
                      {...{ task, tasks, noPause, act, control }}
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
          <section className="notifications">
            <h2>Step away. Stay in the loop.</h2>
            <p className="muted">
              Get a notification when background work finishes, even after you close this page.
            </p>
            {!client.unsupported.has('push') && !notifications && (
              <Button
                label="Enable notifications"
                variant="secondary"
                isDisabled={Boolean(busy)}
                onClick={() =>
                  void act('push', async () => {
                    try {
                      await enablePush(client);
                      setNotifications(true);
                      setNotificationHint('');
                    } catch (e) {
                      if (!(e instanceof ApiError) && !(e instanceof Unsupported)) {
                        setNotificationHint(
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
            {notifications && (
              <>
                <p role="status">Background notifications enabled</p>
                <Button
                  label="Turn off notifications"
                  variant="secondary"
                  isDisabled={Boolean(busy)}
                  onClick={() =>
                    void act('push', async () => {
                      await disablePush(client);
                      setNotifications(false);
                      setNotificationHint('');
                    })
                  }
                />
              </>
            )}
            {client.unsupported.has('push') && (
              <p className="muted">Background notifications are unavailable on this server.</p>
            )}
            {notificationHint && <p role="status">{notificationHint}</p>}
          </section>
        </aside>
      </main>
      <footer className="page-footer">A little less to manage. A little more done.</footer>
    </div>
  );
}

/** The first message of a new conversation: creates the conversation, then posts into it. */
function StartForm({
  client,
  onStarted,
}: {
  client: CloudClient;
  onStarted: (conversation: Conversation) => void;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A retry after a failed post reuses the conversation and the message id.
  const attempt = useRef<{ conversationId: string; clientMessageId: string } | null>(null);
  return (
    <main className="welcome">
      <h1>Make room for your next idea.</h1>
      <p>Tell us what you’d like done, in a sentence. We’ll take it from there.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim() || busy) return;
          setBusy(true);
          setError('');
          void (async () => {
            try {
              attempt.current ??= {
                conversationId: (await client.createConversation()).conversationId,
                clientMessageId: crypto.randomUUID(),
              };
              const { conversationId, clientMessageId } = attempt.current;
              await client.postMessage(conversationId, draft.trim(), clientMessageId);
              attempt.current = null;
              onStarted({ conversationId, title: null, createdAt: Date.now() });
            } catch (failure) {
              setError(errorText(failure));
              setBusy(false);
            }
          })();
        }}
      >
        <label htmlFor="first-message">What would you like to get done?</label>
        <textarea
          id="first-message"
          rows={3}
          maxLength={16000}
          value={draft}
          onChange={(e) => {
            setDraft(displayText(e.target.value));
            if (attempt.current) attempt.current.clientMessageId = crypto.randomUUID();
          }}
        />
        <Button
          label={busy ? 'Starting…' : 'Start'}
          type="submit"
          variant="primary"
          isDisabled={busy || !draft.trim()}
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

export function App({ initialToken = '' }: { initialToken?: string }) {
  const [invite, setInvite] = useState(initialToken);
  const [session, setSession] = useState<{
    client: CloudClient;
    conversations: Conversation[];
  } | null>(null);
  const [chosen, setChosen] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const connect = async (token: string) => {
    setBusy(true);
    setError('');
    try {
      const client = new CloudClient(token, {
        onRevoked: () => {
          // The invite is gone: leave the workspace and keep nothing of it.
          setSession(null);
          setInvite('');
          setChosen('');
          setError('Your invite is no longer valid. Please reconnect.');
        },
      });
      const result = await client.listConversations();
      setSession({ client, conversations: result.conversations });
      setChosen(result.conversations.at(-1)?.conversationId ?? '');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (initialToken) void connect(initialToken);
  }, [initialToken]);
  const selected = session?.conversations.find((c) => c.conversationId === chosen);
  return session ? (
    <>
      <nav className="conversation-nav" aria-label="Conversations">
        <label>
          Conversation{' '}
          <select
            aria-label="Select conversation"
            value={chosen}
            onChange={(e) => setChosen(e.target.value)}
          >
            <option value="" disabled>
              Choose a conversation
            </option>
            {session.conversations.map((c) => (
              <option key={c.conversationId} value={c.conversationId}>
                {displayText(c.title ?? 'Untitled conversation')}
              </option>
            ))}
          </select>
        </label>
        <Button
          label="New conversation"
          isDisabled={busy}
          variant="secondary"
          onClick={() => setChosen('')}
        />
      </nav>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {selected ? (
        <ConversationView
          key={chosen}
          client={session.client}
          conversation={selected}
          onDisconnect={() => {
            setSession(null);
            setInvite('');
          }}
        />
      ) : (
        <StartForm
          key={session.conversations.length}
          client={session.client}
          onStarted={(conversation) => {
            setSession({ ...session, conversations: [...session.conversations, conversation] });
            setChosen(conversation.conversationId);
          }}
        />
      )}
    </>
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
