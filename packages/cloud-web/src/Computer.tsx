import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  type CloudClient,
  type ComputerFrame,
  type ComputerInput,
  displayText,
  type TaskView,
} from '@maka-cloud/client';

export function Computer({ client, task }: { client: CloudClient; task: TaskView }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="computer" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Open computer</summary>
      {open && <ComputerViewer client={client} task={task} />}
    </details>
  );
}

function ComputerViewer({ client, task }: { client: CloudClient; task: TaskView }) {
  const [desktop, setDesktop] = useState<ComputerFrame['desktop']>();
  const [terminal, setTerminal] = useState('');
  const [controller, setController] = useState<'agent' | 'human'>('agent');
  const [live, setLive] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [command, setCommand] = useState('');
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    setError('');
    void client
      .watchComputer(
        task.taskId,
        (frame) => {
          setLive(true);
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
      .catch(() => {
        if (abort.signal.aborted) return;
        setLive(false);
        setDesktop(undefined);
        setTerminal('');
        setError(
          'Computer disconnected or unavailable. Input is disabled. Reconnect to check control.',
        );
      });
    return () => {
      mounted.current = false;
      abort.abort();
    };
  }, [client, task.taskId, attempt]);

  async function act(work: () => Promise<unknown>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (error) {
      if (!mounted.current) return;
      setError(
        error instanceof ApiError && error.code === 'pause_unsupported'
          ? 'This task cannot safely pause. Watching only; no control was granted.'
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
    <section className="computer-viewer" aria-label="Task computer">
      <p role="status">
        {!live
          ? error
            ? 'Computer unavailable · Input disabled'
            : 'Connecting to computer…'
          : controller === 'human'
            ? 'You have control · Task paused'
            : 'Watching · Task has control'}
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
          {busy ? 'Working…' : controller === 'human' ? 'Hand back control' : 'Take control'}
        </button>
      </div>
      <p className="computer-hint">
        Take control pauses the task first. Closing this view leaves it paused; reopen to hand back.
      </p>
      {desktop ? (
        <div
          className="computer-screen"
          role="application"
          aria-label="Desktop controls"
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
            alt="Task desktop"
            draggable={false}
            src={`data:${desktop.mime};base64,${desktop.base64}`}
          />
        </div>
      ) : (
        <p className="computer-hint">Waiting for the desktop…</p>
      )}
      <h4>Terminal</h4>
      <pre aria-label="Live terminal output">{displayText(terminal || 'Waiting for output…')}</pre>
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
          Terminal input
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
          Send input
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {!live && error && (
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          Reconnect computer
        </button>
      )}
    </section>
  );
}
