import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  BRAND,
  displayText,
  stepsOf,
  type TaskPanel,
  taskLabel,
  type TaskView,
  TERMINAL,
} from '@maka-cloud/client';
import { useT } from './i18n';

/**
 * On a wide screen the space beside the conversation is the employee's computer while it works: the
 * plan as a timeline, the line it is on now, and each check with what it printed. Its screen stays
 * on the task card, next to pause and resume. The conversation
 * renders it into the `#work-stage` slot that the shell keeps at the top of the side pane.
 */
export function WorkStagePortal({ tasks }: { tasks: TaskView[] }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  // The slot comes and goes with the screen's width, so look again after each render.
  useEffect(() => {
    const found = document.getElementById('work-stage');
    if (found !== slot) setSlot(found);
  });
  // The task being worked on now; with none, the stage steps aside and Home shows.
  const task = tasks
    .filter((candidate) => candidate.parentTaskId === undefined && !TERMINAL.has(candidate.state))
    .at(-1);
  if (!task) return null;
  // Wide: the side pane. Narrow: a bar over the composer that opens the same computer as a sheet.
  return slot ? createPortal(<WorkStage task={task} />, slot) : <PhoneStage task={task} />;
}

function PhoneStage({ task }: { task: TaskView }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const { current } = stepsOf(task.progress);
  const now = task.narration ?? current ?? t('Working…');
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);
  return (
    <>
      <button
        type="button"
        className="stage-bar"
        aria-label={t("Open {name}'s computer", { name: BRAND.name })}
        onClick={() => setOpen(true)}
      >
        <span className="stage-live" aria-hidden="true" />
        <span className="stage-bar-text">
          <span className="stage-bar-title">{t("{name}'s computer", { name: BRAND.name })}</span>
          <span className="stage-bar-now">{displayText(now)}</span>
        </span>
      </button>
      {open && (
        <div
          className="stage-sheet"
          role="dialog"
          aria-modal="true"
          aria-label={t("{name}'s computer", { name: BRAND.name })}
        >
          <button
            type="button"
            className="stage-scrim"
            aria-label={t('Close')}
            onClick={() => setOpen(false)}
          />
          <div className="stage-sheet-body">
            <span className="stage-grip" aria-hidden="true" />
            <WorkStage task={task} onClose={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}

function WorkStage({ task, onClose }: { task: TaskView; onClose?: () => void }) {
  const { t, shared } = useT();
  const { current, steps } = stepsOf(task.progress);
  const now = task.narration ?? current;
  return (
    <section className="work-stage" aria-label={t("{name}'s computer", { name: BRAND.name })}>
      <header className="stage-head">
        <span className="stage-live" aria-hidden="true" />
        <div className="stage-head-text">
          <h2>{t("{name}'s computer", { name: BRAND.name })}</h2>
          <p className="muted">
            {/* The clock stays on the task card; one running clock is enough. */}
            {displayText(task.title ?? t('Task'))} · {shared(taskLabel(task))}
          </p>
        </div>
        {onClose && (
          <button type="button" className="stage-close" onClick={onClose}>
            {t('Close')}
          </button>
        )}
      </header>
      {now && (
        <p className="stage-now" aria-live="polite">
          <span className="step-now">{displayText(now)}</span>
        </p>
      )}
      {steps.length > 0 && (
        <ol className="stage-steps" aria-label={t('Steps')}>
          {steps.map((step, i) => {
            const state = i < steps.length - 1 ? 'done' : 'now';
            return (
              <li key={i} className={`stage-step ${state}`}>
                <span className="stage-step-mark" aria-hidden="true" />
                {displayText(step)}
              </li>
            );
          })}
        </ol>
      )}
      {task.panels && task.panels.length > 0 && (
        <div className="stage-panels">
          {task.panels.map((panel) => (
            <StagePanel key={panel.panelId} panel={panel} />
          ))}
        </div>
      )}
    </section>
  );
}

function StagePanel({ panel }: { panel: TaskPanel }) {
  return (
    <article className={`stage-panel ${panel.state}`} aria-label={displayText(panel.title)}>
      <div className="stage-panel-head">
        <span className={`panel-chip ${panel.state}`}>
          <span className="panel-mark" aria-hidden="true">
            {panel.state === 'passed' ? '✓' : panel.state === 'failed' ? '!' : ''}
          </span>
          <span className="panel-title">{displayText(panel.title)}</span>
        </span>
        <span className="panel-summary">{displayText(panel.summary)}</span>
      </div>
      {panel.tail && <pre className="stage-tail">{displayText(panel.tail)}</pre>}
    </article>
  );
}
