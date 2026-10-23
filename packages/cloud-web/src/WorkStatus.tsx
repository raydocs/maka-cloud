import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import {
  type CloudClient,
  type Conversation,
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
    <p className="muted mono">
      {t('Working for {time}', { time: elapsed(now - task.startedAt - held.current.paused) })}
    </p>
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

type Steer = { task: string; text: string; id: string; state?: TaskMessageState };
export function SteerComposer({
  client,
  tasks,
  draft,
  setDraft,
  act,
  busy,
  children,
}: {
  client: CloudClient;
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
      task.state === 'running' &&
      !task.cancelRequested &&
      !task.pauseRequested &&
      !task.stopPending &&
      !task.treeStopPending,
  );
  const [target, setTarget] = useState<string | undefined>();
  const taskId =
    target !== undefined && !eligible.some((task) => task.taskId === target)
      ? ''
      : eligible.some((task) => task.taskId === target)
        ? target!
        : eligible.length === 1
          ? eligible[0]!.taskId
          : '';
  const [messages, setMessages] = useState<Steer[]>([]);
  const [tooLong, setTooLong] = useState(false);
  const sending = useRef(false);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  // The API has no read-message route. Reusing the same id is its documented idempotent
  // status check; refresh one receipt at a time to stay within the control rate limit.
  const receiptIndex = useRef(0);
  const latest = useRef({ tasks, messages, busy });
  latest.current = { tasks, messages, busy };
  useEffect(() => {
    let current = true;
    const refresh = setInterval(() => {
      const { tasks, messages, busy } = latest.current;
      if (document.visibilityState === 'hidden' || busy || sending.current) return;
      const pending = messages.filter(
        (message) =>
          message.state === 'pending' &&
          tasks.some((task) => task.taskId === message.task && task.state === 'running'),
      );
      if (!pending.length) return;
      const message = pending[receiptIndex.current++ % pending.length]!;
      sending.current = true;
      void client
        .sendTaskMessage(message.task, message.text, message.id)
        .then(
          (result) => {
            if (current)
              setMessages((previous) =>
                previous.map((row) =>
                  row.id === message.id && row.state === 'pending'
                    ? { ...row, state: result.message.state }
                    : row,
                ),
              );
          },
          () => {},
        )
        .finally(() => {
          sending.current = false;
        });
    }, 10000);
    return () => {
      current = false;
      clearInterval(refresh);
    };
  }, [client]);
  async function send(message: Steer) {
    if (sending.current) return;
    sending.current = true;
    try {
      await act('steer', async () => {
        const result = await client.sendTaskMessage(message.task, message.text, message.id);
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
            onChange={(event) => setTarget(event.target.value)}
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
              ? t('Delivery not confirmed. Try again with the same message.')
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
          {(message.state === undefined || message.state === 'pending') && (
            <button type="button" disabled={busy} onClick={() => void send(message)}>
              {t('Check delivery')}
            </button>
          )}
          {message.state === 'pending' && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void act('withdraw', async () => {
                  const result = await client.withdrawTaskMessage(message.task, message.id);
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
