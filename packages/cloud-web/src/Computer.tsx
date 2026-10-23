import { useT } from './i18n';
import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  type CloudClient,
  type ComputerFrame,
  type ComputerInput,
  displayText,
  type TaskView,
  TERMINAL,
} from '@maka-cloud/client';

export function Computer({ client, task }: { client: CloudClient; task: TaskView }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <details className="computer" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t('Open computer')}</summary>
      {open &&
        (TERMINAL.has(task.state) ? (
          <p role="status">{t('The task finished. Send a message to continue.')}</p>
        ) : (
          <ComputerViewer client={client} task={task} />
        ))}
    </details>
  );
}

function ComputerViewer({ client, task }: { client: CloudClient; task: TaskView }) {
  const { t, shared } = useT();
  const [desktop, setDesktop] = useState<ComputerFrame['desktop']>();
  const [terminal, setTerminal] = useState('');
  const [controller, setController] = useState<'agent' | 'human'>('agent');
  const [live, setLive] = useState(false);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState<'asleep' | 'crowded' | 'dropped' | 'revoked'>();
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [command, setCommand] = useState('');
  const [retryAt, setRetryAt] = useState(0);
  const [controlRetryAt, setControlRetryAt] = useState(0);
  const pending = useRef(false);
  useEffect(() => {
    if (!retryAt) return;
    const timer = setTimeout(() => setRetryAt(0), Math.max(0, retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [retryAt]);
  useEffect(() => {
    if (!controlRetryAt) return;
    const timer = setTimeout(
      () => {
        setControlRetryAt(0);
        setError('');
      },
      Math.max(0, controlRetryAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [controlRetryAt]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    setError('');
    setLive(false);
    setUnavailable(undefined);
    void client
      .watchComputer(
        task.taskId,
        (frame) => {
          setLive(true);
          setUnavailable(undefined);
          setController(frame.controller);
          if (
            frame.desktop &&
            /^(image\/png|image\/jpeg)$/.test(frame.desktop.mime) &&
            /^[A-Za-z0-9+/=]+$/.test(frame.desktop.base64)
          )
            setDesktop(frame.desktop);
          if (typeof frame.terminal === 'string')
            setTerminal((previous) => (previous + frame.terminal).slice(-32000));
        },
        abort.signal,
      )
      .catch((failure: unknown) => {
        if (abort.signal.aborted) return;
        if (failure instanceof ApiError && failure.status === 429)
          setRetryAt(Date.now() + Math.min(failure.retryAfterMs ?? 10000, 60000));
        setLive(false);
        setDesktop(undefined);
        setTerminal('');
        setUnavailable(
          failure instanceof ApiError && failure.status === 404
            ? 'asleep'
            : failure instanceof ApiError && failure.status === 429
              ? 'crowded'
              : failure instanceof ApiError && failure.status === 401
                ? 'revoked'
                : 'dropped',
        );
      });
    return () => {
      mounted.current = false;
      abort.abort();
    };
  }, [client, task.taskId, attempt]);

  async function act(work: () => Promise<unknown>) {
    if (pending.current || Date.now() < controlRetryAt) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiError && error.code === 'computer_not_in_control')
        setController('agent');
      if (error instanceof ApiError && error.status === 429)
        setControlRetryAt(Date.now() + Math.min(error.retryAfterMs ?? 10000, 60000));
      if (error instanceof ApiError && error.status === 401) {
        setUnavailable('revoked');
        setLive(false);
      }
      setError(
        error instanceof ApiError && error.status === 429
          ? 'Slow down. Try again in a moment.'
          : error instanceof ApiError && error.code === 'pause_unsupported'
            ? 'This task cannot safely pause. Watching only; no control was granted.'
            : error instanceof ApiError && error.code === 'computer_busy'
              ? 'A computer request is still in progress. Wait, then try again.'
              : error instanceof ApiError && error.code === 'computer_not_in_control'
                ? 'Your control has ended. You are watching the task.'
                : 'The action was not confirmed. Check the connection and try again.',
      );
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const human = live && controller === 'human' && task.state === 'paused';
  const input = (value: ComputerInput) => {
    if (human) void act(() => client.computerInput(task.taskId, value));
  };
  return (
    <section className="computer-viewer" aria-label={t('Task computer')}>
      <p role="status">
        {unavailable
          ? t(
              unavailable === 'asleep'
                ? 'The computer may be asleep or unavailable. Wait, then reconnect.'
                : unavailable === 'crowded'
                  ? 'Too many open views. Wait a moment, then reconnect.'
                  : unavailable === 'revoked'
                    ? 'This invite was revoked. Sign in with a valid invite.'
                    : 'The connection dropped. Reconnect to continue watching.',
            )
          : !live
            ? error
              ? t('Computer unavailable · Input disabled')
              : t('Connecting to computer…')
            : controller === 'human'
              ? t('You have control · Task paused')
              : t('Watching · Task has control')}
      </p>
      <div className="computer-actions">
        <button
          type="button"
          disabled={!live || busy || (controller === 'agent' && task.state !== 'running')}
          onClick={() =>
            void act(async () => {
              const result = await client.computerControl(
                task.taskId,
                controller === 'human' ? 'handback' : 'takeover',
              );
              if (mounted.current) setController(result.controller);
            })
          }
        >
          {busy
            ? t('Working…')
            : controller === 'human'
              ? t('Hand back control')
              : t('Take control')}
        </button>
      </div>
      <p className="computer-hint">
        {t(
          'Take control pauses the task first. Closing this view leaves it paused; reopen to hand back.',
        )}
      </p>
      {desktop ? (
        <div
          className="computer-screen"
          role="application"
          aria-label={t('Desktop controls')}
          tabIndex={human ? 0 : -1}
          onKeyDown={(event) => {
            if (!human || event.key === 'Tab') return;
            event.preventDefault();
            input({ type: 'key', key: event.key });
          }}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            event.currentTarget.focus();
            input({
              type: 'pointer',
              x: (event.clientX - rect.left) / rect.width,
              y: (event.clientY - rect.top) / rect.height,
              button: 0,
            });
          }}
        >
          <img
            alt={t('Task desktop')}
            draggable={false}
            src={`data:${desktop.mime};base64,${desktop.base64}`}
          />
        </div>
      ) : (
        <p className="computer-hint">{t('Waiting for the desktop…')}</p>
      )}
      <h4>{t('Terminal')}</h4>
      <pre aria-label={t('Live terminal output')}>
        {displayText(terminal || t('Waiting for output…'))}
      </pre>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!human || !command.trim()) return;
          void act(async () => {
            await client.computerInput(task.taskId, { type: 'terminal', text: `${command}\n` });
            if (mounted.current) setCommand('');
          });
        }}
      >
        <label>
          {t('Terminal input')}
          <input
            value={command}
            maxLength={3999}
            disabled={!human || busy}
            onChange={(event) => setCommand(displayText(event.target.value))}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <button type="submit" disabled={!human || busy || !command.trim()}>
          {t('Send input')}
        </button>
      </form>
      {error && <p role="alert">{shared(error)}</p>}
      {!live && unavailable && unavailable !== 'revoked' && (
        <button
          type="button"
          disabled={retryAt > Date.now()}
          onClick={() => setAttempt((value) => value + 1)}
        >
          {t('Reconnect computer')}
        </button>
      )}
    </section>
  );
}
