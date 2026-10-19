import { useEffect, useRef, useState } from 'react';
import { Button } from '@astryxdesign/core';
import { ChoicePanel } from '@maka/ui';
import { ApiError, CloudClient, Unsupported } from './client';
import type { Artifact, Conversation, OutboxQuestion, TaskView } from './contract';
import { displayText, dollars, publicLink } from './presentation';
import { enablePush } from './push';
import { applyEvent, emptyState, type ConversationState } from './state';

function errorText(error: unknown): string {
  if (error instanceof Unsupported)
    return 'This action is unavailable on this server. No change was made.';
  if (error instanceof ApiError)
    return error.status === 401
      ? 'Your invite is no longer valid. Please reconnect.'
      : `Could not complete the request (${error.status}). Try again.`;
  return 'Could not complete the request. Check your connection and try again.';
}

export function QuestionCard({
  question,
  answered,
  disabled,
  available,
  onAnswer,
}: {
  question: OutboxQuestion;
  answered?: string;
  disabled: boolean;
  available: boolean;
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
        {answered ? 'Decision recorded' : 'Needs your decision'}
      </div>
      <h3>{displayText(question.question)}</h3>
      {answered ? (
        <p className="acknowledged">
          Answer recorded:{' '}
          {displayText(question.options.find((o) => o.id === answered)?.label ?? 'Selected option')}
        </p>
      ) : available ? (
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
      ) : (
        <p className="muted">Answers are not supported by this server yet.</p>
      )}
    </section>
  );
}

function TaskBranch({
  task,
  tasks,
  state,
  client,
  conversationId,
  busy,
  act,
  ancestors = [],
}: {
  task: TaskView;
  tasks: TaskView[];
  state: ConversationState;
  client: CloudClient;
  conversationId: string;
  busy: boolean;
  act: (key: string, work: () => Promise<unknown>) => Promise<void>;
  ancestors?: string[];
}) {
  // A bad parent reference cannot make rendering loop forever.
  if (ancestors.includes(task.taskId)) return null;
  const running = task.state === 'running';
  const paused = state.paused[task.taskId];
  const label =
    paused && running
      ? 'Paused'
      : task.cancelRequested && running
        ? 'Cancelling…'
        : {
            queued: 'Queued',
            running: 'In progress',
            succeeded: 'Finished',
            failed: 'Failed',
            cancelled: 'Cancelled',
          }[task.state];
  return (
    <li>
      <article className="task" aria-label={displayText(task.title ?? 'Task')}>
        <div className="task-title">
          <span className={`status-mark ${task.state}`} />
          <h3>{displayText(task.title ?? 'Task')}</h3>
        </div>
        <div className="task-meta">
          <span>{label}</span>
          <span>Cost so far: {dollars(state.costs[task.taskId])}</span>
        </div>
        {task.progress.length > 0 && (
          <p className="current-step">
            <span>Current step</span>
            {displayText(task.progress.at(-1) ?? '')}
          </p>
        )}
        {task.failureReason && <p className="failure">{displayText(task.failureReason)}</p>}
        {task.manifest && <p>{displayText(task.manifest.summary)}</p>}
        {running && !task.cancelRequested && (
          <div className="task-actions">
            {client.capabilities.taskPause !== false && (
              <Button
                label={paused ? 'Resume task' : 'Pause task'}
                variant="secondary"
                isDisabled={busy}
                onClick={() =>
                  void act(`pause-${task.taskId}`, () =>
                    client.pause(conversationId, task.taskId, !paused),
                  )
                }
              />
            )}
            {client.capabilities.taskCancel !== false && (
              <Button
                label="Cancel task"
                variant="secondary"
                isDisabled={busy}
                onClick={() =>
                  void act(`cancel-${task.taskId}`, () =>
                    client.cancel(conversationId, task.taskId),
                  )
                }
              />
            )}
          </div>
        )}
      </article>
      {tasks.some((child) => child.parentTaskId === task.taskId) && (
        <ul className="task-children">
          {tasks
            .filter((child) => child.parentTaskId === task.taskId)
            .map((child) => (
              <TaskBranch
                key={child.taskId}
                {...{ task: child, tasks, state, client, conversationId, busy, act }}
                ancestors={[...ancestors, task.taskId]}
              />
            ))}
        </ul>
      )}
    </li>
  );
}

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
  const [artifacts, setArtifacts] = useState<Record<string, Artifact>>({});
  const [notifications, setNotifications] = useState(false);
  const [notificationHint, setNotificationHint] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const tasks = await client.listTasks(conversation.conversationId);
        if (controller.signal.aborted) return;
        setState({
          ...emptyState(),
          tasks: Object.fromEntries(tasks.map((task) => [task.taskId, task])),
        });
        await client.subscribe(
          conversation.conversationId,
          (event) => {
            if (event.data.conversationId !== conversation.conversationId) return;
            setState((previous) => applyEvent(previous, event));
          },
          setStatus,
          controller.signal,
        );
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(errorText(e));
          setStatus('Disconnected');
        }
      }
    }
    void load();
    return () => controller.abort();
  }, [client, conversation.conversationId]);

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

  const tasks = Object.values(state.tasks);
  const refs = [...new Set(tasks.flatMap((task) => task.manifest?.artifacts ?? []))];
  const running = tasks.filter(
    (task) => task.state === 'running' && !state.paused[task.taskId],
  ).length;
  const costValues = tasks.map((task) => state.costs[task.taskId]);
  const total =
    costValues.length && costValues.every((n) => n !== undefined)
      ? costValues.reduce((sum, n) => sum + n, 0)
      : undefined;

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
          {Object.values(state.questions).map((question) => (
            <QuestionCard
              key={question.questionId}
              question={question}
              answered={state.answers[question.questionId]}
              available={client.capabilities.answers !== false}
              disabled={Boolean(busy)}
              onAnswer={(optionId, text) =>
                void act('answer', async () => {
                  const result = await client.answer(conversation.conversationId, {
                    questionId: question.questionId,
                    optionId,
                    ...(text ? { text } : {}),
                  });
                  if (!result.accepted) throw new Error('Answer was not accepted');
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
              <strong>{dollars(total)}</strong>
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
                      conversationId={conversation.conversationId}
                      {...{ task, tasks, state, client, busy: Boolean(busy), act }}
                    />
                  ))}
              </ul>
            ) : (
              <p className="muted">Tasks will appear as the plan takes shape.</p>
            )}
          </section>
          <section className="artifacts" aria-label="Artifacts">
            <h2 className="panel-heading">Ready to review</h2>
            {!refs.length && (
              <p className="muted">Reports, changes, and pull requests will collect here.</p>
            )}
            {refs.map((ref, index) => {
              const artifact = artifacts[ref];
              const link = publicLink(artifact?.url ?? ref);
              return (
                <article className="artifact" key={ref}>
                  <div className="artifact-heading">
                    <span className="file-symbol" aria-hidden="true">
                      ▤
                    </span>
                    <h3>{artifact ? displayText(artifact.title) : `Result ${index + 1}`}</h3>
                  </div>
                  {artifact && (
                    <span className="artifact-kind">
                      {artifact.kind === 'pr'
                        ? 'Pull request'
                        : artifact.kind === 'diff'
                          ? 'Changes'
                          : 'Report'}
                    </span>
                  )}
                  {link && (
                    <a href={link} target="_blank" rel="noreferrer noopener">
                      {artifact?.kind === 'pr' ? 'Open pull request' : 'Open result'} ↗
                    </a>
                  )}
                  {!artifact && client.capabilities.artifacts !== false && (
                    <Button
                      label={`Review result ${index + 1}`}
                      variant="secondary"
                      isDisabled={Boolean(busy)}
                      onClick={() =>
                        void act('artifact', async () => {
                          const result = await client.artifact(conversation.conversationId, ref);
                          setArtifacts((previous) => ({ ...previous, [ref]: result }));
                        })
                      }
                    />
                  )}
                  {artifact?.content && (
                    <pre className={artifact.kind === 'diff' ? 'diff-content' : 'report-content'}>
                      {displayText(artifact.content)}
                    </pre>
                  )}
                  {!artifact && !link && client.capabilities.artifacts === false && (
                    <p className="muted">Preview is unavailable on this server.</p>
                  )}
                </article>
              );
            })}
          </section>
          <section className="notifications">
            <h2>Step away. Stay in the loop.</h2>
            <p className="muted">
              Get a notification when background work finishes, even after you close this page.
            </p>
            {client.capabilities.push !== false && !notifications && (
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
            {notifications && <p role="status">Background notifications enabled</p>}
            {client.capabilities.push === false && (
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
      const client = new CloudClient(token);
      const [result] = await Promise.all([client.listConversations(), client.discover()]);
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
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const created = await session.client.createConversation();
              const conversation = { ...created, title: null, createdAt: Date.now() };
              setSession({ ...session, conversations: [...session.conversations, conversation] });
              setChosen(created.conversationId);
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
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
        <main className="welcome">
          <h1>Make room for your next idea.</h1>
          <p>Create a conversation to get started.</p>
        </main>
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
