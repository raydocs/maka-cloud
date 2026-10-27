import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  TERMINAL,
  type CloudClient,
  type Conversation,
  type TaskPanel,
  type TaskView,
  type TaskMessageState,
  displayText,
  randomId,
} from '@maka-cloud/client';
import { useT } from './i18n';

export function ApprovalReceipt({ option }: { option: string }) {
  const { t } = useT();
  const scope =
    option === 'approve'
      ? 'Allowed once'
      : option === 'approve_task'
        ? 'Allowed for this task'
        : option === 'approve_repository'
          ? 'Allowed for this repository'
          : undefined;
  return scope ? (
    <span className="approval-receipt">
      {t(scope)} ·{' '}
      <a href="#grants" onClick={() => window.dispatchEvent(new Event('maka:grants'))}>
        {t('Revoke in Me · Grants')}
      </a>
    </span>
  ) : null;
}

export function elapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function RunningClock({ task }: { task: TaskView }) {
  const { t } = useT();
  const [now, setNow] = useState(Date.now);
  const held = useRef({ at: task.startedAt, paused: 0, since: undefined as number | undefined });
  useEffect(() => {
    const state = held.current;
    if (state.at !== task.startedAt)
      held.current = { at: task.startedAt, paused: 0, since: undefined };
    if (task.state === 'paused' && held.current.since === undefined)
      held.current.since = Date.now();
    if (task.state === 'running' && held.current.since !== undefined) {
      held.current.paused += Date.now() - held.current.since;
      held.current.since = undefined;
    }
    setNow(Date.now());
    if (task.state !== 'running') return;
    const tick = setInterval(() => {
      if (document.visibilityState !== 'hidden') setNow(Date.now());
    }, 1000);
    return () => clearInterval(tick);
  }, [task.state, task.startedAt]);
  if (task.startedAt === undefined || task.state !== 'running') return null;
  return (
    <span className="mono">
      {t('Working for {time}', { time: elapsed(now - task.startedAt - held.current.paused) })}
    </span>
  );
}

export function WaitingJump({
  count,
  target,
}: {
  count: number;
  target: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useT();
  const [offscreen, setOffscreen] = useState(false);
  const [first, setFirst] = useState<Element | null>(null);
  useEffect(() => {
    const cards = [...(target.current?.querySelectorAll('[data-waiting="true"]') ?? [])];
    if (!cards.length || typeof IntersectionObserver === 'undefined') {
      setOffscreen(false);
      return;
    }
    const visible = new Map<Element, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visible.set(entry.target, entry.isIntersecting);
        const hidden = cards.filter((card) => visible.get(card) === false);
        setOffscreen(hidden.length > 0);
        setFirst(hidden[0] ?? null);
      },
      { rootMargin: '0px 0px -160px 0px' },
    );
    cards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [count, target]);
  return count > 0 && offscreen ? (
    <button
      type="button"
      className="chip waiting-chip"
      onClick={() =>
        first?.scrollIntoView({
          block: 'center',
          behavior: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
            ? 'instant'
            : 'smooth',
        })
      }
    >
      {t('{count} waiting', { count })}
    </button>
  ) : null;
}

const receipts = new Map<string, Steer[]>();
let receiptGeneration = 0;
export function clearSteerReceipts() {
  receiptGeneration++;
  receipts.clear();
}
type Steer = {
  task: string;
  text: string;
  id: string;
  state?: TaskMessageState;
  restored?: boolean;
  pollingStopped?: boolean;
};
export function SteerComposer({
  client,
  conversationId,
  tasks,
  draft,
  setDraft,
  act,
  busy,
  children,
}: {
  client: CloudClient;
  conversationId?: string;
  tasks: TaskView[];
  draft: string;
  setDraft: (text: string) => void;
  act: (key: string, work: () => Promise<unknown>) => Promise<boolean>;
  busy: boolean;
  children: ReactNode;
}) {
  const { t } = useT();
  const eligible = tasks.filter(
    (task) =>
      task.steerable === true &&
      task.state === 'running' &&
      !task.cancelRequested &&
      !task.pauseRequested &&
      !task.stopPending &&
      !task.treeStopPending,
  );
  const [target, setTarget] = useState<string | undefined>();
  const automatic = eligible.length === 1 ? eligible[0]!.taskId : '';
  const frozen = useRef<string | undefined>(
    conversationId && draft.trim() && receipts.get(conversationId)?.some((row) => row.restored)
      ? ''
      : undefined,
  );
  const previousDraft = useRef(draft);
  if (!draft.trim() && previousDraft.current.trim()) frozen.current = undefined;
  else if (draft.trim() && frozen.current === undefined) frozen.current = target ?? automatic;
  previousDraft.current = draft;
  const selected = target ?? frozen.current ?? automatic;
  const taskId = eligible.some((task) => task.taskId === selected) ? selected : '';
  const [messages, updateMessages] = useState<Steer[]>(() =>
    conversationId ? (receipts.get(conversationId) ?? []) : [],
  );
  const generation = useRef(receiptGeneration);
  const messageRows = useRef(messages);
  function setMessages(update: (previous: Steer[]) => Steer[]) {
    const rows = update(messageRows.current);
    messageRows.current = rows;
    if (conversationId && generation.current === receiptGeneration)
      receipts.set(conversationId, rows);
    updateMessages(rows);
  }
  const [tooLong, setTooLong] = useState(false);
  const sending = useRef(false);
  const polling = useRef(false);
  const [unsupported, setUnsupported] = useState(false);
  useEffect(() => setUnsupported(false), [automatic]);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  // The API has no read-message route. Reusing the same id is its documented idempotent
  // status check; refresh one receipt at a time to stay within the control rate limit.
  const receiptIndex = useRef(0);
  const latest = useRef({ tasks, messages, busy });
  latest.current = { tasks, messages, busy };
  useEffect(() => {
    let current = true;
    let retryAt = 0;
    let failures = 0;
    const refresh = setInterval(() => {
      const { messages, busy } = latest.current;
      if (
        Date.now() < retryAt ||
        document.visibilityState === 'hidden' ||
        busy ||
        sending.current ||
        polling.current
      )
        return;
      const pending = messages.filter(
        (message) => message.state === 'pending' && !message.pollingStopped,
      );
      if (!pending.length) return;
      const message = pending[receiptIndex.current++ % pending.length]!;
      polling.current = true;
      void client
        .sendTaskMessage(message.task, message.text, message.id)
        .then(
          (result) => {
            failures = 0;
            if (current)
              setMessages((previous) =>
                previous.map((row) =>
                  row.id === message.id && row.state === 'pending'
                    ? { ...row, state: result.message.state }
                    : row,
                ),
              );
          },
          (error: unknown) => {
            if (!current) return;
            if (
              error instanceof ApiError &&
              error.status >= 400 &&
              error.status < 500 &&
              error.status !== 429
            ) {
              setMessages((previous) =>
                previous.map((row) =>
                  row.id === message.id ? { ...row, pollingStopped: true } : row,
                ),
              );
            } else {
              failures++;
              retryAt =
                Date.now() +
                Math.max(
                  error instanceof ApiError ? (error.retryAfterMs ?? 0) : 0,
                  Math.min(300000, 10000 * 2 ** Math.min(failures, 5)),
                );
            }
          },
        )
        .finally(() => {
          polling.current = false;
        });
    }, 10000);
    return () => {
      current = false;
      clearInterval(refresh);
    };
  }, [client]);
  useEffect(() => {
    const unread = messages.filter(
      (message) =>
        !message.restored &&
        (message.state === 'unseen' ||
          (message.state === undefined &&
            tasks.some((task) => task.taskId === message.task && TERMINAL.has(task.state)))),
    );
    if (!unread.length) return;
    setMessages((previous) =>
      previous.map((message) =>
        unread.some((row) => row.id === message.id) ? { ...message, restored: true } : message,
      ),
    );
    setTarget(undefined);
    frozen.current = '';
    const text = unread.map((message) => message.text).join('\n\n');
    if (latestDraft.current.trim() !== text)
      setDraft(latestDraft.current ? `${latestDraft.current}\n\n${text}` : text);
  }, [messages, tasks, setDraft]);
  async function send(message: Steer) {
    if (sending.current) return;
    setUnsupported(false);
    sending.current = true;
    try {
      await act('steer', async () => {
        let result;
        try {
          result = await client.sendTaskMessage(message.task, message.text, message.id);
        } catch (error) {
          if (
            error instanceof ApiError &&
            error.status === 409 &&
            error.code === 'steer_unsupported'
          ) {
            setUnsupported(true);
            setTarget(undefined);
            frozen.current = '';
            setMessages((previous) => previous.filter((row) => row.id !== message.id));
            return;
          }
          throw error;
        }
        setMessages((previous) =>
          previous.map((row) =>
            row.id === message.id ? { ...row, state: result.message.state } : row,
          ),
        );
        if (latestDraft.current.trim() === message.text && message.state === undefined)
          setDraft('');
      });
    } finally {
      sending.current = false;
    }
  }
  return (
    <div
      className="composer"
      data-steering={Boolean(taskId)}
      onSubmitCapture={(event) => {
        setUnsupported(false);
        if (!taskId) return;
        event.preventDefault();
        event.stopPropagation();
        if (!draft.trim() || busy || sending.current) return;
        setTooLong(draft.trim().length > 4000);
        if (draft.trim().length > 4000) return;
        const existing = messages.find(
          (row) => row.state === undefined && row.task === taskId && row.text === draft.trim(),
        );
        const message = existing ?? { task: taskId, text: draft.trim(), id: randomId() };
        if (!existing) setMessages((previous) => [...previous, message]);
        void send(message);
      }}
    >
      {unsupported && (
        <p role="alert">
          {t('This task cannot take messages. Your draft is kept; send it as a new request.')}
        </p>
      )}
      {tooLong && (
        <p role="alert">{t('A message to a running task can have up to 4,000 characters.')}</p>
      )}
      {eligible.length > 0 && (
        <label className="steer-target">
          <span>{t('To the running task')}</span>
          <select
            aria-label={t('To the running task')}
            value={taskId}
            disabled={busy}
            onChange={(event) => {
              setUnsupported(false);
              setTarget(event.target.value);
              frozen.current = event.target.value;
            }}
          >
            <option value="">{t('Send as a new request')}</option>
            {eligible.map((task) => (
              <option key={task.taskId} value={task.taskId}>
                {displayText(task.title ?? t('Task'))}
              </option>
            ))}
          </select>
        </label>
      )}
      {messages.map((message) => (
        <div key={message.id} className="steer-receipt">
          <p>{displayText(message.text)}</p>
          <span>
            {t('To the running task')} ·{' '}
            {message.state === undefined
              ? t(
                  message.restored
                    ? 'Delivery not confirmed. Your message is back in the draft.'
                    : 'Delivery not confirmed. Try again with the same message.',
                )
              : t(
                  (
                    {
                      pending: 'Waiting for the next step',
                      delivered: 'Read by the task',
                      withdrawn: 'Taken back',
                      unseen: 'Not read before the task ended',
                    } as const
                  )[message.state],
                )}
          </span>
          {(message.state === undefined || message.state === 'pending') &&
            tasks.some((task) => task.taskId === message.task && !TERMINAL.has(task.state)) && (
              <button type="button" disabled={busy} onClick={() => void send(message)}>
                {t('Check delivery')}
              </button>
            )}
          {message.state === 'pending' &&
            tasks.some((task) => task.taskId === message.task && !TERMINAL.has(task.state)) && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act('withdraw', async () => {
                    let result;
                    try {
                      result = await client.withdrawTaskMessage(message.task, message.id);
                    } catch (error) {
                      if (
                        !(error instanceof ApiError) ||
                        error.status !== 409 ||
                        error.code !== 'invalid_state'
                      )
                        throw error;
                      result = await client.sendTaskMessage(message.task, message.text, message.id);
                    }
                    setMessages((previous) =>
                      previous.map((row) =>
                        row.id === message.id ? { ...row, state: result.message.state } : row,
                      ),
                    );
                  })
                }
              >
                {t('Take back')}
              </button>
            )}
        </div>
      ))}
      {children}
    </div>
  );
}

export function ConversationChoices({
  client,
  conversations,
  onChoose,
}: {
  client: CloudClient;
  conversations: Conversation[];
  onChoose: (id: string) => void;
}) {
  const { t } = useT();
  const [states, setStates] = useState<Record<string, 'Needs you' | 'Working' | 'Recent'>>({});
  useEffect(() => {
    let current = true;
    async function read() {
      const inbox = await client.listInbox().catch(() => undefined);
      await Promise.all(
        conversations.map(async (conversation) => {
          const tasks = await client.listTasks(conversation.conversationId).catch(() => undefined);
          if (!current || !tasks || !inbox) return;
          const waiting =
            inbox.some(
              (item) =>
                item.conversationId === conversation.conversationId &&
                item.state !== 'closed' &&
                item.kind !== 'suggestion',
            ) || tasks.some((task) => task.state === 'paused');
          const working = tasks.some((task) => task.state === 'running' || task.state === 'queued');
          setStates((previous) => ({
            ...previous,
            [conversation.conversationId]: waiting ? 'Needs you' : working ? 'Working' : 'Recent',
          }));
        }),
      );
    }
    void read();
    const refresh = setInterval(() => void read(), 15000);
    return () => {
      current = false;
      clearInterval(refresh);
    };
  }, [client, conversations]);
  return (
    <>
      {(['Needs you', 'Working', 'Recent'] as const).map((group) => {
        const rows = conversations
          .filter((c) => (states[c.conversationId] ?? 'Recent') === group)
          .sort((a, b) => b.createdAt - a.createdAt);
        return (
          rows.length > 0 && (
            <section key={group} aria-label={t(group)}>
              <h3>{t(group)}</h3>
              {rows.map((conversation) => (
                <button
                  type="button"
                  key={conversation.conversationId}
                  onClick={() => onChoose(conversation.conversationId)}
                >
                  <span>{displayText(conversation.title ?? t('Untitled conversation'))}</span>
                  <small>{t(group)}</small>
                </button>
              ))}
            </section>
          )
        );
      })}
    </>
  );
}

/**
 * The work as chips: tests, changes, review. Each is the check's own result, and opening one shows
 * the last lines it printed. A reader copy, never the proof.
 */
export function PanelChips({ panels }: { panels: readonly TaskPanel[] }) {
  const { t } = useT();
  const [open, setOpen] = useState<string>();
  const shown = panels.find((panel) => panel.panelId === open);
  return (
    <div className="panel-chips">
      <div className="chip-row">
        {panels.map((panel) => (
          <button
            key={panel.panelId}
            type="button"
            className={`panel-chip ${panel.state}`}
            aria-expanded={open === panel.panelId}
            onClick={() => setOpen(open === panel.panelId ? undefined : panel.panelId)}
          >
            <span className="panel-mark" aria-hidden="true">
              {panel.state === 'passed' ? '✓' : panel.state === 'failed' ? '!' : ''}
            </span>
            <span className="panel-title">{displayText(panel.title)}</span>
            <span className="panel-summary">{displayText(panel.summary)}</span>
          </button>
        ))}
      </div>
      {shown?.tail && (
        <pre className="panel-tail solid" aria-label={t('Last lines')}>
          {displayText(shown.tail)}
        </pre>
      )}
    </div>
  );
}
