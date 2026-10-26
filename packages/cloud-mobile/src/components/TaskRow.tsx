import {
  BRAND,
  displayText,
  dollars,
  stepsOf,
  TERMINAL,
  taskLabel,
  type TaskControl,
  type TaskView,
} from '@maka-cloud/client';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useT } from '@/lib/i18n';
import { mono } from '@/lib/theme';
import { FailureNote, QuietButton, Shimmer, StatusMark, T } from './ui';

const TONE = { succeeded: 'ok', failed: 'bad', cancelled: 'idle', paused: 'attention' } as const;

const PANEL_WORDS = {
  shell: 'task.panel.shell',
  tests: 'task.panel.tests',
  diff: 'task.panel.diff',
  review: 'task.panel.review',
  search: 'task.panel.search',
} as const;

/**
 * The work item's small metadata line, in tabular figures: when it started, who is doing it and,
 * once the run shows its tools, the latest one ("14:05 · Maka · Tests").
 */
function MetaLine({ task }: { task: TaskView }) {
  const { t: say, lang } = useT();
  const at = new Date(task.startedAt ?? task.createdAt).toLocaleTimeString(lang, {
    hour: '2-digit',
    minute: '2-digit',
  });
  const tool = task.panels?.at(-1)?.kind;
  return (
    <T kind="small" testID="task-meta" style={{ fontVariant: ['tabular-nums'] }}>
      {[at, BRAND.name, ...(tool ? [say(PANEL_WORDS[tool])] : [])].join(' · ')}
    </T>
  );
}

/** The one updating line of a running task, and the steps behind it when it is opened. */
function StepLine({ notes }: { notes: readonly string[] }) {
  const { current, steps } = stepsOf(notes);
  const [open, setOpen] = useState(false);
  const { t: say } = useT();
  if (current === undefined) return null;
  return (
    <View style={{ gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={say('task.currentStepLabel', { step: displayText(current) })}
        accessibilityState={{ expanded: open }}
        onPress={() => steps.length > 1 && setOpen(!open)}
        style={{ minHeight: 44, justifyContent: 'center' }}
      >
        <T kind="small">{say('task.currentStep')}</T>
        <Shimmer>
          <T kind="body">{displayText(current)}</T>
        </Shimmer>
      </Pressable>
      {open &&
        steps.map((step, i) => <T key={i} kind="muted">{`${i + 1}. ${displayText(step)}`}</T>)}
    </View>
  );
}

/**
 * A task, its live step and its controls, with its subtasks under it. Only what is known is shown:
 * no cost line until the server reports one. `resultCard` says a finished task's result card is on
 * the screen too, so its summary is read there and not twice.
 */
export function TaskRow({
  task,
  tasks,
  noPause,
  busy,
  onControl,
  resultCard = false,
  ancestors = [],
}: {
  task: TaskView;
  tasks: readonly TaskView[];
  noPause: ReadonlySet<string>;
  busy: boolean;
  onControl: (taskId: string, action: TaskControl) => void;
  resultCard?: boolean;
  ancestors?: string[];
}) {
  const { t: say, tx } = useT();
  // A bad parent reference cannot make rendering loop forever.
  if (ancestors.includes(task.taskId)) return null;
  const children = tasks.filter((child) => child.parentTaskId === task.taskId);
  const live = !TERMINAL.has(task.state) && !task.cancelRequested;
  const stopping = task.stopPending || task.treeStopPending;
  const title = task.title ? displayText(task.title) : say('task.title');
  const showCost = task.parentTaskId === undefined && task.costUsd !== undefined;
  const spent = tx(dollars(task.costUsd));
  // The result card says the outcome of a finished task; the row does not repeat it.
  const summaryElsewhere = resultCard && task.state === 'succeeded';
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <StatusMark tone={TONE[task.state as keyof typeof TONE] ?? 'attention'} />
        {/* The row's one semibold line; a heading to a screen reader. */}
        <T kind="heading" style={{ flex: 1 }}>
          {title}
        </T>
      </View>
      <MetaLine task={task} />
      <T kind="muted">
        {tx(taskLabel(task))}
        {showCost && ` · ${say(live ? 'task.costSoFar' : 'task.cost')}${say('common.colon')}`}
        {showCost && (
          <T kind="muted" style={mono}>
            {task.budgetUsd !== undefined
              ? say('task.ofBudget', { spent, budget: tx(dollars(task.budgetUsd)) })
              : spent}
          </T>
        )}
      </T>
      {task.budgetExceeded && <T kind="error">{say('task.budgetReached')}</T>}
      {stopping && <T kind="muted">{say('task.stopping')}</T>}
      {/* A finished task has no "current step". */}
      {live && task.progress.length > 0 && <StepLine notes={task.progress} />}
      {task.failureReason ? <FailureNote reason={task.failureReason} /> : null}
      {task.manifest && !summaryElsewhere ? (
        <T kind="body">{displayText(task.manifest.summary)}</T>
      ) : null}
      {live && (
        // Quiet words, as on the web: the task is the thing to read, the controls are a glance.
        <View style={{ flexDirection: 'row', gap: 20 }}>
          {task.state === 'running' && !task.pauseRequested && !noPause.has(task.taskId) && (
            <QuietButton
              label={say('task.pause')}
              accessibilityLabel={say('task.pauseLabel')}
              id="Pause"
              disabled={busy}
              onPress={() => onControl(task.taskId, 'pause')}
            />
          )}
          {task.state === 'paused' && (
            <QuietButton
              label={say('task.resume')}
              accessibilityLabel={say('task.resumeLabel')}
              id="Resume"
              disabled={busy}
              onPress={() => onControl(task.taskId, 'resume')}
            />
          )}
          <QuietButton
            label={say('task.cancel')}
            accessibilityLabel={say('task.cancelLabel')}
            id="Cancel"
            disabled={busy}
            onPress={() => onControl(task.taskId, 'cancel')}
          />
        </View>
      )}
      {children.length > 0 && (
        <View style={{ marginLeft: 14, gap: 10 }}>
          {children.map((child) => (
            <TaskRow
              key={child.taskId}
              task={child}
              tasks={tasks}
              noPause={noPause}
              busy={busy}
              onControl={onControl}
              ancestors={[...ancestors, task.taskId]}
            />
          ))}
        </View>
      )}
    </View>
  );
}
