import {
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
import { mono } from '@/lib/theme';
import { FailureNote, QuietButton, StatusMark, T } from './ui';

const TONE = { succeeded: 'ok', failed: 'bad', cancelled: 'idle', paused: 'attention' } as const;

/** The one updating line of a running task, and the steps behind it when it is opened. */
function StepLine({ notes }: { notes: readonly string[] }) {
  const { current, steps } = stepsOf(notes);
  const [open, setOpen] = useState(false);
  if (current === undefined) return null;
  return (
    <View style={{ gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Current step: ${displayText(current)}`}
        accessibilityState={{ expanded: open }}
        onPress={() => steps.length > 1 && setOpen(!open)}
        style={{ minHeight: 44, justifyContent: 'center' }}
      >
        <T kind="small">Current step</T>
        <T kind="body">{displayText(current)}</T>
      </Pressable>
      {open &&
        steps.map((step, i) => <T key={i} kind="muted">{`${i + 1}. ${displayText(step)}`}</T>)}
    </View>
  );
}

/** A task, its live step and its controls, with its subtasks under it. */
export function TaskRow({
  task,
  tasks,
  noPause,
  busy,
  onControl,
  ancestors = [],
}: {
  task: TaskView;
  tasks: readonly TaskView[];
  noPause: ReadonlySet<string>;
  busy: boolean;
  onControl: (taskId: string, action: TaskControl) => void;
  ancestors?: string[];
}) {
  // A bad parent reference cannot make rendering loop forever.
  if (ancestors.includes(task.taskId)) return null;
  const children = tasks.filter((child) => child.parentTaskId === task.taskId);
  const live = !TERMINAL.has(task.state) && !task.cancelRequested;
  const stopping = task.stopPending || task.treeStopPending;
  const title = displayText(task.title ?? 'Task');
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <StatusMark tone={TONE[task.state as keyof typeof TONE] ?? 'attention'} />
        {/* A bold lead-in at reading size, as the panel's text has; still a heading to a screen reader. */}
        <T kind="heading" style={{ flex: 1, fontSize: 16, lineHeight: 22, fontWeight: '700' }}>
          {title}
        </T>
      </View>
      <T kind="muted">
        {taskLabel(task)}
        {task.parentTaskId === undefined && ` · ${live ? 'Cost so far' : 'Cost'}: `}
        {task.parentTaskId === undefined && (
          <T kind="muted" style={mono}>
            {`${dollars(task.costUsd)}${task.budgetUsd !== undefined ? ` of ${dollars(task.budgetUsd)}` : ''}`}
          </T>
        )}
      </T>
      {task.budgetExceeded && <T kind="error">The budget was reached, so the work was stopped.</T>}
      {stopping && <T kind="muted">Still stopping. The cost may change until it has stopped.</T>}
      {/* A finished task has no "current step". */}
      {live && task.progress.length > 0 && <StepLine notes={task.progress} />}
      {task.failureReason ? <FailureNote reason={task.failureReason} /> : null}
      {task.manifest ? <T kind="body">{displayText(task.manifest.summary)}</T> : null}
      {live && (
        // Quiet words, as on the web: the task is the thing to read, the controls are a glance.
        <View style={{ flexDirection: 'row', gap: 20 }}>
          {task.state === 'running' && !task.pauseRequested && !noPause.has(task.taskId) && (
            <QuietButton
              label="Pause"
              accessibilityLabel="Pause task"
              disabled={busy}
              onPress={() => onControl(task.taskId, 'pause')}
            />
          )}
          {task.state === 'paused' && (
            <QuietButton
              label="Resume"
              accessibilityLabel="Resume task"
              disabled={busy}
              onPress={() => onControl(task.taskId, 'resume')}
            />
          )}
          <QuietButton
            label="Cancel"
            accessibilityLabel="Cancel task"
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
